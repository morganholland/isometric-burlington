"""Minimum-error seam-cut stitching for overlapping independently drawn tiles.

Instead of cross-fading an overlap strip (which creates ghosted double cars and roofs when
neighbouring AI drawings disagree slightly), find the lowest-error path through the overlap
with dynamic programming and feather only a narrow band (~14 px) across that seam.
"""
import numpy as np
from PIL import Image


def _seam_x(a, b, margin=0):
    """For two (H, W, 3) float32 overlap strips, return x[y] minimising RGB error from top to bottom."""
    h, w = a.shape[:2]
    err = ((a - b) ** 2).sum(axis=2).astype(np.float64)
    # Keep the seam away from the very edges so the feather strip stays inside the overlap.
    if margin > 0 and 2 * margin < w:
        hi = float(err.max() + 1.0) * 1e4 + 1e6
        err[:, :margin] = hi
        err[:, w - margin:] = hi
    dp = np.empty_like(err)
    back = np.zeros((h, w), dtype=np.int8)
    dp[0] = err[0]
    for y in range(1, h):
        prev = dp[y - 1]
        left = np.empty(w, dtype=np.float64)
        left[0] = np.inf
        left[1:] = prev[:-1]
        right = np.empty(w, dtype=np.float64)
        right[-1] = np.inf
        right[:-1] = prev[1:]
        # Stack (left=-1, center=0, right=+1) and pick argmin per pixel
        stack = np.stack([left, prev, right], axis=0)
        idx = np.argmin(stack, axis=0)
        dp[y] = err[y] + stack[idx, np.arange(w)]
        back[y] = (idx - 1).astype(np.int8)
    seam = np.empty(h, dtype=np.int32)
    seam[h - 1] = int(np.argmin(dp[h - 1]))
    for y in range(h - 2, -1, -1):
        seam[y] = seam[y + 1] + int(back[y + 1, seam[y + 1]])
    return seam


def _feather_mask(seam, width, feather):
    """Smooth [0, 1] transition across x = seam[y] over +/- feather pixels (0 = left, 1 = right)."""
    xs = np.arange(width, dtype=np.float32)[None, :]
    s = seam[:, None].astype(np.float32)
    if feather <= 0:
        return (xs >= s).astype(np.float32)
    t = np.clip((xs - s) / (2.0 * feather) + 0.5, 0.0, 1.0)
    return 0.5 - 0.5 * np.cos(np.pi * t)


def stitch_horizontal(left, right, overlap, feather=14, crossfade=False):
    """Stitch two RGB PIL images horizontally with `overlap` pixels in common."""
    a = np.asarray(left.convert("RGB"), dtype=np.float32)
    b = np.asarray(right.convert("RGB"), dtype=np.float32)
    assert a.shape[0] == b.shape[0], f"height mismatch: {a.shape} vs {b.shape}"
    ov = int(overlap)
    assert 0 < ov < min(a.shape[1], b.shape[1]), f"bad overlap {ov} for {a.shape[1]}, {b.shape[1]}"
    oa, ob = a[:, -ov:], b[:, :ov]
    if crossfade:
        t = np.linspace(0.0, 1.0, ov, dtype=np.float32)[None, :]
        alpha = 0.5 - 0.5 * np.cos(np.pi * t)
    else:
        margin = min(max(2, feather), ov // 4)
        seam = _seam_x(oa, ob, margin=margin)
        alpha = _feather_mask(seam, ov, feather)
    mid = oa * (1.0 - alpha[..., None]) + ob * alpha[..., None]
    out = np.concatenate([a[:, :-ov], mid, b[:, ov:]], axis=1)
    return Image.fromarray(np.clip(np.rint(out), 0, 255).astype(np.uint8), "RGB")


def stitch_vertical(top, bottom, overlap, feather=14, crossfade=False):
    """Stitch two RGB PIL images vertically with `overlap` pixels in common."""
    t_rot = top.convert("RGB").transpose(Image.TRANSPOSE)
    b_rot = bottom.convert("RGB").transpose(Image.TRANSPOSE)
    stitched = stitch_horizontal(t_rot, b_rot, overlap, feather=feather, crossfade=crossfade)
    return stitched.transpose(Image.TRANSPOSE)


def stitch_grid(grid, overlap_x, overlap_y=None, feather=14, crossfade=False):
    """Stitch a 2D list of RGB PIL images [[row0_col0, row0_col1, ...], ...]."""
    if overlap_y is None:
        overlap_y = overlap_x
    rows = []
    for row in grid:
        cur = row[0].convert("RGB")
        for nxt in row[1:]:
            cur = stitch_horizontal(cur, nxt, overlap_x, feather=feather, crossfade=crossfade)
        rows.append(cur)
    out = rows[0]
    for nxt in rows[1:]:
        out = stitch_vertical(out, nxt, overlap_y, feather=feather, crossfade=crossfade)
    return out
