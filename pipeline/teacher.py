"""Teacher: redraw renders as illustrations with an OpenAI image model, then check each drawing
against the render so bad training targets never reach the LoRA.

Checks (all free, no model involved):
  shift   - phase correlation of edge maps; the drawing must sit on the render (< 1.5 px)
  edges   - share of the render's strong edges that the drawing keeps (within 2 px)
  colour  - coarse 32 px cells: drawing colour stays near the render's (no recoloured towers)
  neon    - share of over-saturated green pixels (the "neon park" failure)
  water   - lake pixels (flat, at lake level in the height map) stay water-coloured
"""
import base64, random, io, json, os, time
import numpy as np
import requests
from PIL import Image, ImageFilter

STYLES = {
    "builder": (
        "Redraw this exact image as a finished isometric city illustration. Fidelity comes first: every building, "
        "roof, road, path, tree, shoreline, car and shadow stays exactly where it is, at the same size and with the same "
        "outline. Add nothing and remove nothing. Do not move, crop, zoom, rotate or re-frame anything. "
        "Technique: clean flat colour areas with simple two-tone shading, crisp dark outlines on every edge, tidy "
        "simplified textures, bright clear daylight, in the spirit of a 1990s isometric city-builder game. Keep each "
        "surface's real colour, a little cleaner and brighter. Draw water as flat colour with fine ripple lines and "
        "grass and trees in natural, muted greens. Do not write any letters, numbers, logos or signs."
    ),
    "gouache": (
        "Repaint this exact image as a hand-painted isometric illustration. Fidelity comes first: every building, "
        "roof, road, path, tree, shoreline, car and shadow stays exactly where it is, at the same size and with the same "
        "outline. Add nothing and remove nothing. Do not move, crop, zoom, rotate or re-frame anything. "
        "Technique: opaque gouache with soft, even brushwork, gentle warm light, thin brown-grey ink lines on edges, "
        "slightly softened detail like a storybook map. Keep each surface's real colour, a little warmer. Draw water as "
        "calm painted colour with a few light strokes and grass and trees in natural, muted greens. Do not write any "
        "letters, numbers, logos or signs."
    ),
    "builder_hires": (
        "Redraw the first image as an ultra-crisp, finely detailed isometric city illustration in the spirit of a "
        "hand-crafted architectural city map. Fidelity comes first: every building, roof, road, crosswalk, path, "
        "tree, boat, shoreline and shadow stays in its exact position, size and footprint. Add nothing and remove "
        "nothing. Do not move, crop, zoom, rotate or re-frame anything. "
        "Turn Google 3D scan artifacts into crisp illustration detail: replace melted or blobby parked cars with "
        "tidy, sharp little cars in the same spots and colours; replace blobby foliage with distinct, layered leafy "
        "trees; draw crisp windows, roof tiles, porches, chimneys, rooftop vents and brick facades with clean dark "
        "ink outlines, flat bright daylight colour and subtle two-tone shading. Draw lake water as smooth deep blue "
        "with subtle ripple lines, and grass and trees in natural New England greens. Do not write readable text, "
        "numbers, logos or signs."
    ),
}

STYLE_REF_NOTE = (
    " Match the exact illustration style, ink line weight, colour palette, shading and level of detail of the "
    "second image (style reference), while strictly preserving the layout and geometry of the first image."
)


class NotBilled(RuntimeError):
    """OpenAI turned the request away (rate limit / overload) before generating anything."""


class OutOfQuota(NotBilled):
    """The OpenAI account has no credit left: no later call will work either."""


def estimate_cost(usage):
    """Estimate OpenAI USD spend from an Images API usage object ($5/M text in, $8/M image in, $30/M image out)."""
    if not isinstance(usage, dict):
        return 0.0
    det = usage.get("input_tokens_details") or {}
    txt_in = det.get("text_tokens", 0) or 0
    img_in = det.get("image_tokens", 0) or 0
    if not txt_in and not img_in and usage.get("input_tokens"):
        img_in = usage["input_tokens"]
    out_tok = usage.get("output_tokens", 0) or 0
    return (txt_in * 5.0 + img_in * 8.0 + out_tok * 30.0) / 1_000_000.0


def call_openai(model, render_png, prompt, quality="high", size="1024x1024", retries=6, timeout=600, deadline=None, style_ref_png=None):
    """deadline: epoch seconds; no wait or request is started that could run past it."""
    full_prompt = prompt + STYLE_REF_NOTE if style_ref_png else prompt
    data = {"model": model, "prompt": full_prompt, "size": size, "quality": quality, "n": "1",
            "input_fidelity": "high", "output_format": "png"}
    if style_ref_png:
        files = [
            ("image[]", ("render.png", render_png, "image/png")),
            ("image[]", ("style.png", style_ref_png, "image/png")),
        ]
    else:
        files = {"image": ("render.png", render_png, "image/png")}
    r = None
    for attempt in range(retries):
        left = (deadline - time.time()) if deadline else timeout
        if left < 120:
            raise NotBilled("out of time before the request was sent")
        r = requests.post("https://api.openai.com/v1/images/edits",
                          headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
                          files=files, data=data, timeout=min(timeout, left))
        if r.status_code == 400 and "input_fidelity" in r.text and "input_fidelity" in data:   # model without that option
            data.pop("input_fidelity"); continue
        if r.ok:
            j = r.json()
            return base64.b64decode(j["data"][0]["b64_json"]), j.get("usage", {})
        if r.status_code in (429, 500, 502, 503) and attempt < retries - 1:
            if r.status_code == 429 and "quota" in r.text.lower():
                raise OutOfQuota(f"OpenAI 429: {r.text[:400]}")   # waiting will not help
            try:
                wait = float(r.headers.get("retry-after", 0))
            except ValueError:
                wait = 0
            wait = min(300, max(wait, min(240, 20 * 2 ** attempt))) + random.uniform(0, 10)
            if deadline and time.time() + wait + 120 > deadline:
                raise NotBilled(f"OpenAI {r.status_code}, and no time left to wait it out")
            time.sleep(wait)
            continue
        break
    msg = f"OpenAI {r.status_code}: {r.text[:400]}"
    if r.status_code == 429 and "quota" in r.text.lower():
        raise OutOfQuota(msg)
    if r.status_code in (429, 503):
        raise NotBilled(msg)
    raise RuntimeError(msg)


# ---------------- checks ----------------
def _gray(im):
    return np.asarray(im.convert("L"), dtype=np.float32) / 255.0


def _edges(im):
    g = _gray(im)
    gx = np.zeros_like(g); gy = np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]; gy[1:-1, :] = g[2:, :] - g[:-2, :]
    return np.hypot(gx, gy)


def phase_shift(a, b):
    """Sub-pixel (dy, dx) that best aligns b onto a, from edge maps."""
    A, B = np.fft.fft2(a - a.mean()), np.fft.fft2(b - b.mean())
    R = A * np.conj(B); R /= np.abs(R) + 1e-9
    r = np.fft.ifft2(R).real
    y, x = np.unravel_index(np.argmax(r), r.shape)
    h, w = r.shape
    def sub(c, n, axis):
        cm, cp = r[(y - (axis == 0)) % h, (x - (axis == 1)) % w], r[(y + (axis == 0)) % h, (x + (axis == 1)) % w]
        c0 = r[y, x]; d = cm - 2 * c0 + cp
        off = 0.5 * (cm - cp) / d if d != 0 else 0
        v = c + off
        return v - n if v > n / 2 else v
    return sub(y, h, 0), sub(x, w, 1)


def heights(hpng):
    a = np.asarray(Image.open(io.BytesIO(hpng) if isinstance(hpng, bytes) else hpng).convert("RGBA")).astype(np.int64)
    v = (a[..., 0] << 16) + (a[..., 1] << 8) + a[..., 2]
    h = v / 100.0 - 200.0
    h[a[..., 3] == 0] = np.nan
    return h


LAKE_ENU_M = -0.3   # Lake Champlain in the tiles' ellipsoid heights at the origin (measured, harbour)


def lake_level(e, n):
    """Lake level in the flat ENU frame: the Earth curves away from the tangent plane."""
    return LAKE_ENU_M - (e * e + n * n) / (2 * 6371000.0)


def water_mask(h, level=None):
    """Open water: within a metre or so of lake level, and flat."""
    if h is None or level is None:
        return None
    m = (h > level - 1.5) & (h < level + 0.8)
    gy, gx = np.gradient(np.nan_to_num(h))
    flat = np.hypot(gx, gy) < 0.05
    return m & flat


def check(render, drawing, hmap=None, level=None):
    r = render.convert("RGB"); d = drawing.convert("RGB").resize(r.size, Image.LANCZOS)
    er, ed = _edges(r), _edges(d)
    dy, dx = phase_shift(er, ed)
    shift = float(np.hypot(dy, dx))
    strong = er > np.percentile(er, 92)
    ed_d = np.asarray(Image.fromarray((ed > np.percentile(ed, 85)).astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(5))) > 0
    edges = float((strong & ed_d).sum() / max(1, strong.sum()))
    ra = np.asarray(r.resize((32, 32), Image.BOX), dtype=np.float32)
    da = np.asarray(d.resize((32, 32), Image.BOX), dtype=np.float32)
    cell = np.linalg.norm(ra - da, axis=2)
    colour = float(np.percentile(cell, 95))
    hsv = np.asarray(d.convert("HSV"), dtype=np.float32)
    green = (hsv[..., 0] > 50) & (hsv[..., 0] < 110)
    neon = float(((hsv[..., 1] > 200) & (hsv[..., 2] > 170) & green).mean())
    water = None
    if hmap is not None:
        wm = water_mask(hmap, level)
        if wm is not None:
            rp = np.asarray(r, dtype=np.float32)
            wm = wm & (rp[..., 2] >= rp[..., 0]) & (rp[..., 2] >= rp[..., 1] - 30)   # water in the render too (no docks, boats)
        if wm is not None and wm.mean() > 0.02:
            px = np.asarray(d, dtype=np.float32)[wm]
            blueish = (px[:, 2] >= px[:, 0] - 5) & (px[:, 2] >= px[:, 1] - 25)
            water = float(blueish.mean())
    m = {"shift": round(shift, 2), "edges": round(edges, 3), "colour": round(colour, 1),
         "neon": round(neon, 4), "water": None if water is None else round(water, 3)}
    reasons = []
    if shift > 1.5: reasons.append("moved")
    if edges < 0.55: reasons.append("lost structure")
    if colour > 95: reasons.append("recoloured")
    if neon > 0.03: reasons.append("neon greens")
    if water is not None and water < 0.85: reasons.append("water changed")
    m["pass"] = not reasons
    m["reasons"] = reasons
    return m
