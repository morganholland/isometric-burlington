"""Open-lake pinning for the drawing step."""
import math, sys
from pathlib import Path
import numpy as np
import torch
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
sys.path.insert(0, str(ROOT / "pipeline" / "remote"))
import water as W  # noqa: E402


def test_constants_match_the_pipeline():
    import geo, teacher
    assert (W.PIXEL_M, W.ELEV_DEG, W.HEADINGS) == (geo.PIXEL_M, geo.ELEV_DEG, geo.HEADINGS)
    assert W.LAKE_ENU_M == teacher.LAKE_ENU_M


def test_lake_level_matches_teacher_at_a_frame():
    import geo, teacher
    for a in range(4):
        x0, y0 = 12800, -6400
        lv = W.lake_level_cells(a, x0, y0, 4, 4)
        cx, cy = x0 + 0.5 * W.LAT, y0 + 0.5 * W.LAT
        el, h = math.radians(geo.ELEV_DEG), math.radians(geo.HEADINGS[a])
        r_, f_ = cx * geo.PIXEL_M, -cy * geo.PIXEL_M / math.sin(el)
        e, n = r_ * math.cos(h) + f_ * math.sin(h), -r_ * math.sin(h) + f_ * math.cos(h)
        assert abs(lv[0, 0] - teacher.lake_level(e, n)) < 1e-9


def test_heights_decode_matches_teacher(tmp_path):
    import teacher
    from PIL import Image
    v = np.array([[20000, 20012], [19970, 0]])
    a = np.zeros((2, 2, 4), np.uint8)
    a[..., 0], a[..., 1], a[..., 2], a[..., 3] = v >> 16, (v >> 8) & 255, v & 255, 255
    a[1, 1, 3] = 0
    Image.fromarray(a, "RGBA").save(tmp_path / "h.png")
    np.testing.assert_array_equal(np.isnan(W.heights_from_png(a)), np.isnan(teacher.heights(str(tmp_path / "h.png"))))
    np.testing.assert_allclose(np.nan_to_num(W.heights_from_png(a)), np.nan_to_num(teacher.heights(str(tmp_path / "h.png"))))


def test_shore_stays_free_and_open_lake_is_pinned():
    H = Wd = 64
    px = np.zeros((H * W.LAT, Wd * W.LAT), bool)
    px[:, 20 * W.LAT:] = True                         # land: columns 0..19, lake: 20..
    w = W.pin_weights(px).numpy()
    assert (w[:, :20] == 0).all()                     # land never pinned
    assert (w[:, 20:20 + W.SHORE_FREE] == 0).all()    # shore band drawn by the model
    assert (w[:, 20 + W.SHORE_FREE:20 + W.SHORE_FREE + W.RAMP] > 0).all()
    assert (w[:, 20 + W.SHORE_FREE + W.RAMP:] == 1).all()
    ramp = w[10, 20 + W.SHORE_FREE - 1:20 + W.SHORE_FREE + W.RAMP + 1]
    assert (np.diff(ramp) >= 0).all() and ramp[0] == 0 and ramp[-1] == 1


def test_all_lake_canvas_is_fully_pinned_and_small_ponds_are_not():
    assert (W.pin_weights(np.ones((48 * W.LAT, 48 * W.LAT), bool)).numpy() == 1).all()
    pond = np.zeros((48 * W.LAT, 48 * W.LAT), bool); pond[16 * W.LAT:24 * W.LAT, 16 * W.LAT:24 * W.LAT] = True
    assert W.pin_weights(pond).max() == 0             # 8 cells across: all shore, none pinned


def test_boats_are_lake_but_a_breakwater_is_land():
    n = 64
    px = np.ones((n * W.LAT, n * W.LAT), bool)
    for y, x in ((10, 10), (12, 40), (50, 20)):        # boats: 2x2-cell dry specks
        px[y * W.LAT:(y + 2) * W.LAT, x * W.LAT:(x + 2) * W.LAT] = False
    w = W.pin_weights(px).numpy()
    assert (w == 1).all()                              # specks do not punch holes in the pin
    px[30 * W.LAT:31 * W.LAT, 5 * W.LAT:60 * W.LAT] = False   # a breakwater: 1 cell wide, 55 long
    w = W.pin_weights(px).numpy()
    assert (w[28:33, 10:55] == 0).all() and w[2, 32] == 1


def test_recolour_only_touches_water_and_keeps_boats():
    img = np.full((256, 256, 3), 200, np.uint8); img[:, 128:] = (51, 68, 93)
    img[:, 200:] = (90, 100, 110)                      # haze / an imagery seam over the far lake
    img[100:104, 150:156] = 250                        # a boat
    m = np.zeros((256, 256), bool); m[:, 128:] = True
    out = W.recolour(img, m)
    assert (out[:, :128] == 200).all()
    to = tuple(W.WATER_TO.astype(np.uint8))
    assert tuple(out[5, 160]) == to and tuple(out[5, 240]) == to and tuple(out[5, 199]) == to
    assert tuple(out[101, 152]) == (250, 250, 250)


def test_imagery_seam_in_the_lake_is_lake_but_low_waterfront_land_is_not():
    n = 96
    h = np.zeros((n * W.LAT, n * W.LAT))
    h[:, 800:816] = np.linspace(0, -1.2, 16)[None]     # a seam: the surface steps down 1.2 m over a cell
    h[:, 816:] = -1.2
    lv = np.full((n, n), -0.3)
    px, band = W.water_pixels(h, lv), W.lake_band(h, lv)
    assert not px[:, 803].any()                        # by itself the flatness rule breaks the lake here
    w, paint = W.plan(px, None, band)
    assert (w.numpy() == 1).all() and paint[:, 50].all()
    # a broad lot at lake level whose mesh is bumpy (not flat), beside the lake: stays land
    rng = np.random.default_rng(0)
    h2 = np.zeros_like(h); h2[:, :40 * W.LAT] = rng.normal(0, 0.2, (n * W.LAT, 40 * W.LAT)).clip(-1, 0.5)
    px2, band2 = W.water_pixels(h2, lv), W.lake_band(h2, lv)
    w2, _ = W.plan(px2, None, band2)
    assert (w2.numpy()[:, :40 + W.SHORE_FREE] == 0).all()


def test_tiled_encode_matches_whole_image_encode():
    rng = np.random.default_rng(1)
    H, Wd = 150, 100                                   # not multiples of the tile core
    img = rng.integers(0, 255, (H * W.LAT, Wd * W.LAT, 3), dtype=np.uint8)
    enc = lambda t: F.avg_pool2d(t[None], W.LAT)[0]
    weight = torch.ones(H, Wd)
    got = W.encode_tiles(enc, img, weight)
    want = enc(torch.from_numpy(img).permute(2, 0, 1).float() / 255.0)
    torch.testing.assert_close(got, want)
    weight[:, :70] = 0                                 # only tiles touching pinned cells are encoded
    calls = []
    W.encode_tiles(lambda t: calls.append(t.shape) or enc(t), img, weight)
    assert len(calls) == 3                            # x tiles start at 0 and 36: only the second is wet


def test_real_harbour_block_if_available():
    """Block a0 0_0 (Burlington harbour): open lake pinned, waterfront drawn."""
    from PIL import Image
    p = Path("/tmp/claude-0/-home-claude/947987d5-f133-5f09-bc6c-9548a41bac12/scratchpad/smoke/h0_0.png")
    if not p.exists():
        return
    h = W.heights_from_png(np.asarray(Image.open(p).convert("RGBA")))
    w = W.pin_weights(W.water_pixels(h, W.lake_level_cells(0, 0, 0, 256, 256))).numpy()
    assert w[200:, :].mean() > 0.95      # the open lake at the bottom, where the city was invented
    assert w[:60, :].max() == 0          # the town along the top


def test_map_edge_in_the_lake_stays_pinned_and_its_margin_is_plain_lake():
    n, m = 288, 16                                     # canvas cells, margin
    px = np.ones((n * W.LAT, n * W.LAT), bool)
    miss = np.zeros_like(px)
    px[:, (n - m) * W.LAT:] = False; miss[:, (n - m) * W.LAT:] = True     # no block to the east
    w, fill = W.plan(px, miss)
    w = w.numpy()
    assert (w[m:n - m, m:n - m] == 1).all()            # the whole block, right up to the missing edge
    assert fill[:, n - m:].all() and (w[:, n - m:] == 1).all()
    img = W.recolour(np.full((n * W.LAT, n * W.LAT, 3), 60, np.uint8), px, fill)
    assert tuple(img[5, -1]) == tuple(W.WATER_TO.astype(np.uint8))


def test_map_edge_on_land_is_left_alone():
    n, m = 288, 16
    px = np.zeros((n * W.LAT, n * W.LAT), bool)
    miss = np.zeros_like(px); miss[:, (n - m) * W.LAT:] = True
    w, fill = W.plan(px, miss)
    assert w.max() == 0 and not fill.any()


def test_hole_in_the_far_lake_is_not_shore():
    n = 96
    px = np.ones((n * W.LAT, n * W.LAT), bool); miss = np.zeros_like(px)
    px[40 * W.LAT:44 * W.LAT, 40 * W.LAT:44 * W.LAT] = False; miss[40 * W.LAT:44 * W.LAT, 40 * W.LAT:44 * W.LAT] = True
    w, fill = W.plan(px, miss)
    assert (w.numpy() == 1).all() and fill[40:44, 40:44].all()
