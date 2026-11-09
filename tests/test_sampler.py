"""CPU tests of the joint sampler with an exact stand-in model (no GPU, no weights).

The stand-in returns the true flow velocity toward a known clean latent, so a correct sampler must
reproduce that latent everywhere; pinned neighbours must match their own clean latents exactly; and
two blocks drawn side by side must agree across their shared edge."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline" / "remote"))
import torch
import sampler as S


def smooth_field(C, y0, x0, H, W):
    yy = torch.arange(y0, y0 + H, dtype=torch.float32)[:, None]
    xx = torch.arange(x0, x0 + W, dtype=torch.float32)[None, :]
    return torch.stack([torch.sin(yy / (7 + c)) * torch.cos(xx / (5 + c)) for c in range(C)])


def exact_denoiser(clean_canvas, noise_canvas):
    def f(xw, s, pos):
        y, x = pos; h, w = xw.shape[1:]
        return noise_canvas[:, y:y + h, x:x + w] - clean_canvas[:, y:y + h, x:x + w]
    return f


def test_window_starts_cover_everything():
    for size in (64, 100, 160, 272, 288):
        for off in (0, 24):
            st = S.window_starts(size, 64, 48, off)
            cov = torch.zeros(size)
            for s in st:
                cov[s:s + 64] = 1
            assert cov.all(), (size, off, st)
            assert st[0] == 0 and st[-1] == size - 64 or size <= 64


def test_global_noise_is_position_only():
    a = S.global_noise(4, 0, 0, 96, 96, seed=3, device="cpu")
    b = S.global_noise(4, 40, 50, 30, 20, seed=3, device="cpu")
    assert torch.equal(a[:, 40:70, 50:70], b)


def test_exact_model_reproduces_clean_latent_and_pins():
    C, m, blk = 4, 16, 96
    H = W = blk + 2 * m
    clean = smooth_field(C, 0, 0, H, W)
    noise = S.global_noise(C, 0, 0, H, W, seed=1, device="cpu")
    pw = S.pin_map(H, W, m, {"n": True, "w": True, "nw": True, "ne": True})
    x0, evals = S.sample_canvas(exact_denoiser(clean, noise), noise, clean, pw)
    assert torch.allclose(x0, clean, atol=1e-4), float((x0 - clean).abs().max())
    assert evals > 0


def test_neighbouring_blocks_agree_on_shared_edge():
    """Draw block A, then block B to its right pinned to A: B's canvas over A's area equals A."""
    C, m, blk = 4, 16, 96
    H = W = blk + 2 * m
    world = smooth_field(C, -m, -m, H, blk * 2 + 2 * m)
    noiseA = S.global_noise(C, -m, -m, H, W, seed=2, device="cpu")
    cleanA = world[:, :, :W]
    xA, _ = S.sample_canvas(exact_denoiser(cleanA, noiseA), noiseA, torch.zeros_like(cleanA), torch.zeros(H, W))
    # B's canvas starts at x = blk - m; its west margin overlaps A's block
    noiseB = S.global_noise(C, -m, blk - m, H, W, seed=2, device="cpu")
    cleanB = world[:, :, blk:blk + W]
    pin_clean = torch.zeros_like(cleanB)
    pin_clean[:, :, :m] = xA[:, :, blk:blk + m]
    pw = S.pin_map(H, W, m, {"w": True})
    xB, _ = S.sample_canvas(exact_denoiser(cleanB, noiseB), noiseB, pin_clean, pw)
    # the overlap noise must be identical (global field) and the fully pinned part identical
    assert torch.equal(noiseA[:, :, blk:blk + m], noiseB[:, :, :m])
    full = pw[m:H - m, :m] >= 0.999
    assert torch.allclose(xB[:, m:H - m, :m][:, full], xA[:, m:H - m, blk:blk + m][:, full], atol=1e-5)


def test_pin_map_shape_and_ramp():
    pw = S.pin_map(128, 128, 16, {"w": True}, strip=8)
    row = pw[64, :16]
    assert row[0] == 1 and row[7] == 1 and row[15] < 0.2, row
    assert pw[64, 16:].abs().max() == 0
    assert pw[:16, 16:112].abs().max() == 0


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f(); print("ok", n)
