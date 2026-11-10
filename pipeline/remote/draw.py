"""Runs ON the rented GPU: draw blocks of one angle with the trained LoRA, joint-sampled.

python3 draw.py --angle 0 --lora /root/lora.safetensors [--blocks bx_by,...] [--limit N]
Reads render blocks from R2 renders/a<angle>/, writes drawn blocks to R2 drawn/<RUN>/a<angle>/ and
the clean latents to R2 latents/<RUN>/a<angle>/ (so a run can resume and neighbours can pin).
"""
import argparse, io, json, os, sys, time
from pathlib import Path

import numpy as np
import torch
import boto3
from PIL import Image

sys.path.insert(0, os.environ.get("AITK", "/app/ai-toolkit"))
sys.path.insert(0, str(Path(__file__).parent))
import sampler as S  # noqa: E402
import water as Wt  # noqa: E402

BUCKET = "iso-burlington"
CAPTION = open("/root/caption.txt").read().strip() if os.path.exists("/root/caption.txt") else ""
BLOCK, LAT = 4096, 16
MARGIN = 16      # latent cells of neighbour context on each side (256 px)
SEED = 20261109
STRIDE = int(os.environ.get("STRIDE", 48))
assert 16 <= STRIDE <= 56 and STRIDE % 8 == 0, "stride must leave windows overlapping"

s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                  aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")


def box(state, detail=""):
    """Progress for the GitHub side, which deletes the machine on done/failed and on a stall."""
    body = json.dumps({"state": state, "detail": detail, "attempt": os.environ.get("ATTEMPT", ""), "t": time.time()}).encode()
    for i in range(5):
        try:
            s3.put_object(Bucket=BUCKET, Key=f"runs/{os.environ['RUN']}/box.json", Body=body, ContentType="application/json"); return
        except Exception as e:  # noqa: BLE001
            print("box write failed", e); time.sleep(3 * (i + 1))


def r2_get(key):
    try:
        return s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
    except s3.exceptions.NoSuchKey:
        return None
    except Exception as e:  # noqa: BLE001
        if "NoSuchKey" in str(e) or "404" in str(e):
            return None
        raise


def load_model(lora_path):
    from toolkit.config_modules import ModelConfig, NetworkConfig
    from toolkit.lora_special import LoRASpecialNetwork
    from safetensors.torch import load_file
    from extensions_built_in.diffusion_models.qwen_image_2 import QwenImage2Model
    # ModelConfig's dtype defaults to float16, which would leave the VAE in fp16 while reference images are
    # encoded in bf16 (encode_condition_images uses the model dtype). Training ran everything in bf16.
    cfg = ModelConfig(arch="qwen_image_2", quantize=True, qtype="convrot8", quantize_te=True, qtype_te="convrot8", model_kwargs={"turbo": True},
                      dtype="bf16", vae_dtype="bf16", te_dtype="bf16",
                      name_or_path="Comfy-Org/Qwen-Image-2.1/diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors")
    model = QwenImage2Model(device="cuda:0", model_config=cfg, dtype="bf16")
    model.load_model()
    model.vae.to(model.device_torch, dtype=model.torch_dtype)
    model.vae_torch_dtype = model.torch_dtype
    vd = next(model.vae.parameters()).dtype
    assert vd == model.torch_dtype, f"VAE is {vd}, model is {model.torch_dtype}"
    sd = load_file(lora_path)
    dim = int(sd[next(k for k in sd if k.endswith("lora_A.weight") or k.endswith("lora_down.weight"))].shape[0])
    sd = {k.replace("diffusion_model.", "transformer."): v for k, v in sd.items()}
    nc = NetworkConfig(type="lora", linear=dim, linear_alpha=dim, transformer_only=True)
    LoRASpecialNetwork.LORA_PREFIX_UNET = "lora_transformer"
    net = LoRASpecialNetwork(text_encoder=None, unet=model.model, lora_dim=dim, multiplier=1.0, alpha=dim,
                             train_unet=True, train_text_encoder=False, network_config=nc, network_type="lora",
                             transformer_only=True, is_transformer=True, target_lin_modules=model.target_lora_modules,
                             base_model=model)
    net.apply_to(None, model.model, apply_text_encoder=False, apply_unet=True)
    net.force_to(model.device_torch, dtype=model.torch_dtype)
    net.eval(); net.requires_grad_(False)
    net._update_torch_multiplier()
    missing = net.load_weights(sd)
    if missing:   # keys that matched nothing: we would be drawing with the plain model
        raise RuntimeError(f"LoRA did not load cleanly: {str(missing)[:500]}")
    net.multiplier = 1.0; net.is_active = True
    # LoRA modules hold only a weakref to their network: keep it alive for as long as the model is
    model.network = net
    print("LoRA loaded, rank", dim)
    return model


def to_tensor(img):
    a = torch.from_numpy(np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0).permute(2, 0, 1)[None]
    return a


class WindowModel:
    """Per-window conditioning is cached for the whole block (8 steps reuse it)."""

    def __init__(self, model, render_canvas):
        self.m = model
        self.render = render_canvas          # PIL RGB, canvas size in pixels
        self.cache = {}
        self.dev = model.device_torch
        self.dtype = model.torch_dtype

    def cond(self, pos):
        if pos not in self.cache:
            y, x = pos
            crop = self.render.crop((x * LAT, y * LAT, (x + S.WIN) * LAT, (y + S.WIN) * LAT))
            t = to_tensor(crop).to(self.dev)
            size = (S.WIN * LAT, S.WIN * LAT)
            with torch.no_grad():
                pe = self.m.get_prompt_embeds(CAPTION, control_images=[[t]], target_size=size)
                cond = self.m.pad_prompt_embeds(pe)
                # the same resize the prompt encoder applied, so slot and token counts agree
                prepared = self.m._prepare_control_images(self.m._normalize_control_images([[t]], 1),
                                                          target_pixels=self.m._target_pixels(size))
                cl, cs = self.m.encode_condition_images(prepared)
            self.cache[pos] = (cond, cl, cs)
        return self.cache[pos]

    @torch.no_grad()
    def __call__(self, xw, sigma, pos):
        from extensions_built_in.diffusion_models.qwen_image_2.src.pipeline import run_transformer
        cond, cl, cs = self.cond(pos)
        t = torch.full((1,), float(sigma), device=self.dev, dtype=self.dtype)
        v = run_transformer(self.m.model, xw[None].to(self.dev, self.dtype), t, *cond,
                            condition_latents=cl, condition_shapes=cs)
        return v[0].float()


def render_canvas(angle, bx, by, have, suffix=".png", mode="RGB"):
    """Block render plus a MARGIN of neighbouring renders (black / clear where no neighbour block exists)."""
    m = MARGIN * LAT
    canvas = Image.new(mode, (BLOCK + 2 * m, BLOCK + 2 * m))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            nb = (bx + dx * BLOCK, by + dy * BLOCK)
            if nb not in have:
                continue
            raw = r2_get(f"renders/a{angle}/{nb[0]}_{nb[1]}{suffix}")
            if raw is None:
                continue
            im = Image.open(io.BytesIO(raw)).convert(mode)
            # paste so that canvas (0,0) = (bx - m, by - m)
            canvas.paste(im, (nb[0] - bx + m, nb[1] - by + m))
    return canvas


def water_pin(model, angle, bx, by, have, canvas):
    """Open lake cells pinned to the recoloured render (see water.py). Returns (clean, weight) or None."""
    H = W = BLOCK // LAT + 2 * MARGIN
    hpng = np.asarray(render_canvas(angle, bx, by, have, ".h.png", "RGBA"))
    level = Wt.lake_level_cells(angle, bx - MARGIN * LAT, by - MARGIN * LAT, H, W)
    h = Wt.heights_from_png(hpng)
    wpx = Wt.water_pixels(h, level)
    weight, fill = Wt.plan(wpx, np.isnan(h), Wt.lake_band(h, level))
    if float(weight.max()) <= 0:
        return None
    img = Wt.recolour(np.asarray(canvas), wpx, fill)
    dev, dt = model.device_torch, model.torch_dtype

    def enc(t):
        """encode_images with the posterior mode, not a sample: the same water encodes the same in every block."""
        with torch.no_grad():
            x = (t.to(dev, dt) * 2 - 1)[None]
            x = torch.cat([x, torch.ones_like(x[:, :1])], dim=1).unsqueeze(2)     # opaque alpha, frame dim
            lat = model.vae.encode(x).latent_dist.mode()
            mean, std = model._latent_stats(lat.device, lat.dtype)
            return ((lat - mean) / std).squeeze(2)[0]
    clean = Wt.encode_tiles(enc, img, weight)
    return clean.to(dev), weight.to(dev)


def neighbour_latents(run, angle, bx, by, C, dev):
    H = W = BLOCK // LAT + 2 * MARGIN
    m = MARGIN
    clean = torch.zeros(C, H, W, device=dev)
    done = {}
    dirs = {"nw": (-1, -1), "n": (0, -1), "ne": (1, -1), "w": (-1, 0), "e": (1, 0), "sw": (-1, 1), "s": (0, 1), "se": (1, 1)}
    bl = BLOCK // LAT
    for d, (dx, dy) in dirs.items():
        raw = r2_get(f"latents/{run}/a{angle}/{bx + dx * BLOCK}_{by + dy * BLOCK}.pt")
        done[d] = raw is not None
        if raw is None:
            continue
        lat = torch.load(io.BytesIO(raw), map_location=dev).float()   # (C, bl, bl)
        # neighbour's cells that fall inside our canvas
        ys = slice(bl - m, bl) if dy == -1 else (slice(0, m) if dy == 1 else slice(0, bl))
        xs = slice(bl - m, bl) if dx == -1 else (slice(0, m) if dx == 1 else slice(0, bl))
        cy = slice(0, m) if dy == -1 else (slice(H - m, H) if dy == 1 else slice(m, H - m))
        cx = slice(0, m) if dx == -1 else (slice(W - m, W) if dx == 1 else slice(m, W - m))
        clean[:, cy, cx] = lat[:, ys, xs]
    return clean, done


def draw_block(model, run, angle, bx, by, have):
    t0 = time.time()
    if r2_get(f"renders/a{angle}/{bx}_{by}.png") is None:
        # never draw (and pin neighbours to) a block from black
        raise RuntimeError(f"render block a{angle} {bx},{by} is missing; render it first")
    dev = model.device_torch
    C = model.model.config.in_channels
    H = W = BLOCK // LAT + 2 * MARGIN
    canvas = render_canvas(angle, bx, by, have)
    clean, done = neighbour_latents(run, angle, bx, by, C, dev)
    pw = S.pin_map(H, W, MARGIN, done, strip=8, device=dev)
    wp = water_pin(model, angle, bx, by, have, canvas)
    water_share = 0.0
    if wp is not None:
        wclean, ww = wp
        # a finished neighbour stays the target wherever it is pinned (its latents already hold its own water)
        clean = torch.where((pw > 0)[None], clean, wclean)
        pw = torch.maximum(pw, ww)
        water_share = round(float((ww[MARGIN:H - MARGIN, MARGIN:W - MARGIN] >= 0.999).float().mean()), 3)
    y0, x0 = by // LAT - MARGIN, bx // LAT - MARGIN
    noise = S.global_noise(C, y0, x0, H, W, SEED + angle, dev)
    wm = WindowModel(model, canvas)
    x, evals = S.sample_canvas(wm, noise, clean, pw, stride=STRIDE, shift=STRIDE // 2)
    block_lat = x[:, MARGIN:H - MARGIN, MARGIN:W - MARGIN].contiguous()
    # decode the block with a little latent context on each side, then crop, so the VAE sees its edges
    ctx = 4
    dec = x[:, MARGIN - ctx:H - MARGIN + ctx, MARGIN - ctx:W - MARGIN + ctx]
    with torch.no_grad():
        img = model.decode_to_images(dec[None].to(dev, model.torch_dtype))[0]
    img = img.crop((ctx * LAT, ctx * LAT, ctx * LAT + BLOCK, ctx * LAT + BLOCK))
    buf = io.BytesIO(); img.save(buf, "PNG")
    s3.put_object(Bucket=BUCKET, Key=f"drawn/{run}/a{angle}/{bx}_{by}.png", Body=buf.getvalue(), ContentType="image/png")
    lb = io.BytesIO(); torch.save(block_lat.to(torch.float16).cpu(), lb)
    s3.put_object(Bucket=BUCKET, Key=f"latents/{run}/a{angle}/{bx}_{by}.pt", Body=lb.getvalue())
    return {"block": [bx, by], "evals": evals, "seconds": round(time.time() - t0, 1), "pinned": [d for d, v in done.items() if v], "water": water_share}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--angles", required=True)
    ap.add_argument("--lora", required=True)
    ap.add_argument("--blocks", default="")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    run = os.environ.get("DRAW_RUN") or os.environ["RUN"]
    grids = json.load(open("/root/iso/data/grid.json"))["angles"]
    box("loading model")
    model = load_model(a.lora)
    n = 0
    for angle in [int(x) for x in a.angles.split(",")]:
        grid = grids[angle]
        have = {tuple(b) for b in grid["blocks"]}
        order = sorted(grid["blocks"], key=lambda b: (b[1], b[0]))          # raster: rows top to bottom
        if a.blocks:
            want = {tuple(map(int, s.split("_"))) for s in a.blocks.split(",")}
            order = [b for b in order if tuple(b) in want]
        logkey = f"runs/{os.environ['RUN']}/draw-a{angle}.json"
        log = json.loads(r2_get(logkey) or b"[]")
        for i, (bx, by) in enumerate(order):
            if r2_get(f"latents/{run}/a{angle}/{bx}_{by}.pt") is not None:
                continue
            box("drawing", f"a{angle} block {i + 1}/{len(order)} ({bx},{by})")
            r = draw_block(model, run, angle, bx, by, have)
            log.append(r); n += 1
            print(json.dumps(r), flush=True)
            s3.put_object(Bucket=BUCKET, Key=logkey, Body=json.dumps(log).encode(), ContentType="application/json")
            if a.limit and n >= a.limit:
                return
    box("drawing", f"all {n} blocks drawn")


if __name__ == "__main__":
    main()
