"""Open lake water for the drawing step.

The style model saw little open water in training (the teacher set capped it), and a window of
nothing but lake gives it no structure to follow: it invents a city there. So open lake cells are
pinned, like a finished neighbour, to the latents of the render recoloured to the style's water.
A band next to every shore stays free, so the model still draws the shoreline itself.

Pure numpy/torch; the camera constants mirror pipeline/geo.py (checked by tests/test_water.py).
"""
import math
import numpy as np
import torch
import torch.nn.functional as F

LAT = 16
PIXEL_M = 0.23
ELEV_DEG = 30.0
HEADINGS = [90.0, 180.0, 270.0, 0.0]
LAKE_ENU_M = -0.3             # Lake Champlain in the tiles' heights at the origin (teacher.LAKE_ENU_M)

# style water, measured on block a0 0_0 (Burlington harbour) as drawn by the model: median colour
WATER_TO = np.array([5.0, 74.0, 125.0])
WATER_GAIN = 1.0              # how much of the render's fine water texture is kept
CELL_WET = 0.5                # a latent cell counts as water when this share of its pixels is
SPECK = 12                    # dry patches smaller than this many cells (boats, buoys, wave glints) are lake
SHORE_FREE = 6                # cells next to land that the model always draws, free of any pin (96 px)
RAMP = 4                      # cells beyond that over which the pin fades in


def heights_from_png(rgba):
    """(H, W, 4) uint8 height image -> metres, nan where the render had nothing."""
    a = rgba.astype(np.int64)
    h = ((a[..., 0] << 16) + (a[..., 1] << 8) + a[..., 2]) / 100.0 - 200.0
    h[a[..., 3] == 0] = np.nan
    return h


def ground_en(angle, px, py):
    """Map pixel -> (east, north) metres of the point at about lake level (good enough for curvature)."""
    el, hd = math.radians(ELEV_DEG), math.radians(HEADINGS[angle])
    r = px * PIXEL_M
    f = -py * PIXEL_M / math.sin(el)
    return r * math.cos(hd) + f * math.sin(hd), -r * math.sin(hd) + f * math.cos(hd)


def lake_level_cells(angle, x0, y0, H, W):
    """Lake level per latent cell of a canvas whose top-left map pixel is (x0, y0)."""
    px = x0 + (np.arange(W) + 0.5) * LAT
    py = y0 + (np.arange(H) + 0.5) * LAT
    PX, PY = np.meshgrid(px, py)
    e, n = ground_en(angle, PX, PY)
    return LAKE_ENU_M - (e * e + n * n) / (2 * 6371000.0)


def water_pixels(h, level_cells):
    """Open water: within a metre or so of lake level, and flat (teacher.water_mask, per-cell level)."""
    lv = np.repeat(np.repeat(level_cells, LAT, 0), LAT, 1)
    m = (h > lv - 1.5) & (h < lv + 0.8)
    gy, gx = np.gradient(np.nan_to_num(h))
    return m & (np.hypot(gx, gy) < 0.05)


def _drop_specks(dry, min_cells):
    """dry (H, W) bool -> the same with 8-connected dry patches smaller than min_cells removed."""
    H, W = dry.shape
    seen = np.zeros_like(dry)
    out = dry.copy()
    for y0, x0 in zip(*np.nonzero(dry)):
        if seen[y0, x0]:
            continue
        stack, comp = [(y0, x0)], []
        seen[y0, x0] = True
        while stack:
            y, x = stack.pop()
            comp.append((y, x))
            if len(comp) >= min_cells and not stack:
                break
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < H and 0 <= xx < W and dry[yy, xx] and not seen[yy, xx]:
                        seen[yy, xx] = True
                        stack.append((yy, xx))
        if len(comp) < min_cells:
            for y, x in comp:
                out[y, x] = False
    return out


def pin_weights(water_px):
    """Per-cell pin weight: 0 on land and for SHORE_FREE cells off any shore, then fading in to 1 over RAMP."""
    H, W = water_px.shape[0] // LAT, water_px.shape[1] // LAT
    frac = water_px.reshape(H, LAT, W, LAT).mean(axis=(1, 3))
    dry = _drop_specks(frac < CELL_WET, SPECK)
    wet = torch.from_numpy((~dry).astype(np.float32))[None, None]
    # core: no land within SHORE_FREE + RAMP cells (outside the canvas counts as water)
    r = SHORE_FREE + RAMP
    core = 1 - F.max_pool2d(F.pad(1 - wet, (r,) * 4, value=0.0), 2 * r + 1, stride=1)
    w = core.clone()
    for d in range(1, RAMP + 1):
        grown = F.max_pool2d(F.pad(core, (d,) * 4, value=0.0), 2 * d + 1, stride=1)
        w = torch.maximum(w, grown * (1 - d / (RAMP + 1)))
    return (w * wet)[0, 0]


def recolour(render_rgb, water_px, blur=64):
    """The render with its water pixels in the style's water colour. The render's large-scale tone (haze,
    sun glare across the lake) is removed and its fine texture (ripples, boats) kept on top."""
    from PIL import Image, ImageFilter
    img = render_rgb.astype(np.float32)
    local = np.asarray(Image.fromarray(render_rgb.astype(np.uint8)).filter(ImageFilter.BoxBlur(blur))).astype(np.float32)
    out = img.copy()
    out[water_px] = np.clip(WATER_TO + (img[water_px] - local[water_px]) * WATER_GAIN, 0, 255)
    return out.astype(np.uint8)


def encode_tiles(encode, img, weight, core=64, ctx=8):
    """VAE-encode `img` (H*LAT, W*LAT, 3 uint8) in overlapping tiles, only where weight > 0.
    encode(tensor (3, h, w) in [0, 1]) -> (C, h/LAT, w/LAT). Returns (C, H, W) or None."""
    H, W = weight.shape
    out = None
    starts = lambda n: sorted({min(s, max(n - core, 0)) for s in range(0, n, core)})
    for cy in starts(H):
        for cx in starts(W):
            if float(weight[cy:cy + core, cx:cx + core].max()) <= 0:
                continue
            y0, x0 = max(cy - ctx, 0), max(cx - ctx, 0)
            y1, x1 = min(cy + core + ctx, H), min(cx + core + ctx, W)
            t = torch.from_numpy(img[y0 * LAT:y1 * LAT, x0 * LAT:x1 * LAT]).permute(2, 0, 1).float() / 255.0
            lat = encode(t).float()
            if out is None:
                out = torch.zeros(lat.shape[0], H, W, device=lat.device)
            hh, ww = min(core, H - cy), min(core, W - cx)
            out[:, cy:cy + hh, cx:cx + ww] = lat[:, cy - y0:cy - y0 + hh, cx - x0:cx - x0 + ww]
    return out
