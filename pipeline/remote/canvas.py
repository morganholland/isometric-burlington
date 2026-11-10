"""Fill what a block's canvas cannot see, so the model is never shown black.

Beyond the map's edge there is no neighbour block: its slot of the canvas margin is filled by
mirroring the block itself across the shared edge (black there made the model invent a city
that spilled into the block). Anything still clear (outside the map's region inside a block)
is filled with a blurred push-pull extension of the nearby colours. Pure numpy.
"""
import numpy as np


def mirror_missing(arr, present, m, B):
    """arr (2m+B, 2m+B, C): canvas with the block at [m, m+B). present[(dx, dy)] for dx, dy in -1..1.
    Missing slots get the block mirrored across the shared edge(s). Returns a new array."""
    out = arr.copy()
    idx = {-1: lambda n: 2 * m - 1 - np.arange(0, m),            # canvas [0, m) <- [m, 2m) reversed
           0: lambda n: np.arange(m, m + B),
           1: lambda n: 2 * (m + B) - 1 - np.arange(m + B, 2 * m + B)}
    span = {-1: slice(0, m), 0: slice(m, m + B), 1: slice(m + B, 2 * m + B)}
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if (dx, dy) == (0, 0) or present.get((dx, dy)):
                continue
            ys, xs = idx[dy](0), idx[dx](0)
            out[span[dy], span[dx]] = arr[np.ix_(ys, xs)]
    return out


def pushpull_fill(rgb, alpha, levels=12):
    """Fill pixels where alpha == 0 with a smooth extension of the visible colours."""
    known = (alpha > 0).astype(np.float32)
    if known.all() or not known.any():
        return rgb
    pyr = [(rgb.astype(np.float32) * known[..., None], known)]
    for _ in range(levels):
        c, w = pyr[-1]
        if min(w.shape) < 2:
            break
        h2, w2 = c.shape[0] // 2 * 2, c.shape[1] // 2 * 2
        c4 = c[:h2, :w2].reshape(h2 // 2, 2, w2 // 2, 2, -1).sum((1, 3))
        w4 = w[:h2, :w2].reshape(h2 // 2, 2, w2 // 2, 2).sum((1, 3))
        pyr.append((c4, w4))
    c, w = pyr[-1]
    est = c / np.maximum(w, 1e-6)[..., None]
    for c, w in reversed(pyr[:-1]):
        up = np.repeat(np.repeat(est, 2, 0), 2, 1)
        full = np.zeros(c.shape, np.float32); full[:up.shape[0], :up.shape[1]] = up[:c.shape[0], :c.shape[1]]
        if up.shape[0] < c.shape[0]:
            full[up.shape[0]:] = full[up.shape[0] - 1]
        if up.shape[1] < c.shape[1]:
            full[:, up.shape[1]:] = full[:, up.shape[1] - 1:up.shape[1]]
        mine = c / np.maximum(w, 1e-6)[..., None]
        a = np.clip(w, 0, 1)[..., None]
        est = a * mine + (1 - a) * full
    out = rgb.copy()
    hole = alpha == 0
    out[hole] = np.clip(est[hole], 0, 255).astype(rgb.dtype)
    return out
