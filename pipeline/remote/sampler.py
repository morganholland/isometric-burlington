"""Joint latent sampling for one block of the map (Tiny London / Isometric Toronto method).

A block is drawn as one latent canvas: the block plus a margin of its neighbours. Every step the
model runs on overlapping windows; their velocity predictions are blended into one field, so no
window edge survives. Alternate steps shift the window grid by half a stride. Neighbours that are
already finished are pinned: at noise level sigma their latents are held at
(1 - sigma) * clean + sigma * noise, with the same noise the whole map shares, fading to free over a
strip next to the block. Pure numpy/torch logic; the model is any `denoise(x, sigma, win) -> v`.
"""
import math
import torch

LAT = 16          # pixels per latent cell
WIN = 64          # window, latent cells (1024 px)
TURBO_SIGMAS = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0]


def window_starts(size, win, stride, offset=0):
    """Window starts covering [0, size) with the given stride, first window at -offset (clamped)."""
    if size <= win:
        return [0]
    starts, s = [], -offset
    while True:
        st = min(max(s, 0), size - win)
        if not starts or st != starts[-1]:
            starts.append(st)
        if st + win >= size:
            break
        s += stride
    return starts


def blend_weight(win, device, floor=0.02):
    """Separable raised-cosine weight: windows fade into each other, never to exactly zero."""
    t = (torch.arange(win, device=device, dtype=torch.float32) + 0.5) / win
    w1 = torch.sin(math.pi * t).clamp_min(floor)
    return w1[:, None] * w1[None, :]


def global_noise(channels, y0, x0, h, w, seed, device, tile=32):
    """Noise that depends only on absolute latent position, so every block sees the same field."""
    out = torch.empty(channels, h, w, device=device)
    ty0, tx0 = math.floor(y0 / tile), math.floor(x0 / tile)
    ty1, tx1 = math.floor((y0 + h - 1) / tile), math.floor((x0 + w - 1) / tile)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            g = torch.Generator(device="cpu").manual_seed((seed * 1_000_003 + ty * 92821 + tx * 68917) & 0x7FFFFFFFFFFF)
            n = torch.randn(channels, tile, tile, generator=g)
            ay0, ax0 = ty * tile, tx * tile
            sy0, sx0 = max(ay0, y0), max(ax0, x0)
            sy1, sx1 = min(ay0 + tile, y0 + h), min(ax0 + tile, x0 + w)
            out[:, sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = n[:, sy0 - ay0:sy1 - ay0, sx0 - ax0:sx1 - ax0].to(device)
    return out


def sample_canvas(denoise, noise, pin_clean, pin_weight, sigmas=TURBO_SIGMAS, win=WIN, stride=48, shift=24,
                  skip_threshold=0.999):
    """
    noise      : (C, H, W) the canvas' share of the global noise
    pin_clean  : (C, H, W) clean latents of finished neighbours (anything where pin_weight == 0)
    pin_weight : (H, W) 1 = fully pinned, 0 = free, in between = fading strip
    denoise(x_win (C,win,win), sigma, (y, x)) -> velocity (C,win,win), with x_t = (1-s)*x0 + s*noise
    Returns the clean canvas latent (C, H, W).
    """
    C, H, W = noise.shape
    dev = noise.device
    wgt = blend_weight(win, dev)
    pw = pin_weight.to(dev)[None]
    x = noise.clone()
    evals = 0
    for k in range(len(sigmas) - 1):
        s, s_next = sigmas[k], sigmas[k + 1]
        pinned_now = (1 - s) * pin_clean + s * noise
        x = pw * pinned_now + (1 - pw) * x
        off = shift if k % 2 else 0
        V = torch.zeros_like(x); Wt = torch.zeros(1, H, W, device=dev)
        for y in window_starts(H, win, stride, off):
            for xx in window_starts(W, win, stride, off):
                if float(pin_weight[y:y + win, xx:xx + win].min()) >= skip_threshold:
                    continue  # fully pinned window: nothing to draw
                v = denoise(x[:, y:y + win, xx:xx + win], s, (y, xx))
                evals += 1
                V[:, y:y + win, xx:xx + win] += v * wgt
                Wt[:, y:y + win, xx:xx + win] += wgt
        V = V / Wt.clamp_min(1e-6)
        x = x + (s_next - s) * V
    # final: pinned area exactly the neighbours' clean latents
    x = pw * pin_clean + (1 - pw) * x
    return x, evals


def pin_map(H, W, margin, done, strip=8, device="cpu"):
    """Pin weights for a canvas = block (H-2m, W-2m) + margin m on each side.
    done: dict of neighbour direction -> bool, directions in {'n','s','w','e','nw','ne','sw','se'}.
    A finished neighbour's margin is pinned; it fades to free across `strip` cells toward the block,
    so the block's edge is drawn against the neighbour, never copied from it."""
    m = margin
    pw = torch.zeros(H, W, device=device)
    # index 0 = outer edge of the margin (weight 1) .. index m-1 = next to the block (weight ~0)
    i = torch.arange(m, device=device, dtype=torch.float32)
    ramp = torch.clamp(1 - (i - (m - strip) + 1) / strip, 0, 1)
    regions = {
        "n": (slice(0, m), slice(m, W - m), ramp[:, None].expand(m, W - 2 * m)),
        "s": (slice(H - m, H), slice(m, W - m), ramp.flip(0)[:, None].expand(m, W - 2 * m)),
        "w": (slice(m, H - m), slice(0, m), ramp[None, :].expand(H - 2 * m, m)),
        "e": (slice(m, H - m), slice(W - m, W), ramp.flip(0)[None, :].expand(H - 2 * m, m)),
        "nw": (slice(0, m), slice(0, m), torch.maximum(ramp[:, None], ramp[None, :])),
        "ne": (slice(0, m), slice(W - m, W), torch.maximum(ramp[:, None], ramp.flip(0)[None, :])),
        "sw": (slice(H - m, H), slice(0, m), torch.maximum(ramp.flip(0)[:, None], ramp[None, :])),
        "se": (slice(H - m, H), slice(W - m, W), torch.maximum(ramp.flip(0)[:, None], ramp.flip(0)[None, :])),
    }
    for d, ok in done.items():
        if ok:
            ys, xs, val = regions[d]
            pw[ys, xs] = val
    return pw
