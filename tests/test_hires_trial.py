"""Offline unit tests for seam-cut stitching, multi-image style-ref OpenAI edits, and Stage 1 hires_trial."""
import base64
import io
import json
import sys
import types
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))

import hires_trial  # noqa: E402
import seam  # noqa: E402
import teacher  # noqa: E402


def _png_bytes(im):
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def test_seam_avoids_mismatched_object_and_preserves_interiors():
    # Two 80x100 tiles with 40px overlap. Both agree everywhere except a bright red block on the left half
    # of the overlap (x in [0, 18)) and a blue block on the right half (x in [24, 40)), leaving a clean
    # matching corridor down x in [18, 24). The seam must thread that corridor!
    a = np.full((80, 100, 3), 120, dtype=np.uint8)
    b = np.full((80, 100, 3), 120, dtype=np.uint8)
    # Distinctive non-overlap interiors
    a[:, :60] = (10, 20, 30)
    b[:, 40:] = (200, 210, 220)
    # Disagreements inside overlap: a[:, 60:100] overlaps b[:, 0:40]
    a[:, 60:78] = (255, 0, 0)    # disagrees on left side of overlap
    b[:, 24:40] = (0, 0, 255)    # disagrees on right side of overlap
    sx = seam._seam_x(a[:, 60:].astype(np.float32), b[:, :40].astype(np.float32), margin=4)
    assert np.all((sx >= 18) & (sx <= 23)), f"seam drifted into mismatch: min={sx.min()} max={sx.max()}"

    stitched = seam.stitch_horizontal(Image.fromarray(a), Image.fromarray(b), overlap=40, feather=4)
    arr = np.asarray(stitched)
    assert arr.shape == (80, 160, 3)
    assert np.array_equal(arr[:, :60], a[:, :60])
    assert np.array_equal(arr[:, 100:], b[:, 40:])


def test_seam_grid_2x2_dimensions_and_crossfade_mode():
    tiles = [[Image.new("RGB", (64, 64), (30 * r + 20, 40 * c + 20, 100)) for c in (0, 1)] for r in (0, 1)]
    out_cut = seam.stitch_grid(tiles, overlap_x=16, overlap_y=16, feather=4, crossfade=False)
    out_fade = seam.stitch_grid(tiles, overlap_x=16, overlap_y=16, feather=4, crossfade=True)
    assert out_cut.size == (112, 112)
    assert out_fade.size == (112, 112)


def test_teacher_estimate_cost_and_style_ref_multipart(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    seen = {}

    def fake_post(url, headers=None, files=None, data=None, timeout=None):
        seen["url"] = url
        seen["files"] = files
        seen["data"] = data
        b64 = base64.b64encode(_png_bytes(Image.new("RGB", (16, 16), (50, 80, 110)))).decode()
        return types.SimpleNamespace(
            ok=True,
            status_code=200,
            json=lambda: {
                "data": [{"b64_json": b64}],
                "usage": {
                    "input_tokens": 2200,
                    "input_tokens_details": {"text_tokens": 200, "image_tokens": 2000},
                    "output_tokens": 5000,
                },
            },
        )

    monkeypatch.setattr(teacher.requests, "post", fake_post)
    img_bytes, usage = teacher.call_openai(
        "gpt-image-2.6-sunburst",
        b"render-bytes",
        teacher.STYLES["builder_hires"],
        quality="high",
        size="2880x2880",
        style_ref_png=b"style-bytes",
    )
    assert Image.open(io.BytesIO(img_bytes)).size == (16, 16)
    assert isinstance(seen["files"], list) and len(seen["files"]) == 2
    assert [k for k, _ in seen["files"]] == ["image[]", "image[]"]
    assert "style reference" in seen["data"]["prompt"]
    assert seen["data"]["size"] == "2880x2880"
    # 200*5/1e6 + 2000*8/1e6 + 5000*30/1e6 = 0.001 + 0.016 + 0.150 = 0.167
    assert teacher.estimate_cost(usage) == pytest.approx(0.167, rel=1e-6)


def test_hires_trial_end_to_end_style_ref_seam_and_budget_cap(monkeypatch, tmp_path):
    # Mock renderer, R2 live tiles, OpenAI edits, and checks to test the full Stage 1 job offline
    def fake_render(cmd, **kw):
        assert "--pixelM" in cmd and cmd[cmd.index("--pixelM") + 1] == "0.115"
        out_dir = Path(cmd[cmd.index("--out") + 1])
        out_dir.mkdir(parents=True, exist_ok=True)
        for x, y in json.loads(Path(cmd[cmd.index("--frames") + 1]).read_text()):
            Image.new("RGBA", (128, 128), (110, 140, 110, 255)).save(out_dir / f"{x}_{y}.png")
            Image.new("RGBA", (128, 128), (0, 80, 0, 255)).save(out_dir / f"{x}_{y}.h.png")
        return types.SimpleNamespace(stdout="rendered ok\n", stderr="", returncode=0)

    monkeypatch.setattr(hires_trial.subprocess, "run", fake_render)
    live_tile = io.BytesIO()
    Image.new("RGB", (512, 512), (40, 90, 140)).save(live_tile, "WEBP")
    monkeypatch.setattr(hires_trial.r2, "get_bytes", lambda key: live_tile.getvalue())
    monkeypatch.setattr(teacher, "check", lambda r, d, hm, lv: {"pass": True, "reasons": [], "shift": 0.1})

    call_log = []

    def fake_openai(model, render_png, prompt, quality="high", size="1024x1024", deadline=None, style_ref_png=None):
        call_log.append({"size": size, "has_ref": style_ref_png is not None})
        w, h = map(int, size.split("x"))
        # keep test fast with scaled-down valid PNG matching aspect
        im = Image.new("RGB", (min(w, 128), min(h, 128)), (90, 130, 80) if not style_ref_png else (95, 132, 82))
        usage = {
            "input_tokens_details": {"text_tokens": 150, "image_tokens": 1000 + (500 if style_ref_png else 0)},
            "output_tokens": 3500 if size == "128x128" else 6000,
        }
        return _png_bytes(im), usage

    monkeypatch.setattr(teacher, "call_openai", fake_openai)

    job = {
        "name": "trial-test",
        "type": "hires_trial",
        "angle": 0,
        "pixel_m": 0.115,
        "render_size": 128,
        "model": "gpt-image-2.6-sunburst",
        "look": "builder_hires",
        "quality": "high",
        "sizes": ["128x128", "160x160"],
        "seam_size": "160x160",
        "overlap_frac": 0.25,
        "max_calls": 10,
        "spots": [
            {"id": "church-st", "label": "Church Street", "lat": 44.4780, "lon": -73.2127, "h": 35},
            {"id": "waterfront", "label": "Waterfront", "lat": 44.4775, "lon": -73.2205, "h": 2},
        ],
        "seam_center": {"label": "Downtown 2x2", "lat": 44.4772, "lon": -73.2131, "h": 33},
    }
    out = tmp_path / "out"
    out.mkdir()
    with open(tmp_path / "log.txt", "w") as log:
        summary = hires_trial.run_hires_trial(job, out, log)

    # 2 spots * 2 sizes + 4 seam tiles = 8 calls (strictly <= max_calls=10)
    assert summary["calls"] == 8
    assert summary["passed"] == 8
    assert summary["total_usd"] > 0
    # First call (Spot 0 largest size) has no style_ref; every subsequent call receives the style_ref!
    assert call_log[0] == {"size": "160x160", "has_ref": False}
    assert all(c["has_ref"] for c in call_log[1:])
    assert (out / "style_ref.png").exists()
    assert (out / "results.json").exists()
    review = (out / "review.html").read_text()
    assert "High-Resolution Sharpness Showdown" in review
    assert "seam_cut_crop.webp" in review and "seam_fade_crop.webp" in review
    assert "church-st_160x160.webp" in review and "waterfront_live.webp" in review


def test_hires_trial_strict_budget_cap_never_exceeded(monkeypatch, tmp_path):
    def fake_render(cmd, **kw):
        out_dir = Path(cmd[cmd.index("--out") + 1])
        out_dir.mkdir(parents=True, exist_ok=True)
        for x, y in json.loads(Path(cmd[cmd.index("--frames") + 1]).read_text()):
            Image.new("RGBA", (64, 64), (100, 100, 100, 255)).save(out_dir / f"{x}_{y}.png")
            Image.new("RGBA", (64, 64), (0, 80, 0, 255)).save(out_dir / f"{x}_{y}.h.png")
        return types.SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(hires_trial.subprocess, "run", fake_render)
    monkeypatch.setattr(hires_trial.r2, "get_bytes", lambda key: (_ for _ in ()).throw(RuntimeError("no r2")))
    monkeypatch.setattr(teacher, "check", lambda r, d, hm, lv: {"pass": False, "reasons": ["moved"]})
    n = {"calls": 0}

    def fake_openai(*a, **kw):
        n["calls"] += 1
        return _png_bytes(Image.new("RGB", (64, 64), (1, 2, 3))), {"output_tokens": 1000}

    monkeypatch.setattr(teacher, "call_openai", fake_openai)
    job = {
        "name": "cap-test",
        "type": "hires_trial",
        "render_size": 64,
        "sizes": ["64x64", "96x96"],
        "seam_size": "96x96",
        "max_calls": 3,
        "spots": [
            {"id": "a", "label": "A", "lat": 44.478, "lon": -73.212, "h": 35},
            {"id": "b", "label": "B", "lat": 44.477, "lon": -73.213, "h": 30},
        ],
        "seam_center": {"label": "S", "lat": 44.477, "lon": -73.213, "h": 30},
    }
    out = tmp_path / "out"
    out.mkdir()
    with open(tmp_path / "log.txt", "w") as log:
        summary = hires_trial.run_hires_trial(job, out, log)
    assert n["calls"] == 3 and summary["calls"] == 3
