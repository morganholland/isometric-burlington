"""The tiles job: drawn blocks + render alpha -> pyramid on R2 + manifest."""
import io, json, sys, types
from pathlib import Path
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))


def png(im):
    b = io.BytesIO(); im.save(b, "PNG"); return b.getvalue()


def setup(monkeypatch, tmp_path, blocks, drawn_missing=()):
    import job, tiles
    B = 4096
    store, puts = {}, {}
    for bx, by in blocks:
        r = Image.new("RGBA", (B, B), (10, 20, 30, 255))
        r.paste((0, 0, 0, 0), (0, 0, B, 1024))                      # top quarter outside the map
        store[f"renders/a1/{bx}_{by}.png"] = png(r)
        if (bx, by) not in drawn_missing:
            store[f"drawn/map/a1/{bx}_{by}.png"] = png(Image.new("RGB", (B, B), (200, 100, 50)))

    def get(k):
        if k not in store:
            raise RuntimeError("An error occurred (NoSuchKey)")
        return store[k]

    def put_dir(local, prefix, cache="no-cache"):
        n = 0
        for p in Path(local).rglob("*.webp"):
            puts[f"{prefix}/{p.relative_to(local).as_posix()}"] = cache; n += 1
        return n
    monkeypatch.setattr(job, "r2", types.SimpleNamespace(get_bytes=get, put_dir=put_dir,
                                                       put_bytes=lambda k, d, ct=None, cache=None: store.__setitem__(k, d)))
    monkeypatch.setattr(tiles, "set_cors", lambda: None)
    real = json.load(open(ROOT / "data" / "grid.json"))
    real["angles"][1]["blocks"] = [list(b) for b in blocks]
    monkeypatch.setattr(job.json, "load", lambda f: real)
    return job, store, puts


def test_tiles_cut_masked_and_manifest_updated(monkeypatch, tmp_path):
    job, store, puts = setup(monkeypatch, tmp_path, [(0, 0), (4096, 0)])
    store["manifest.json"] = json.dumps({"minZoom": -2, "maxZoom": 0, "angles": ["map-v1", None, None, None]}).encode()
    r = job.run_tiles({"angle": 1, "kind": "map-v1", "min_zoom": -2}, tmp_path, open(tmp_path / "log", "w"))
    assert r["native_tiles"] == 2 * 8 * 6                      # top 2 of 8 tile rows are clear: skipped
    assert "map-v1/a1/0/0/2.webp" in puts and "map-v1/a1/0/0/0.webp" not in puts
    assert "map-v1/a1/-2/0/0.webp" in puts and all("immutable" in c for c in puts.values())
    assert json.loads(store["manifest.json"])["angles"] == ["map-v1", "map-v1", None, None]
    assert not (tmp_path / "tiles").exists()


def test_tiles_refuse_a_half_drawn_angle(monkeypatch, tmp_path):
    job, store, puts = setup(monkeypatch, tmp_path, [(0, 0), (4096, 0)], drawn_missing=[(4096, 0)])
    with pytest.raises(RuntimeError, match="1 drawn blocks missing"):
        job.run_tiles({"angle": 1, "kind": "map-v1", "min_zoom": -1}, tmp_path, open(tmp_path / "log", "w"))
    assert "manifest.json" not in store
