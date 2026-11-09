"""Run one pipeline job described by a JSON file, reporting to R2 under runs/<name>/.

{"type": "render", "name": "render-test-1", "angle": 0, "centers": [[44.4759, -73.2121]], "n": 2, "size": 1024}
"""
import json, os, random, subprocess, sys, time, traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import geo, r2  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
JOB_START = time.time()
ACTIVE_LABELS = set()


def frames_around(angle, lat, lon, n, size, h=35.0):
    e, nn, u = geo.lla_to_enu(lat, lon, h)
    x, y = geo.enu_to_px(angle, float(e), float(nn), float(u))
    x0 = int(round((x - n * size / 2) / geo.FRAME)) * geo.FRAME
    y0 = int(round((y - n * size / 2) / geo.FRAME)) * geo.FRAME
    return [[x0 + i * size, y0 + j * size] for j in range(n) for i in range(n)]


def run_render(job, out, log):
    frames = []
    for lat, lon in job["centers"]:
        frames += frames_around(job["angle"], lat, lon, job.get("n", 2), job.get("size", 1024))
    (out / "frames.json").write_text(json.dumps(frames))
    cmd = ["node", "pipeline/render/render.mjs", "--angle", str(job["angle"]), "--frames", str(out / "frames.json"),
           "--out", str(out / "frames"), "--size", str(job.get("size", 1024))]
    if job.get("errorTarget"):
        cmd += ["--errorTarget", str(job["errorTarget"])]
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=job.get("timeout", 3 * 3600))
    log.write(p.stdout + p.stderr)
    if p.returncode:
        raise RuntimeError(f"render exited {p.returncode}")
    return {"frames": len(frames), "rendered": len([p for p in (out / "frames").glob("*_*.png") if not p.name.endswith(".h.png")]),
            "empty_share": empty_shares(out / "frames")}


def empty_shares(d):
    """Share of fully transparent pixels per frame: inside the map area it should be ~0."""
    import numpy as np
    from PIL import Image
    res = {}
    for p in sorted(Path(d).glob("*_*.png")):
        if p.name.endswith(".h.png"):
            continue
        a = np.asarray(Image.open(p).getchannel("A"))
        res[p.stem] = round(float((a == 0).mean()), 4)
    return res


def run_teacher_test(job, out, log):
    """Render named spots, redraw each with every (model, look), check every drawing."""
    from concurrent.futures import ThreadPoolExecutor
    from PIL import Image
    import io
    import teacher
    size = 1024
    spots = job["spots"]
    frames = []
    for s in spots:
        e, n, u = geo.lla_to_enu(s["lat"], s["lon"], s.get("h", 5.0))
        s["lake_level"] = teacher.lake_level(float(e), float(n))
        x, y = geo.enu_to_px(job.get("angle", 0), float(e), float(n), float(u))
        s["frame"] = [int(round((x - size / 2) / 64)) * 64, int(round((y - size / 2) / 64)) * 64]
        frames.append(s["frame"])
    (out / "frames.json").write_text(json.dumps(frames))
    p = subprocess.run(["node", "pipeline/render/render.mjs", "--angle", str(job.get("angle", 0)), "--frames", str(out / "frames.json"),
                        "--out", str(out / "renders"), "--size", str(size)], cwd=ROOT, capture_output=True, text=True, timeout=3600)
    log.write(p.stdout + p.stderr)
    tasks = []
    empties = empty_shares(out / "renders")
    for s in spots:
        name = f"{s['frame'][0]}_{s['frame'][1]}"
        if not (out / "renders" / f"{name}.png").exists():
            s["error"] = "render incomplete"; continue
        s["empty"] = empties.get(name)
        if s["empty"] is None or s["empty"] > 0.02:   # never pay to redraw a render with holes
            s["error"] = f"render has holes ({s['empty']})"; continue
        for model in job["models"]:
            for look in job["looks"]:
                tasks.append((s, name, model, look))
    (out / "drawn").mkdir(exist_ok=True)
    usage = []

    def one(t):
        s, name, model, look = t
        rgba = Image.open(out / "renders" / f"{name}.png")
        rgb = Image.new("RGB", rgba.size, (0, 0, 0)); rgb.paste(rgba, mask=rgba.getchannel("A"))
        buf = io.BytesIO(); rgb.save(buf, "PNG")
        try:
            img, u = teacher.call_openai(model, buf.getvalue(), teacher.STYLES[look])
        except Exception as e:  # noqa: BLE001
            return {"spot": s["id"], "model": model, "look": look, "error": str(e)[:300]}
        fn = f"{s['id']}__{model}__{look}.png"
        (out / "drawn" / fn).write_bytes(img)
        hm = teacher.heights(str(out / "renders" / f"{name}.h.png"))
        chk = teacher.check(rgb, Image.open(io.BytesIO(img)), hm, s["lake_level"])
        usage.append(u)
        return {"spot": s["id"], "model": model, "look": look, "file": fn, "check": chk, "usage": u}

    with ThreadPoolExecutor(4) as ex:
        results = list(ex.map(one, tasks))
    (out / "results.json").write_text(json.dumps({"spots": spots, "results": results}, indent=1))
    ok = sum(1 for r in results if r.get("check", {}).get("pass"))
    return {"calls": len(tasks), "drawn": sum(1 for r in results if "file" in r), "passed_checks": ok,
            "errors": [r["error"] for r in results if "error" in r][:5]}


def run_probe(job, out, log):
    import requests
    res = {}
    # OpenAI: which image models this key can use (no image is generated, no cost)
    r = requests.get("https://api.openai.com/v1/models", headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"}, timeout=30)
    res["openai_status"] = r.status_code
    if r.ok:
        res["openai_image_models"] = sorted(m["id"] for m in r.json()["data"] if "image" in m["id"] or "dall" in m["id"])
    else:
        res["openai_error"] = r.text[:300]
    # Vast.ai: balance and current H100 offers (read only)
    vh = {"Authorization": f"Bearer {os.environ['VAST_API_KEY']}"}
    u = requests.get("https://console.vast.ai/api/v0/users/current/", headers=vh, timeout=30)
    res["vast_status"] = u.status_code
    if u.ok:
        res["vast_credit"] = u.json().get("credit")
    q = {"gpu_name": {"in": ["H100 SXM", "H100 PCIE", "H100 NVL"]}, "rentable": {"eq": True}, "verified": {"eq": True},
         "num_gpus": {"eq": 1}, "reliability2": {"gte": 0.98}, "disk_space": {"gte": 150}, "inet_down": {"gte": 500},
         "order": [["dph_total", "asc"]], "type": "on-demand", "limit": 15}
    o = requests.post("https://console.vast.ai/api/v0/bundles/", headers=vh, json=q, timeout=30)
    if o.ok:
        res["vast_h100_offers"] = [{k: x.get(k) for k in ("id", "gpu_name", "dph_total", "reliability2", "inet_down", "geolocation", "cuda_max_good", "disk_space")} for x in o.json().get("offers", [])]
    else:
        res["vast_offers_error"] = o.text[:300]
    # Cesium: does the token reach the Google tiles asset?
    c = requests.get("https://api.cesium.com/v1/assets/2275207/endpoint", params={"access_token": os.environ["CESIUM_ION_TOKEN"]}, timeout=30)
    res["cesium_status"] = c.status_code
    res["cesium_type"] = c.json().get("externalType") if c.ok else c.text[:200]
    log.write(json.dumps(res, indent=1))
    return res


def run_teacher_set(job, out, log):
    """Render sampled frames for one angle and redraw each with the chosen teacher, up to
    `tries` attempts, until a drawing passes every check. Passing pairs go to R2 train/<set>/."""
    from concurrent.futures import ThreadPoolExecutor
    from PIL import Image
    import io, threading
    import numpy as np
    import sample, teacher
    a, size = job["angle"], 1024
    fr = sample.frames(a, job["frames"], seed=job.get("seed", 1))
    (out / "frames.json").write_text(json.dumps(fr))
    p = subprocess.run(["node", "pipeline/render/render.mjs", "--angle", str(a), "--frames", str(out / "frames.json"),
                        "--out", str(out / "renders"), "--size", str(size)], cwd=ROOT, capture_output=True, text=True, timeout=4 * 3600)
    log.write(p.stdout + p.stderr); log.flush()
    empties = empty_shares(out / "renders")
    lock = threading.Lock()
    calls = {"n": 0}
    max_calls = job["max_calls"]
    water_heavy = {"n": 0}
    items = []
    for i, (x, y) in enumerate(fr):
        name = f"{x}_{y}"
        if empties.get(name) is None or empties[name] > 0.02:
            items.append({"id": name, "skip": "render incomplete or has holes"}); continue
        # where is this frame on the ground? (centre pixel at lake level is close enough for the curvature term)
        cx, cy = x + size / 2, y + size / 2
        import math
        el = math.radians(geo.ELEV_DEG); h = math.radians(geo.HEADINGS[a])
        r_ = cx * geo.PIXEL_M; f_ = -cy * geo.PIXEL_M / math.sin(el)
        e = r_ * math.cos(h) + f_ * math.sin(h); n = -r_ * math.sin(h) + f_ * math.cos(h)
        level = teacher.lake_level(e, n)
        hm = teacher.heights(str(out / "renders" / f"{name}.h.png"))
        wm = teacher.water_mask(hm, level)
        ws = float(wm.mean()) if wm is not None else 0.0
        if ws > 0.85:
            if water_heavy["n"] >= max(2, job["frames"] // 15):
                items.append({"id": name, "skip": "open water (enough already)"}); continue
            water_heavy["n"] += 1
        items.append({"id": name, "level": level, "water": round(ws, 3), "split": "val" if i % 20 == 19 else "train"})
    (out / "pairs").mkdir(exist_ok=True)
    name = job["name"]
    stop_at = JOB_START + job.get("stop_minutes", 315) * 60     # well inside the 355-minute GitHub timeout
    state = {"inflight": 0, "stop": None}                        # stop: reason every remaining item is skipped
    manifest = {"angle": a, "model": job["model"], "look": job["look"], "calls": 0, "items": items, "partial": True}

    def save_manifest():
        # items are only ever replaced whole, under the lock, so this snapshot is consistent;
        # the training box reads only ok items, so a partial manifest is always usable
        with lock:
            manifest["calls"] = calls["n"]
            body = json.dumps(manifest, indent=1)
        (out / "manifest.json").write_text(body)
        for i in range(3):
            try:
                r2.put_bytes(f"runs/{name}/manifest.json", body.encode(), "application/json"); return
            except Exception as e:  # noqa: BLE001
                log.write(f"manifest upload failed: {e}\n"); log.flush(); time.sleep(5 * (i + 1))

    def keep(path, data):
        path.write_bytes(data)
        for i in range(4):
            try:
                r2.put_bytes(f"runs/{name}/pairs/{path.name}", data, "image/png"); return True
            except Exception as e:  # noqa: BLE001
                log.write(f"upload {path.name} failed: {e}\n"); log.flush(); time.sleep(5 * (i + 1))
        return False

    def take_call():
        """Reserve one billed call, or return why not. Waits while in-flight calls may still be refused."""
        while True:
            with lock:
                if state["stop"]:
                    return state["stop"]
                if time.time() > stop_at:
                    return "out of time"
                if calls["n"] < max_calls:
                    calls["n"] += 1; state["inflight"] += 1
                    return None
                if state["inflight"] == 0:
                    return "call cap reached"
            time.sleep(2)

    def draw(it):
        if "skip" in it:
            return it
        it = dict(it, attempts=[])
        rgba = Image.open(out / "renders" / f"{it['id']}.png")
        rgb = Image.new("RGB", rgba.size, (0, 0, 0)); rgb.paste(rgba, mask=rgba.getchannel("A"))
        buf = io.BytesIO(); rgb.save(buf, "PNG")
        hm = teacher.heights(str(out / "renders" / f"{it['id']}.h.png"))
        billed, refused = 0, 0
        while billed < job.get("tries", 3) and refused < 6:
            why = take_call()
            if why:
                it["skip"] = why; return it
            try:
                img, _ = teacher.call_openai(job["model"], buf.getvalue(), teacher.STYLES[job["look"]], deadline=stop_at)
            except teacher.NotBilled as e:
                with lock:
                    calls["n"] -= 1; state["inflight"] -= 1     # refused before any work: costs nothing
                    if isinstance(e, teacher.OutOfQuota):
                        state["stop"] = "OpenAI credit ran out"
                it["attempts"].append({"error": str(e)[:200], "billed": False}); refused += 1; continue
            except Exception as e:  # noqa: BLE001
                with lock:
                    state["inflight"] -= 1
                it["attempts"].append({"error": str(e)[:200]}); billed += 1; continue
            with lock:
                state["inflight"] -= 1
            billed += 1
            try:
                chk = teacher.check(rgb, Image.open(io.BytesIO(img)), hm, it["level"])
            except Exception as e:  # noqa: BLE001  (unreadable image)
                it["attempts"].append({"error": f"check: {e}"[:200]}); continue
            it["attempts"].append(chk)
            if chk["pass"]:
                b = io.BytesIO(); rgb.save(b, "PNG")
                if keep(out / "pairs" / f"{it['id']}.render.png", b.getvalue()) and keep(out / "pairs" / f"{it['id']}.target.png", img):
                    it["ok"] = True
                else:
                    it["skip"] = "upload failed"
                return it
            (out / "pairs" / f"{it['id']}.reject{billed - 1}.png").write_bytes(img)
        if refused >= 6:
            it["skip"] = "refused by OpenAI"
        return it

    def one(idx):
        try:
            res = draw(items[idx])
        except Exception as e:  # noqa: BLE001
            res = dict(items[idx], skip=f"error: {e}"[:200])
        with lock:
            items[idx] = res
        if res.get("ok"):
            save_manifest()

    with ThreadPoolExecutor(job.get("threads", 2)) as ex:
        list(ex.map(one, range(len(items))))
    manifest["partial"] = False
    save_manifest()
    ok = [i for i in items if i.get("ok")]
    return {"frames": len(fr), "pairs": len(ok), "val": sum(1 for i in ok if i["split"] == "val"),
            "calls": calls["n"], "calls_per_pair": round(calls["n"] / max(1, len(ok)), 2),
            "errors": sum(1 for i in items for t in i.get("attempts", []) if "error" in t),
            "skipped": {k: sum(1 for i in items if i.get("skip") == k) for k in {i.get("skip") for i in items if i.get("skip")}}}


def run_render_blocks(job, out, log):
    """Render every 4096 px block in this shard (16 frames each), assemble the colour and height
    blocks and upload them to R2 renders/a<angle>/. Blocks already in R2 are skipped."""
    import numpy as np
    from PIL import Image
    a, shard, nsh = job["angle"], job["shard"], job["shards"]
    g = json.loads((ROOT / "data/grid.json").read_text())["angles"][a]
    blocks = g["blocks"][shard::nsh]
    B, F = geo.BLOCK, geo.FRAME
    done, failed = 0, []
    for bx, by in blocks:
        key = f"renders/a{a}/{bx}_{by}.png"
        try:
            r2.client().head_object(Bucket=r2.BUCKET, Key=key); done += 1; continue
        except Exception:  # noqa: BLE001
            pass
        fr = [[bx + i * F, by + j * F] for j in range(B // F) for i in range(B // F)]
        d = out / f"b{bx}_{by}"; d.mkdir(parents=True, exist_ok=True)
        (d / "frames.json").write_text(json.dumps(fr))
        # Cesium ion answers 429 when many runners open sessions at once; render.mjs keeps finished
        # frames, so a retry after a pause only redraws what is missing.
        for attempt in range(4):
            if attempt:
                time.sleep(60 * attempt + random.uniform(0, 30))
            p = subprocess.run(["node", "pipeline/render/render.mjs", "--angle", str(a), "--frames", str(d / "frames.json"),
                                "--out", str(d), "--size", str(F)], cwd=ROOT, capture_output=True, text=True, timeout=3600)
            log.write(f"block {bx},{by} try {attempt + 1}:\n" + p.stdout[-2000:] + p.stderr[-2000:]); log.flush()
            if all((d / f"{x}_{y}.png").exists() for x, y in fr):
                break
        if any(not (d / f"{x}_{y}.png").exists() for x, y in fr):
            failed.append([bx, by]); continue
        rgb = Image.new("RGBA", (B, B)); hgt = Image.new("RGBA", (B, B))
        for x, y in fr:
            rgb.paste(Image.open(d / f"{x}_{y}.png"), (x - bx, y - by))
            hgt.paste(Image.open(d / f"{x}_{y}.h.png"), (x - bx, y - by))
        rgb.save(d / "block.png", optimize=False); hgt.save(d / "block.h.png")
        r2.client().upload_file(str(d / "block.png"), r2.BUCKET, key, ExtraArgs={"ContentType": "image/png"})
        r2.client().upload_file(str(d / "block.h.png"), r2.BUCKET, f"renders/a{a}/{bx}_{by}.h.png", ExtraArgs={"ContentType": "image/png"})
        subprocess.run(["rm", "-rf", str(d)])
        done += 1
    if failed:
        raise RuntimeError(f"{len(failed)} blocks had frames that never fully loaded: {failed}")
    return {"blocks": len(blocks), "done": done}


CAPTION = ("Redraw this exact image as a finished isometric city illustration in the Burlington city-builder style: "
           "flat colour, crisp dark outlines, tidy textures, bright clear daylight. Keep everything exactly in place.")
AITK_COMMIT = "beb9482"


def train_yaml(name, steps, rank, val_ids):
    if not val_ids:
        raise RuntimeError("no validation frames: ai-toolkit needs at least one sample image")
    samples = "\n".join(f'          - prompt: "{CAPTION}"\n            ctrl_img: "/root/data/val/{v}.png"' for v in val_ids)
    return f"""job: extension
config:
  name: "{name}"
  process:
    - type: diffusion_trainer
      training_folder: /root/output
      device: cuda:0
      network: {{type: lora, linear: {rank}, linear_alpha: {rank}}}
      save: {{dtype: bf16, save_every: 500, max_step_saves_to_keep: 12}}
      datasets:
        - folder_path: /root/data/target
          control_path: /root/data/control
          caption_ext: txt
          caption_dropout_rate: 0.0
          resolution: [1024]
      train:
        batch_size: 1
        steps: {steps}
        gradient_accumulation: 1
        train_unet: true
        train_text_encoder: false
        gradient_checkpointing: true
        noise_scheduler: flowmatch
        timestep_type: shift
        optimizer: adamw8bit
        lr: 1e-4
        dtype: bf16
        cache_text_embeddings: true
      model:
        arch: qwen_image_2
        name_or_path: Comfy-Org/Qwen-Image-2.1/diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors
        quantize: true
        qtype: convrot8
        quantize_te: true
        qtype_te: convrot8
        assistant_lora_path: ostris/qwen_image_2_turbo_training_adapter/qwen_image_2_turbo_training_adapter_v1.safetensors
        model_kwargs: {{turbo: true}}
      sample:
        sampler: flowmatch
        sample_every: 500
        width: 1024
        height: 1024
        samples:
{samples}
        seed: 7
        walk_seed: false
        guidance_scale: 1.0
        sample_steps: 8
meta: {{name: "{name}", version: "1"}}
"""


# how long a machine may sit in each state before we give up on it (minutes)
STALL = {"starting": 25, "booted": 15, "downloading data": 30, "training": None}


def run_train(job, out, log):
    """Rent one H100 on Vast.ai, train the LoRA there, always delete the machine."""
    import base64, secrets
    import vast
    name = job["name"]
    man = [json.loads(r2.get_bytes(f"{p}/manifest.json")) for p in job["pairs"]]
    val = [f"a{m['angle']}_{it['id']}" for m in man for it in m["items"] if it.get("ok") and it["split"] == "val"]
    val_ids = val[::max(1, len(val) // 4)][:4]
    yaml = train_yaml(name, job.get("steps", 3000), job.get("rank", 32), val_ids)
    (out / "train.yaml").write_text(yaml)
    credit = vast.credit()
    max_hours = job.get("max_hours", 3.5)
    cutoff = JOB_START + 330 * 60          # stay well inside the 355-minute GitHub timeout
    log.write(f"vast credit ${credit}\n"); log.flush()
    sha = os.environ.get("GITHUB_SHA", "main")

    def say(msg):
        log.write(msg + "\n"); log.flush(); print(msg, flush=True)

    tried, spent, result = [], 0.0, None
    for attempt in range(job.get("max_machines", 2)):
        offs = [o for o in vast.offers(job.get("max_dph", 3.2)) if o["id"] not in tried]
        if not offs:
            raise RuntimeError("no H100 offers under the price cap")
        o = offs[0]; tried.append(o["id"])
        deadline = int(min(time.time() + max_hours * 3600, cutoff))
        if credit - spent < o["dph_total"] * (deadline - time.time()) / 3600:
            raise RuntimeError(f"not enough Vast credit for this run at ${o['dph_total']:.2f}/h")
        token = secrets.token_hex(6)
        label = f"iso-{name}-dl{deadline}"
        onstart = ("rm -rf /root/iso && cd /root && git clone -q https://github.com/morganholland/isometric-burlington iso && "
                   f"cd iso && git checkout -q {sha} && cp pipeline/remote/sync.py /root/sync.py && "
                   'echo "$TRAIN_YAML_B64" | base64 -d > /root/train.yaml && echo "$CAPTION_B64" | base64 -d > /root/caption.txt && '
                   "nohup bash pipeline/remote/train.sh > /root/onstart.log 2>&1 &")
        env = {"RUN": name, "ATTEMPT": token, "PAIRS": ",".join(job["pairs"]), "AITK_OUTPUT": "/root/output",
               "TRAIN_YAML_B64": base64.b64encode(yaml.encode()).decode(),
               "CAPTION_B64": base64.b64encode(CAPTION.encode()).decode(),
               "R2_ENDPOINT": os.environ["R2_ENDPOINT"], "R2_ACCESS_KEY_ID": os.environ["R2_ACCESS_KEY_ID"],
               "R2_SECRET_ACCESS_KEY": os.environ["R2_SECRET_ACCESS_KEY"]}
        t0 = time.time()
        iid = None
        state, since, reached_running = "starting", time.time(), False
        try:
            try:
                iid = vast.create(o["id"], label, onstart, env)
            except Exception as e:  # noqa: BLE001  the machine may exist even though the call failed
                say(f"create failed ({e}); cleaning up anything labelled {label}")
                time.sleep(30)
                vast.destroy_labelled(label=label)
                continue
            ACTIVE_LABELS.add(label)
            say(f"machine {iid} on offer {o['id']} ({o['gpu_name']}, ${o['dph_total']:.2f}/h, {o.get('geolocation')}), attempt {token}")
            while time.time() < deadline:
                time.sleep(60)
                try:
                    box = json.loads(r2.get_bytes(f"runs/{name}/box.json"))
                except Exception:  # noqa: BLE001
                    box = {}
                if not reached_running:
                    try:
                        inst = vast.instance(iid) or {}
                        reached_running = inst.get("actual_status") == "running"
                    except Exception:  # noqa: BLE001
                        pass
                if box.get("attempt") == token and box.get("state") != state:
                    state, since = box.get("state"), time.time()
                    say(f"{int((time.time()-t0)/60)} min: {state} {box.get('detail','')}")
                    try:
                        r2.put_json(f"runs/{name}/status.json", {"name": name, "type": "train", "state": "running", "box": state,
                                                                 "machine": iid, "dph": o["dph_total"], "minutes": round((time.time()-t0)/60, 1)})
                    except Exception as e:  # noqa: BLE001
                        say(f"status write failed: {e}")
                if state in ("done", "failed", "refused"):
                    break
                limit = STALL.get(state, 30)
                if limit and time.time() - since > limit * 60:
                    say(f"stalled in '{state}' for {limit} min"); state = f"stalled:{state}"; break
            else:
                state = f"deadline:{state}"
        finally:
            if iid is not None:
                ok = vast.destroy(iid)
                if not ok:
                    ok = vast.destroy_labelled(label=label) > 0
                hours = (time.time() - t0) / 3600
                spent += hours * o["dph_total"]
                say(f"machine {iid} {'deleted' if ok else 'NOT CONFIRMED DELETED (reaper will retry)'} after {hours*60:.0f} min, ~${hours*o['dph_total']:.2f}")
                if ok:
                    ACTIVE_LABELS.discard(label)
        # a machine that never ran is a host problem: try another. Anything else would fail again: stop.
        if state in ("refused",) or (state == "stalled:starting" and not reached_running):
            continue
        result = state
        break
    if result != "done":
        raise RuntimeError(f"training ended: {result}; Vast spend ~${spent:.2f}")
    return {"state": result, "vast_spent_estimate": round(spent, 2), "val": val_ids}


def main(path):
    job = json.loads(Path(path).read_text())
    name = job["name"]
    out = ROOT / "runs" / name
    out.mkdir(parents=True, exist_ok=True)
    status = {"name": name, "type": job["type"], "started": time.time(), "state": "running",
              "commit": os.environ.get("GITHUB_SHA"), "run": os.environ.get("GITHUB_RUN_ID")}
    r2.put_json(f"runs/{name}/status.json", status)
    log = open(out / "log.txt", "w")
    try:
        result = {"render": run_render, "probe": run_probe, "teacher_test": run_teacher_test, "teacher_set": run_teacher_set, "train": run_train, "render_blocks": run_render_blocks}[job["type"]](job, out, log)
        status.update(state="done", result=result)
    except Exception:
        status.update(state="failed", error=traceback.format_exc()[-3000:])
    finally:
        log.close()
        status["finished"] = time.time()
        status["minutes"] = round((status["finished"] - status["started"]) / 60, 1)
        if job["type"] == "render_blocks":
            n = 0; r2.put_bytes(f"runs/{name}/log.txt", (out / "log.txt").read_bytes(), "text/plain")
        else:
            n = r2.put_dir(out, f"runs/{name}")
        status["files"] = n
        r2.put_json(f"runs/{name}/status.json", status)
        print(json.dumps({k: v for k, v in status.items() if k != "error"}), status.get("error", ""))
    if status["state"] != "done":
        sys.exit(1)


def _on_term(*_):
    # GitHub cancels or times out a job with SIGINT/SIGTERM: delete our machines before dying
    try:
        import vast
        for lb in list(ACTIVE_LABELS):
            vast.destroy_labelled(label=lb)
    finally:
        sys.exit(143)


if __name__ == "__main__":
    import signal
    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)
    main(sys.argv[1])
