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
BOAT = 40                     # water pixels this much brighter than their surroundings are kept (boats, wakes)
CELL_WET = 0.5                # a latent cell counts as water when this share of its pixels is
SPECK = 12                    # dry patches smaller than this many cells (boats, buoys, wave glints) are lake
SHORE_FREE = 3                # cells next to land that the model always draws, free of any pin (48 px)
RAMP = 3                      # cells beyond that over which the pin fades in
# (a wider free band let the model grow invented island towns around real islands and boats)
SEAM_WIDTH = 2                # imagery seams at lake level up to ~4 cells wide are lake
FILL_REACH = 16               # missing cells this close to pinned lake become plain lake (= canvas margin)


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


def fit_level(h, level_cells):
    """The predicted lake level, moved onto the lake actually in this canvas. Far from the origin the
    tiles' lake sits up to ~1.5 m below the prediction (geoid). The shift is the commonest height
    offset of flat pixels near the prediction, used only when there is plenty of such surface and
    the shift is plausible for lake (so a flat lot above the lake can never become the level)."""
    lv = np.repeat(np.repeat(level_cells, LAT, 0), LAT, 1)
    r = h - lv
    gy, gx = np.gradient(np.nan_to_num(h))
    sel = np.isfinite(r) & (np.abs(r) < 4) & (np.hypot(gx, gy) < 0.05)
    if sel.mean() < 0.05:
        return level_cells
    hist, edges = np.histogram(r[sel], bins=80, range=(-4, 4))
    mode = float(edges[hist.argmax()] + 0.05)
    # only ever lower the level: where the lake is near the prediction its surface is not one plane
    # (the harbour spans -1.4..0 m) and the original band already holds it
    if not (-2.5 <= mode < -1.0) or hist.max() < 0.05 * r.size:
        return level_cells
    return level_cells + (mode + 0.35)        # centre the (-1.5, +0.8) band on the lake


def lake_band(h, level_cells):
    """Pixels at or below lake level (up to 0.8 m above it). Nothing on land sits below the lake, and
    far out the tiles' lake surface sags several metres and is not one plane, so there is no floor."""
    lv = np.repeat(np.repeat(level_cells, LAT, 0), LAT, 1)
    return h < lv + 0.8


def water_pixels(h, level_cells):
    """Open water: within a metre or so of lake level, and flat (teacher.water_mask, per-cell level)."""
    gy, gx = np.gradient(np.nan_to_num(h))
    return lake_band(h, level_cells) & (np.hypot(gx, gy) < 0.05)


INLAND_CELLS = 3000            # an inland water surface must be this big (~8 ha) to be pinned
INLAND_LUM = 110              # ... and as dark as water in the render (roofs and lots are brighter)


def _components(mask):
    """8-connected components of a (H, W) bool array -> list of index arrays (ys, xs)."""
    H, W = mask.shape
    seen = np.zeros_like(mask)
    comps = []
    for y0, x0 in zip(*np.nonzero(mask)):
        if seen[y0, x0]:
            continue
        stack, ys, xs = [(y0, x0)], [], []
        seen[y0, x0] = True
        while stack:
            y, x = stack.pop()
            ys.append(y); xs.append(x)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < H and 0 <= xx < W and mask[yy, xx] and not seen[yy, xx]:
                        seen[yy, xx] = True
                        stack.append((yy, xx))
        comps.append((np.array(ys), np.array(xs)))
    return comps


def inland_water(h, rgb):
    """Big flat dark water surfaces at any height (ponds and lakes other than Champlain): pixels.
    In the tiles a lake is a level surface; a city has nothing that flat, that big and that dark."""
    Hc, Wc = h.shape[0] // LAT, h.shape[1] // LAT
    gy, gx = np.gradient(np.nan_to_num(h))
    flat = (np.hypot(gx, gy) < 0.05) & np.isfinite(h)
    out = np.zeros(h.shape, bool)
    if flat.sum() < INLAND_CELLS * LAT * LAT * 0.5:
        return out
    v = h[flat]
    edges = np.arange(np.floor(v.min()), np.ceil(v.max()) + 0.4, 0.2)
    hist, edges = np.histogram(v, bins=edges)
    lum = rgb.astype(np.float32) @ np.array([0.3, 0.59, 0.11], np.float32)
    done = []
    for i in np.argsort(hist)[::-1]:
        if hist[i] < INLAND_CELLS * LAT * LAT * 0.25:
            break
        pk = edges[i] + 0.1
        if any(abs(pk - d) < 1.0 for d in done):
            continue
        done.append(pk)
        m = flat & (np.abs(h - pk) < 0.5)
        cells = m.reshape(Hc, LAT, Wc, LAT).mean(axis=(1, 3)) >= CELL_WET
        for ys, xs in _components(cells):
            if len(ys) < INLAND_CELLS:
                continue
            keep = np.zeros((Hc, Wc), bool); keep[ys, xs] = True
            px = m & np.repeat(np.repeat(keep, LAT, 0), LAT, 1)
            if lum[px].mean() < INLAND_LUM:
                out |= px
    return out


def near_water_level(h, water_px, reach=8, above=0.15):
    """Pixels no higher than the water surface nearby (within `reach` cells), give or take `above` m:
    the ramps between lake surfaces at different levels, never a breakwater or pier standing above."""
    H, W = h.shape[0] // LAT, h.shape[1] // LAT
    hw = np.where(water_px, np.nan_to_num(h, nan=-1e9), -1e9).reshape(H, LAT, W, LAT).max(axis=(1, 3))
    t = torch.from_numpy(hw.astype(np.float32))[None, None]
    k = 2 * reach + 1
    top = F.max_pool2d(F.pad(t, (reach,) * 4, value=-1e9), k, stride=1)[0, 0].numpy()
    lim = np.repeat(np.repeat(top, LAT, 0), LAT, 1) + above
    return np.isfinite(h) & (top.max() > -1e8) & (h <= lim)


def water_like(rgb):
    """Pixels whose 16-px cell could be water by its look in the render. Water in the tiles is smooth
    (a cell's brightness varies by ~1, at most ~10 on choppy far lake), whatever its colour: navy, grey,
    green shallows or a brown sediment plume. Fields, meadows and wetland scrub are textured (~9-25) and
    green or warm, and a flat one near a water level was otherwise pinned as a pond. So only cells that
    are both textured and not blue-grey are vetoed (beaches and docks too, which is harmless)."""
    H, W = rgb.shape[0] // LAT, rgb.shape[1] // LAT
    c = rgb.astype(np.float32).reshape(H, LAT, W, LAT, 3)
    m = c.mean(axis=(1, 3))
    sd = (c @ np.array([0.3, 0.59, 0.11], np.float32)).std(axis=(1, 3))
    r, g, b = m[..., 0], m[..., 1], m[..., 2]
    veto = (sd > 6) & ((g > b + 15) | (r > b + 10))
    return np.repeat(np.repeat(~veto, LAT, 0), LAT, 1)


def dark(rgb, lum=110):
    """Pixels as dark as lake water in the render (rocks, docks and boats are brighter)."""
    return rgb.astype(np.float32) @ np.array([0.3, 0.59, 0.11], np.float32) < lum


def _thin(mask, r):
    """Cells of mask that a morphological opening of radius r removes: lines at most ~2r cells wide."""
    t = torch.from_numpy(mask.astype(np.float32))[None, None]
    k = 2 * r + 1
    eroded = 1 - F.max_pool2d(F.pad(1 - t, (r,) * 4, value=1.0), k, stride=1)
    opened = F.max_pool2d(F.pad(eroded, (r,) * 4, value=0.0), k, stride=1)
    return mask & ~(opened[0, 0].numpy() > 0)


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


def plan(water_px, missing_px=None, band_px=None):
    """Per-cell pin weight, and the cells painted plain lake in the pin target.

    0 on land and for SHORE_FREE cells off any shore, fading in to 1 over RAMP. Cells with no render
    (the margin where the map ends, holes far out in the lake) are neutral: they are not shore, they
    are never pinned to their (black) render, and those touching pinned lake are pinned to plain
    style water so the map's edge in the lake is not drawn from black.
    band_px: pixels at lake level (flat or not). Far out, the lake's tiles have seams where the surface
    ramps by up to a metre: thin lines of cells that are at lake level but not flat are lake too
    (a breakwater or pier stands above lake level, so it is never one of them)."""
    H, W = water_px.shape[0] // LAT, water_px.shape[1] // LAT
    cell = lambda a: a.reshape(H, LAT, W, LAT).mean(axis=(1, 3))
    missing = cell(missing_px) >= CELL_WET if missing_px is not None else np.zeros((H, W), bool)
    dry = (cell(water_px) < CELL_WET) & ~missing
    seam = np.zeros((H, W), bool)
    if band_px is not None:
        seam = _thin(dry & (cell(band_px) >= 0.9), SEAM_WIDTH)
        dry &= ~seam
    dry = _drop_specks(dry, SPECK)
    wet = torch.from_numpy((~dry).astype(np.float32))[None, None]
    # core: no land within SHORE_FREE + RAMP cells (outside the canvas and missing cells count as water)
    r = SHORE_FREE + RAMP
    core = 1 - F.max_pool2d(F.pad(1 - wet, (r,) * 4, value=0.0), 2 * r + 1, stride=1)
    w = core.clone()
    for d in range(1, RAMP + 1):
        grown = F.max_pool2d(F.pad(core, (d,) * 4, value=0.0), 2 * d + 1, stride=1)
        w = torch.maximum(w, grown * (1 - d / (RAMP + 1)))
    w = (w * wet)[0, 0]
    miss = torch.from_numpy(missing)
    w[miss] = 0
    # missing cells next to fully pinned lake: plain lake (reach covers a whole canvas margin)
    full = (w >= 0.999).float()[None, None]
    near = F.max_pool2d(F.pad(full, (FILL_REACH,) * 4, value=0.0), 2 * FILL_REACH + 1, stride=1)[0, 0] > 0
    fill = miss & near
    w[fill] = 1.0
    # paint a cell either side of a seam too: its ramp spills into the neighbouring (wet) cells
    if seam.any():
        sd = F.max_pool2d(torch.from_numpy(seam.astype(np.float32))[None, None], 3, stride=1, padding=1)[0, 0].numpy() > 0
        seam = sd & ~dry
    return w, fill.numpy() | seam


def pin_weights(water_px, missing_px=None, band_px=None):
    return plan(water_px, missing_px, band_px)[0]


def recolour(render_rgb, water_px, fill_cells=None, blur=24):
    """The render with its water pixels in plain style water, keeping only what stands out bright from
    its surroundings (boats, wakes). The render's lake tone (haze, glare, imagery seams) is dropped.
    fill_cells (H, W) bool: cells painted plain style water whole (no render, imagery seams)."""
    from PIL import Image, ImageFilter
    img = render_rgb.astype(np.float32)
    local = np.asarray(Image.fromarray(render_rgb.astype(np.uint8)).filter(ImageFilter.BoxBlur(blur))).astype(np.float32)
    out = img.copy()
    lum = lambda a: a @ np.array([0.3, 0.59, 0.11], np.float32)
    boat = water_px & ((lum(img) - lum(local)) > BOAT)
    out[water_px & ~boat] = WATER_TO
    if fill_cells is not None and fill_cells.any():
        out[np.repeat(np.repeat(fill_cells, LAT, 0), LAT, 1)] = WATER_TO
    return out.astype(np.uint8)


def encode_tiles(encode, img, weight, core=64, ctx=16):
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
