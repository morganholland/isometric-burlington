"""Canvas filling where the map ends, and the fitted lake level."""
import sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline" / "remote"))
import canvas as Cv  # noqa: E402
import water as W  # noqa: E402


def test_mirror_fills_only_missing_slots_by_reflection():
    m, B = 4, 8
    arr = np.zeros((2 * m + B, 2 * m + B, 1), np.int32)
    arr[m:m + B, m:m + B, 0] = np.arange(B * B).reshape(B, B)          # the block
    arr[m:m + B, m + B:, 0] = -7                                        # east neighbour present
    present = {(1, 0): True}
    out = Cv.mirror_missing(arr, present, m, B)
    assert (out[m:m + B, m + B:] == -7).all()                           # untouched
    np.testing.assert_array_equal(out[m:m + B, :m, 0], arr[m:m + B, m:2 * m, 0][:, ::-1])    # west mirrored
    np.testing.assert_array_equal(out[:m, m:m + B, 0], arr[m:2 * m, m:m + B, 0][::-1])       # north mirrored
    np.testing.assert_array_equal(out[:m, :m, 0], arr[m:2 * m, m:2 * m, 0][::-1, ::-1])      # corner
    assert out[m + 1, m - 1, 0] == arr[m + 1, m, 0]                     # pixel next to the edge = edge pixel


def test_pushpull_fills_holes_and_keeps_known_pixels():
    rgb = np.zeros((64, 64, 3), np.uint8); rgb[:, :32] = (200, 50, 50); rgb[:, 32:] = (50, 50, 200)
    alpha = np.full((64, 64), 255, np.uint8); alpha[20:40, 10:60] = 0
    out = Cv.pushpull_fill(rgb, alpha)
    assert (out[alpha > 0] == rgb[alpha > 0]).all()
    assert tuple(out[30, 12]) [0] > 120 and tuple(out[30, 57])[2] > 120          # left reddish, right bluish
    assert not (out[alpha == 0] == 0).all(axis=-1).any()                          # no black left


def test_fit_level_finds_a_lake_below_the_prediction_but_ignores_a_flat_lot_above():
    n = 64
    lv = np.full((n, n), -8.3)
    h = np.full((n * 16, n * 16), -9.8)                                           # lake 1.5 m low
    h[:, :300] = 20.0                                                             # land
    assert W.lake_band(h, lv)[:, 500].all()                                        # below the level: lake
    fitted = W.fit_level(h, lv)
    assert W.lake_band(h, fitted)[:, 500].all()
    lot = np.full((n * 16, n * 16), 30.0); lot[:, 400:] = -8.3 + 3.0              # big flat lot 3 m above
    np.testing.assert_array_equal(W.fit_level(lot, lv), lv)
    harbour = np.zeros((n * 16, n * 16)); harbour[:, :300] = 15.0                 # lake where predicted
    assert W.lake_band(harbour, W.fit_level(harbour, np.full((n, n), -0.3)))[:, 500].all()


def test_real_far_lake_block_is_pinned_after_fitting_if_available():
    from PIL import Image
    p = Path("/tmp/claude-0/-home-claude/947987d5-f133-5f09-bc6c-9548a41bac12/scratchpad/map/h_a3_-16384_-20480.png")
    if not p.exists():
        return
    h = W.heights_from_png(np.asarray(Image.open(p).convert("RGBA")))
    lv = W.fit_level(h, W.lake_level_cells(3, -16384, -20480, 256, 256))
    w, _ = W.plan(W.water_pixels(h, lv), np.isnan(h), W.lake_band(h, lv))
    assert (w.numpy()[:30] >= 0.999).mean() > 0.5      # the open lake along the top
