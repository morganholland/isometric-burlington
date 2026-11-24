"""Stage 1 high-resolution trial runner: 2x sharper renders, direct OpenAI 2K vs 4K comparison,
style-reference consistency, and minimum-error seam-cut stitching.

Writes WebP assets, results.json, and an interactive drag-to-compare review.html into `out`,
which pipeline/job.py uploads to public R2 under runs/<name>/.
"""
from io import BytesIO
import html as html_lib
import json
import math
import subprocess
import time
from pathlib import Path
from PIL import Image

import geo
import r2
import seam
import teacher

ROOT = Path(__file__).resolve().parent.parent
TILE_T = 512


def _fetch_live_crop(angle, x0_cur, y0_cur, w_cur, h_cur, target_size):
    """Stitch today's live level-0 map tiles from R2 covering [x0_cur, x0_cur+w_cur) x [y0_cur, y0_cur+h_cur)."""
    tx0 = math.floor(x0_cur / TILE_T)
    tx1 = math.floor((x0_cur + w_cur - 1) / TILE_T)
    ty0 = math.floor(y0_cur / TILE_T)
    ty1 = math.floor((y0_cur + h_cur - 1) / TILE_T)
    canvas = Image.new("RGB", ((tx1 - tx0 + 1) * TILE_T, (ty1 - ty0 + 1) * TILE_T), (243, 245, 244))
    got_any = False
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            key = f"map-v1/a{angle}/0/{tx}/{ty}.webp"
            try:
                data = r2.get_bytes(key)
                im = Image.open(BytesIO(data)).convert("RGB")
                canvas.paste(im, ((tx - tx0) * TILE_T, (ty - ty0) * TILE_T))
                got_any = True
            except Exception:
                pass
    if not got_any:
        return None
    ox = int(round(x0_cur - tx0 * TILE_T))
    oy = int(round(y0_cur - ty0 * TILE_T))
    crop = canvas.crop((ox, oy, ox + int(round(w_cur)), oy + int(round(h_cur))))
    return crop.resize(target_size, Image.LANCZOS)


def _save_webp(im, path, max_dim=None, quality=88):
    out = im.convert("RGB")
    if max_dim and max(out.size) > max_dim:
        out = out.copy()
        out.thumbnail((max_dim, max_dim), Image.LANCZOS)
    out.save(path, "WEBP", quality=quality, method=5)
    return out.size


def _png_bytes(im, size=None):
    cur = im.convert("RGB")
    if size and cur.size != size:
        cur = cur.resize(size, Image.LANCZOS)
    buf = BytesIO()
    cur.save(buf, "PNG")
    return buf.getvalue()


def _parse_size(s):
    w, h = s.lower().split("x")
    return int(w), int(h)


def _spot_frame(angle, lat, lon, h, pixel_m, render_size):
    scale = geo.PIXEL_M / pixel_m
    e, n, u = geo.lla_to_enu(lat, lon, h)
    x_base, y_base = geo.enu_to_px(angle, float(e), float(n), float(u))
    x_hi, y_hi = x_base * scale, y_base * scale
    fx = int(round((x_hi - render_size / 2) / 64)) * 64
    fy = int(round((y_hi - render_size / 2) / 64)) * 64
    return [fx, fy], teacher.lake_level(float(e), float(n))


def _render_rgb(path):
    rgba = Image.open(path).convert("RGBA")
    rgb = Image.new("RGB", rgba.size, (0, 0, 0))
    rgb.paste(rgba, mask=rgba.getchannel("A"))
    return rgb


def _empty_share(path):
    import numpy as np
    a = np.asarray(Image.open(path).convert("RGBA").getchannel("A"))
    return round(float((a == 0).mean()), 4)


def build_review_html(summary, spots_data, seam_data):
    """Build a self-contained drag-to-compare review page (all image URLs relative to review.html)."""
    esc = html_lib.escape
    cost_rows = []
    for sz, st in summary["by_size"].items():
        avg = st["usd"] / st["calls"] if st["calls"] else 0.0
        cost_rows.append(
            f"<tr><td><code>{esc(sz)}</code></td><td>{st['calls']}</td>"
            f"<td>${st['usd']:.3f}</td><td><b>${avg:.3f}</b></td>"
            f"<td>${avg * 160:.0f}</td><td>${avg * 330:.0f}</td><td>${avg * 703:.0f}</td></tr>"
        )

    spot_sections = []
    for sp in spots_data:
        if sp.get("error"):
            spot_sections.append(f'<section class="spot"><h2>{esc(sp["label"])}</h2><p class="err">Skipped: {esc(sp["error"])}</p></section>')
            continue
        layers = []
        if sp.get("live_img"):
            layers.append(("live", "Today's map (23 cm/px)", sp["live_img"]))
        layers.append(("render", "Google 3D (11.5 cm/px)", sp["render_img"]))
        for sz in sp["drawn"]:
            d = sp["drawn"][sz]
            if d.get("img"):
                tag = f"{sz.split('x')[0]}px"
                chk = "pass" if d.get("check", {}).get("pass") else ", ".join(d.get("check", {}).get("reasons", ["check"]))
                layers.append((sz, f"New {tag} (${d['usd']:.2f} · {chk})", d["img"]))
        # Default compare: Today's live map (or render) on the left vs largest drawn on the right
        left_id = layers[0][0]
        right_id = layers[-1][0]
        opts_l = "".join(f'<option value="{esc(k)}"{" selected" if k == left_id else ""}>{esc(lbl)}</option>' for k, lbl, _ in layers)
        opts_r = "".join(f'<option value="{esc(k)}"{" selected" if k == right_id else ""}>{esc(lbl)}</option>' for k, lbl, _ in layers)
        img_map = json.dumps({k: src for k, _, src in layers})
        lbl_map = json.dumps({k: lbl for k, lbl, _ in layers})

        # 1:1 crop cards so Morgan can inspect cars/windows side-by-side without squinting
        crop_cards = []
        for k, lbl, _ in layers:
            crop_src = sp.get("crops", {}).get(k)
            if crop_src:
                crop_cards.append(
                    f'<figure class="crop"><img src="{esc(crop_src)}" alt="{esc(sp["label"])} — {esc(lbl)} close-up" loading="lazy">'
                    f'<figcaption>{esc(lbl)}</figcaption></figure>'
                )

        spot_sections.append(f"""
        <section class="spot">
          <h2>{esc(sp["label"])}</h2>
          <div class="compare" data-imgs='{esc(img_map)}' data-lbls='{esc(lbl_map)}'>
            <div class="pickers">
              <label>Left: <select class="pick-l">{opts_l}</select></label>
              <label>Right: <select class="pick-r">{opts_r}</select></label>
            </div>
            <div class="frame" style="--cut:50%">
              <img class="after" src="{esc(dict((k, s) for k, _, s in layers)[right_id])}" alt="{esc(sp["label"])} right comparison">
              <img class="before" src="{esc(dict((k, s) for k, _, s in layers)[left_id])}" alt="{esc(sp["label"])} left comparison">
              <span class="knob" aria-hidden="true">⇔</span>
              <span class="tag left">{esc(dict((k, l) for k, l, _ in layers)[left_id])}</span>
              <span class="tag right">{esc(dict((k, l) for k, l, _ in layers)[right_id])}</span>
              <input type="range" min="0" max="100" value="50" step="1" aria-label="Drag to compare {esc(sp["label"])}">
            </div>
          </div>
          <h3>Zoomed-in 1:1 detail (parked cars, windows, trees)</h3>
          <div class="crops">{"".join(crop_cards)}</div>
        </section>""")

    seam_html = ""
    if seam_data and seam_data.get("seamcut_crop") and seam_data.get("crossfade_crop"):
        s_layers = [
            ("crossfade", "Cross-faded overlap (ghosted)", seam_data["crossfade_crop"]),
            ("seamcut", "Min-error seam cut (14 px)", seam_data["seamcut_crop"]),
        ]
        if seam_data.get("live_crop"):
            s_layers.append(("live", "Today's live map (23 cm/px)", seam_data["live_crop"]))
        img_map = json.dumps({k: src for k, _, src in s_layers})
        lbl_map = json.dumps({k: lbl for k, lbl, _ in s_layers})
        opts_l = "".join(f'<option value="{esc(k)}"{" selected" if k == "crossfade" else ""}>{esc(lbl)}</option>' for k, lbl, _ in s_layers)
        opts_r = "".join(f'<option value="{esc(k)}"{" selected" if k == "seamcut" else ""}>{esc(lbl)}</option>' for k, lbl, _ in s_layers)
        seam_html = f"""
        <section class="spot">
          <h2>Seam-cut proof of concept: {esc(seam_data["label"])}</h2>
          <p class="lede-sm">Four overlapping <code>{esc(seam_data["size"])}</code> tiles stitched together right across the middle seam. Drag to compare naive cross-fading against minimum-error seam cutting (or switch either side to today's live map).</p>
          <div class="compare" data-imgs='{esc(img_map)}' data-lbls='{esc(lbl_map)}'>
            <div class="pickers">
              <label>Left: <select class="pick-l">{opts_l}</select></label>
              <label>Right: <select class="pick-r">{opts_r}</select></label>
            </div>
            <div class="frame" style="--cut:50%">
              <img class="after" src="{esc(seam_data["seamcut_crop"])}" alt="Seam-cut 2x2 stitch close-up">
              <img class="before" src="{esc(seam_data["crossfade_crop"])}" alt="Cross-faded 2x2 stitch close-up">
              <span class="knob" aria-hidden="true">⇔</span>
              <span class="tag left">Cross-faded overlap (ghosted)</span>
              <span class="tag right">Min-error seam cut (14 px)</span>
              <input type="range" min="0" max="100" value="50" step="1" aria-label="Drag to compare cross-fade and seam cut">
            </div>
          </div>
          <figure class="full-stitch">
            <img src="{esc(seam_data["seamcut_full"])}" alt="Full stitched 2x2 downtown patch" loading="lazy">
            <figcaption>Full stitched 2×2 downtown patch ({seam_data["tiles_ok"]} of 4 tiles drawn).</figcaption>
          </figure>
        </section>"""

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>High-Res Trial Review · Isometric Burlington</title>
<style>
  :root{{--bg:#f3f5f4;--ink:#13202a;--muted:#52626d;--line:rgba(19,32,42,.14);--accent:#b8462d;--panel:#fff}}
  body{{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,sans-serif;padding:24px 18px 64px}}
  main{{max-width:960px;margin:0 auto}}
  h1{{font-size:clamp(28px,5vw,40px);margin:0 0 8px;line-height:1.08}}
  h2{{font-size:22px;margin:36px 0 10px}}
  h3{{font-size:15px;color:var(--muted);margin:18px 0 8px;font-weight:600}}
  .eyebrow{{font:600 12px ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 6px}}
  .lede,.lede-sm{{color:var(--muted);margin:0 0 18px}}
  .summary{{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:18px 0 28px;overflow-x:auto}}
  .stats{{display:flex;flex-wrap:wrap;gap:16px 28px;margin-bottom:14px}}
  .stats b{{display:block;font-size:24px;line-height:1.1}}
  .stats span{{font-size:13px;color:var(--muted)}}
  table{{width:100%;border-collapse:collapse;font-size:14px}}
  th,td{{text-align:left;padding:8px 10px;border-top:1px solid var(--line)}}
  th{{color:var(--muted);font-weight:600}}
  .spot{{margin:32px 0;padding-top:20px;border-top:1px solid var(--line)}}
  .pickers{{display:flex;flex-wrap:wrap;gap:10px 18px;margin:0 0 10px;font-size:14px}}
  select{{font:inherit;padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--ink)}}
  .compare .frame{{position:relative;user-select:none;-webkit-user-select:none;touch-action:pan-y;cursor:ew-resize;border-radius:10px;overflow:hidden;border:1px solid var(--line)}}
  .compare img{{display:block;width:100%;height:auto}}
  .compare .before{{position:absolute;inset:0;clip-path:inset(0 calc(100% - var(--cut)) 0 0);pointer-events:none}}
  .compare .frame::after{{content:"";position:absolute;top:0;bottom:0;left:var(--cut);width:2px;margin-left:-1px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.3);pointer-events:none}}
  .compare .tag{{position:absolute;top:10px;font:600 11px ui-monospace,Menlo,monospace;background:rgba(19,32,42,.78);color:#fff;padding:4px 8px;border-radius:5px;pointer-events:none;max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
  .compare .tag.left{{left:10px}}.compare .tag.right{{right:10px}}
  .compare input{{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;pointer-events:none}}
  .compare .knob{{position:absolute;top:50%;left:var(--cut);width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:#fff;color:#13202a;box-shadow:0 1px 5px rgba(0,0,0,.4);display:grid;place-items:center;font-weight:700;pointer-events:none}}
  .crops{{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}}
  .crop,.full-stitch{{margin:0}}
  .crop img,.full-stitch img{{display:block;width:100%;height:auto;border-radius:8px;border:1px solid var(--line)}}
  figcaption{{font-size:12px;color:var(--muted);margin-top:5px}}
  .full-stitch{{margin-top:16px}}
  .err{{color:var(--accent);font-weight:600}}
</style>
</head>
<body>
<main>
  <p class="eyebrow">Isometric Burlington · Stage 1 Trial</p>
  <h1>High-Resolution Sharpness Showdown</h1>
  <p class="lede">2× sharper renders (<b>{summary["pixel_m"]*100:.1f} cm/px</b>) redrawn directly with <code>{esc(summary["model"])}</code> (<code>{esc(summary["quality"])}</code> quality) using Church Street as the style reference, compared against today's live map.</p>

  <div class="summary">
    <div class="stats">
      <div><b>${summary["total_usd"]:.2f}</b><span>actual OpenAI spend ({summary["calls"]} calls)</span></div>
      <div><b>{summary["passed"]} / {summary["drawn"]}</b><span>tiles passed alignment checks</span></div>
      <div><b>{summary["pixel_m"]*100:.1f} cm/px</b><span>render scale (2× today's 23 cm/px)</span></div>
    </div>
    <table>
      <thead><tr><th>Output size</th><th>Calls</th><th>Spent</th><th>Avg / tile</th><th>Core (~160)</th><th>Burl + Win (~330)</th><th>All 3 towns (~703)</th></tr></thead>
      <tbody>{"".join(cost_rows)}</tbody>
    </table>
  </div>

  {seam_html}
  {"".join(spot_sections)}
</main>
<script>
for (const c of document.querySelectorAll('.compare')) {{
  const imgs = JSON.parse(c.dataset.imgs), lbls = JSON.parse(c.dataset.lbls);
  const f = c.querySelector('.frame'), r = f.querySelector('input');
  const bImg = f.querySelector('.before'), aImg = f.querySelector('.after');
  const bTag = f.querySelector('.tag.left'), aTag = f.querySelector('.tag.right');
  c.querySelector('.pick-l').addEventListener('change', e => {{ bImg.src = imgs[e.target.value]; bTag.textContent = lbls[e.target.value]; }});
  c.querySelector('.pick-r').addEventListener('change', e => {{ aImg.src = imgs[e.target.value]; aTag.textContent = lbls[e.target.value]; }});
  const set = () => {{ f.style.setProperty('--cut', r.value + '%'); }};
  const at = e => {{ const b = f.getBoundingClientRect(); r.value = Math.round(Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)) * 100); set(); }};
  let start = null, drag = false;
  f.addEventListener('pointerdown', e => {{ start = [e.clientX, e.clientY]; drag = e.pointerType === 'mouse'; if (drag) {{ e.preventDefault(); f.setPointerCapture(e.pointerId); at(e); }} }});
  f.addEventListener('pointermove', e => {{ if (!start) return; if (!drag) {{ const dx = Math.abs(e.clientX - start[0]), dy = Math.abs(e.clientY - start[1]); if (dx > 6 && dx > dy) {{ drag = true; f.setPointerCapture(e.pointerId); }} else return; }} at(e); }});
  const end = () => {{ start = null; drag = false; }};
  f.addEventListener('pointerup', end); f.addEventListener('pointercancel', end);
  r.addEventListener('input', set); set();
}}
</script>
</body>
</html>"""


def run_hires_trial(job, out, log, job_start=None):
    """Run Stage 1 high-res trial: render spots + 2x2 seam grid, draw with OpenAI, stitch, build review.html."""
    angle = int(job.get("angle", 0))
    pixel_m = float(job.get("pixel_m", 0.115))
    scale = geo.PIXEL_M / pixel_m
    render_size = int(job.get("render_size", 2048))
    model = job.get("model", "gpt-image-2.6-sunburst")
    look = job.get("look", "builder_hires")
    quality = job.get("quality", "high")
    sizes = list(job.get("sizes", ["2048x2048", "2880x2880"]))
    seam_size = job.get("seam_size", sizes[-1])
    overlap_frac = float(job.get("overlap_frac", 0.2))
    max_calls = int(job.get("max_calls", 15))
    deadline = (job_start or time.time()) + job.get("max_minutes", 180) * 60
    prompt = teacher.STYLES[look]

    # 1. Plan every frame to render in one headless Chromium pass
    spots = [dict(s) for s in job["spots"]]
    all_frames = []
    for sp in spots:
        fr, lv = _spot_frame(angle, sp["lat"], sp["lon"], sp.get("h", 30.0), pixel_m, render_size)
        sp["frame"] = fr
        sp["lake_level"] = lv
        all_frames.append(fr)

    seam_cfg = job.get("seam_center")
    seam_frames = []
    ov_render = int(round(render_size * overlap_frac))
    stride_render = render_size - ov_render
    seam_lake = None
    if seam_cfg:
        e, n, u = geo.lla_to_enu(seam_cfg["lat"], seam_cfg["lon"], seam_cfg.get("h", 33.0))
        x_base, y_base = geo.enu_to_px(angle, float(e), float(n), float(u))
        cx, cy = x_base * scale, y_base * scale
        span = 2 * render_size - ov_render
        x0 = int(round((cx - span / 2) / 64)) * 64
        y0 = int(round((cy - span / 2) / 64)) * 64
        seam_lake = teacher.lake_level(float(e), float(n))
        for r in (0, 1):
            row = []
            for c in (0, 1):
                fr = [x0 + c * stride_render, y0 + r * stride_render]
                row.append(fr)
                if fr not in all_frames:
                    all_frames.append(fr)
            seam_frames.append(row)

    renders_dir = out / "renders"
    renders_dir.mkdir(parents=True, exist_ok=True)
    frames_file = out / "frames.json"
    frames_file.write_text(json.dumps(all_frames))

    cmd = [
        "node", "pipeline/render/render.mjs",
        "--angle", str(angle),
        "--frames", str(frames_file),
        "--out", str(renders_dir),
        "--size", str(render_size),
        "--pixelM", str(pixel_m),
    ]
    if job.get("errorTarget"):
        cmd += ["--errorTarget", str(job["errorTarget"])]
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=3600)
    log.write(p.stdout + p.stderr)
    if p.returncode:
        raise RuntimeError(f"render failed ({p.returncode}): {(p.stderr or p.stdout)[-500:]}")

    # 2. Strict budget tracker
    calls = 0
    total_usd = 0.0
    by_size = {sz: {"calls": 0, "usd": 0.0} for sz in dict.fromkeys(sizes + [seam_size])}
    passed_count = 0
    drawn_count = 0
    out_of_quota = False

    def draw_one(rgb_im, hmap_path, lake_lv, sz, style_ref=None, allow_retry=True):
        nonlocal calls, total_usd, passed_count, drawn_count, out_of_quota
        if out_of_quota or calls >= max_calls:
            return None, {"error": "budget cap reached" if not out_of_quota else "out of quota"}
        render_bytes = _png_bytes(rgb_im)
        hmap = teacher.heights(str(hmap_path)) if hmap_path.exists() else None
        best = None
        tries = 2 if allow_retry else 1
        for attempt in range(tries):
            if calls >= max_calls:
                break
            try:
                img_bytes, usage = teacher.call_openai(
                    model, render_bytes, prompt, quality=quality, size=sz,
                    deadline=deadline, style_ref_png=style_ref,
                )
            except teacher.OutOfQuota as e:
                out_of_quota = True
                return None, {"error": str(e)[:250]}
            except (teacher.NotBilled, RuntimeError) as e:
                return None, {"error": str(e)[:250]}
            calls += 1
            usd = teacher.estimate_cost(usage)
            total_usd += usd
            by_size.setdefault(sz, {"calls": 0, "usd": 0.0})
            by_size[sz]["calls"] += 1
            by_size[sz]["usd"] += usd
            drawn_im = Image.open(BytesIO(img_bytes)).convert("RGB")
            chk = teacher.check(rgb_im, drawn_im, hmap, lake_lv)
            rec = {"size": sz, "actual_size": list(drawn_im.size), "usd": round(usd, 4), "usage": usage, "check": chk, "attempts": attempt + 1}
            best = (drawn_im, rec)
            if chk["pass"]:
                break
        if best is None:
            return None, {"error": "budget cap reached"}
        drawn_count += 1
        if best[1]["check"]["pass"]:
            passed_count += 1
        return best

    web_dir = out / "web"
    web_dir.mkdir(exist_ok=True)
    drawn_dir = out / "drawn"
    drawn_dir.mkdir(exist_ok=True)

    # 3. Draw the showdown spots (Spot 0 sets the golden style reference for every subsequent tile)
    style_ref_bytes = None
    spots_out = []
    for idx, sp in enumerate(spots):
        fx, fy = sp["frame"]
        name = f"{fx}_{fy}"
        r_png = renders_dir / f"{name}.png"
        h_png = renders_dir / f"{name}.h.png"
        if not r_png.exists():
            spots_out.append({"id": sp["id"], "label": sp["label"], "error": "render missing"})
            continue
        empty = _empty_share(r_png)
        if empty > 0.02:
            spots_out.append({"id": sp["id"], "label": sp["label"], "error": f"render has holes ({empty})"})
            continue

        rgb = _render_rgb(r_png)
        sp_rec = {"id": sp["id"], "label": sp["label"], "frame": sp["frame"], "drawn": {}, "crops": {}}
        _save_webp(rgb, web_dir / f"{sp['id']}_render.webp", max_dim=1440)
        sp_rec["render_img"] = f"web/{sp['id']}_render.webp"

        # Center 26% x 19% physical patch (identical framing across live/render/2K/4K) at crisp 720x520
        def save_center_crop(im, key_name):
            w, h = im.size
            cw = max(1, int(round(w * 0.26)))
            ch = max(1, int(round(h * 0.19)))
            x0c, y0c = (w - cw) // 2, (h - ch) // 2
            patch = im.crop((x0c, y0c, x0c + cw, y0c + ch))
            if patch.size != (720, 520):
                patch = patch.resize((720, 520), Image.LANCZOS)
            _save_webp(patch, web_dir / f"{sp['id']}_crop_{key_name}.webp", quality=90)
            sp_rec["crops"][key_name] = f"web/{sp['id']}_crop_{key_name}.webp"

        save_center_crop(rgb, "render")

        live_im = _fetch_live_crop(angle, fx / scale, fy / scale, render_size / scale, render_size / scale, (render_size, render_size))
        if live_im is not None:
            _save_webp(live_im, web_dir / f"{sp['id']}_live.webp", max_dim=1440)
            sp_rec["live_img"] = f"web/{sp['id']}_live.webp"
            save_center_crop(live_im, "live")

        # Draw largest size first on Spot 0 so it immediately becomes the style reference for everything else
        order = list(reversed(sizes)) if idx == 0 else list(sizes)
        for sz in order:
            ref = None if (idx == 0 and style_ref_bytes is None) else style_ref_bytes
            im, rec = draw_one(rgb, h_png, sp["lake_level"], sz, style_ref=ref, allow_retry=(idx == 0))
            if im is None:
                sp_rec["drawn"][sz] = rec
                continue
            im.save(drawn_dir / f"{sp['id']}_{sz}.png")
            _save_webp(im, web_dir / f"{sp['id']}_{sz}.webp", max_dim=1440)
            rec["img"] = f"web/{sp['id']}_{sz}.webp"
            sp_rec["drawn"][sz] = rec
            save_center_crop(im, sz)
            if idx == 0 and style_ref_bytes is None:
                # 1024x1024 PNG style reference keeps input token costs tiny while preserving exact style
                style_ref_bytes = _png_bytes(im, size=(1024, 1024))
                (out / "style_ref.png").write_bytes(style_ref_bytes)

        spots_out.append(sp_rec)

    # 4. Draw & stitch the 2x2 overlapping seam-cut grid
    seam_out = None
    if seam_frames and not out_of_quota:
        grid_imgs = [[None, None], [None, None]]
        grid_recs = []
        tw, th = _parse_size(seam_size)
        for r in (0, 1):
            for c in (0, 1):
                fx, fy = seam_frames[r][c]
                name = f"{fx}_{fy}"
                r_png = renders_dir / f"{name}.png"
                h_png = renders_dir / f"{name}.h.png"
                if not r_png.exists() or _empty_share(r_png) > 0.02:
                    grid_recs.append({"rc": [r, c], "frame": [fx, fy], "error": "render incomplete"})
                    continue
                rgb = _render_rgb(r_png)
                im, rec = draw_one(rgb, h_png, seam_lake, seam_size, style_ref=style_ref_bytes, allow_retry=False)
                if im is not None:
                    if im.size != (tw, th):
                        im = im.resize((tw, th), Image.LANCZOS)
                    im.save(drawn_dir / f"seam_{r}_{c}_{seam_size}.png")
                    grid_imgs[r][c] = im
                grid_recs.append({"rc": [r, c], "frame": [fx, fy], **rec})

        ok_tiles = sum(1 for r in (0, 1) for c in (0, 1) if grid_imgs[r][c] is not None)
        seam_out = {"label": seam_cfg["label"], "size": seam_size, "tiles_ok": ok_tiles, "tiles": grid_recs}
        if ok_tiles == 4:
            ov_drawn = int(round(tw * (ov_render / render_size)))
            st_cut = seam.stitch_grid(grid_imgs, ov_drawn, ov_drawn, feather=14, crossfade=False)
            st_fade = seam.stitch_grid(grid_imgs, ov_drawn, ov_drawn, feather=14, crossfade=True)
            _save_webp(st_cut, web_dir / "seam_cut_full.webp", max_dim=2048)
            seam_out["seamcut_full"] = "web/seam_cut_full.webp"

            # Crop a 1440x900 native 1:1 window right across the central 4-tile seam intersection!
            sw, sh = st_cut.size
            cw, ch = min(1440, sw), min(900, sh)
            cx0, cy0 = (sw - cw) // 2, (sh - ch) // 2
            _save_webp(st_cut.crop((cx0, cy0, cx0 + cw, cy0 + ch)), web_dir / "seam_cut_crop.webp", quality=90)
            _save_webp(st_fade.crop((cx0, cy0, cx0 + cw, cy0 + ch)), web_dir / "seam_fade_crop.webp", quality=90)
            seam_out["seamcut_crop"] = "web/seam_cut_crop.webp"
            seam_out["crossfade_crop"] = "web/seam_fade_crop.webp"

            # Matching live map crop over the exact same central seam window
            span_render = 2 * render_size - ov_render
            gx0, gy0 = seam_frames[0][0]
            live_full = _fetch_live_crop(angle, gx0 / scale, gy0 / scale, span_render / scale, span_render / scale, (sw, sh))
            if live_full is not None:
                _save_webp(live_full.crop((cx0, cy0, cx0 + cw, cy0 + ch)), web_dir / "seam_live_crop.webp", quality=90)
                seam_out["live_crop"] = "web/seam_live_crop.webp"

    summary = {
        "model": model,
        "look": look,
        "quality": quality,
        "pixel_m": pixel_m,
        "render_size": render_size,
        "calls": calls,
        "max_calls": max_calls,
        "drawn": drawn_count,
        "passed": passed_count,
        "total_usd": round(total_usd, 4),
        "by_size": {k: {"calls": v["calls"], "usd": round(v["usd"], 4)} for k, v in by_size.items()},
    }
    (out / "results.json").write_text(json.dumps({"summary": summary, "spots": spots_out, "seam": seam_out}, indent=2))
    (out / "review.html").write_text(build_review_html(summary, spots_out, seam_out))
    return summary
