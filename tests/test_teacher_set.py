"""Offline tests of run_teacher_set: pairs reach R2 as they pass, refusals cost nothing, time is respected."""
import json, sys, types
from pathlib import Path
import numpy as np
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))


def setup(monkeypatch, tmp_path, outcomes):
    """outcomes: callable(call_no) -> 'pass' | 'fail' | 'refused' | 'error'."""
    import job, sample, teacher
    store = {}
    monkeypatch.setattr(job, "r2", types.SimpleNamespace(put_bytes=lambda k, d, ct=None: store.__setitem__(k, d)))
    monkeypatch.setattr(sample, "frames", lambda a, n, seed=1: [[i * 1024, 0] for i in range(n)])

    def fake_render(cmd, **kw):
        d = Path(cmd[cmd.index("--out") + 1]); d.mkdir(parents=True, exist_ok=True)
        for x, y in json.loads(Path(cmd[cmd.index("--frames") + 1]).read_text()):
            Image.new("RGBA", (8, 8), (90, 120, 90, 255)).save(d / f"{x}_{y}.png")
            Image.new("RGB", (8, 8)).save(d / f"{x}_{y}.h.png")
        return types.SimpleNamespace(stdout="", stderr="", returncode=0)
    monkeypatch.setattr(job.subprocess, "run", fake_render)
    monkeypatch.setattr(teacher, "heights", lambda p: np.zeros((8, 8)))
    monkeypatch.setattr(teacher, "water_mask", lambda hm, lv: np.zeros((8, 8), bool))
    monkeypatch.setattr(teacher, "lake_level", lambda e, n: 29.0)
    n = {"calls": 0}

    def fake_call(model, png, prompt, deadline=None):
        n["calls"] += 1
        o = outcomes(n["calls"])
        if o == "refused":
            raise teacher.NotBilled("OpenAI 429: rate limit")
        if o == "quota":
            raise teacher.OutOfQuota("OpenAI 429: insufficient quota")
        if o == "error":
            raise RuntimeError("OpenAI 500")
        b = __import__("io").BytesIO(); Image.new("RGB", (8, 8), (1, 2, 3) if o == "pass" else (9, 9, 9)).save(b, "PNG")
        return b.getvalue(), {}
    monkeypatch.setattr(teacher, "call_openai", fake_call)
    monkeypatch.setattr(teacher, "check", lambda r, t, hm, lv: {"pass": t.getpixel((0, 0)) == (1, 2, 3)})
    out = tmp_path / "out"; out.mkdir()
    return job, store, n, out, open(tmp_path / "log.txt", "w")


def spec(**kw):
    j = {"name": "ts", "angle": 0, "frames": 6, "model": "m", "look": "builder", "tries": 3, "max_calls": 50, "threads": 2}
    j.update(kw); return j


def test_pairs_and_manifest_reach_r2_incrementally(monkeypatch, tmp_path):
    job, store, n, out, log = setup(monkeypatch, tmp_path, lambda c: "pass")
    r = job.run_teacher_set(spec(), out, log)
    assert r["pairs"] == 6
    man = json.loads(store["runs/ts/manifest.json"])
    assert man["partial"] is False and sum(1 for i in man["items"] if i.get("ok")) == 6
    for i in man["items"]:
        assert f"runs/ts/pairs/{i['id']}.target.png" in store and f"runs/ts/pairs/{i['id']}.render.png" in store


def test_refusals_do_not_use_the_call_cap(monkeypatch, tmp_path):
    job, store, n, out, log = setup(monkeypatch, tmp_path, lambda c: "refused" if c % 2 else "pass")
    r = job.run_teacher_set(spec(max_calls=6, threads=1), out, log)
    assert r["calls"] == 6 and r["pairs"] == 6       # 6 refused calls did not count


def test_billed_failures_count_and_cap_holds(monkeypatch, tmp_path):
    job, store, n, out, log = setup(monkeypatch, tmp_path, lambda c: "fail")
    r = job.run_teacher_set(spec(max_calls=7), out, log)
    assert r["calls"] == 7 and n["calls"] == 7 and r["pairs"] == 0


def test_stops_issuing_calls_after_deadline(monkeypatch, tmp_path):
    job, store, n, out, log = setup(monkeypatch, tmp_path, lambda c: "pass")
    monkeypatch.setattr(job, "JOB_START", job.time.time() - 400 * 60)
    r = job.run_teacher_set(spec(), out, log)
    assert n["calls"] == 0 and r["skipped"] == {"out of time": 6}
    assert json.loads(store["runs/ts/manifest.json"])["partial"] is False


def test_partial_manifest_lists_only_uploaded_pairs(monkeypatch, tmp_path):
    seen = []
    job, store, n, out, log = setup(monkeypatch, tmp_path, lambda c: "pass")
    orig = job.r2.put_bytes

    def spy(k, d, ct=None):
        if k.endswith("manifest.json"):
            for i in json.loads(d)["items"]:
                if i.get("ok"):
                    seen.append(f"runs/ts/pairs/{i['id']}.target.png" in store)
        orig(k, d, ct)
    job.r2.put_bytes = spy
    job.run_teacher_set(spec(threads=3), out, log)
    assert seen and all(seen)


def _fake_requests(monkeypatch, responses):
    import teacher, base64
    sleeps, sent = [], []

    def post(url, headers, files, data, timeout):
        sent.append(dict(data))
        code, text, hdr = responses.pop(0)
        body = {"data": [{"b64_json": base64.b64encode(b"img").decode()}]} if code == 200 else {}
        return types.SimpleNamespace(status_code=code, ok=code == 200, text=text, headers=hdr, json=lambda: body)
    monkeypatch.setenv("OPENAI_API_KEY", "x")
    monkeypatch.setattr(teacher.requests, "post", post)
    monkeypatch.setattr(teacher.time, "sleep", sleeps.append)
    return teacher, sleeps, sent


def test_openai_waits_out_rate_limits(monkeypatch):
    teacher, sleeps, _ = _fake_requests(monkeypatch, [(429, "rate limit", {"retry-after": "45"}), (429, "rate limit", {}), (200, "", {})])
    img, _ = teacher.call_openai("m", b"png", "p")
    assert img == b"img" and sleeps[0] >= 45 and len(sleeps) == 2


def test_openai_out_of_quota_stops_at_once(monkeypatch):
    teacher, sleeps, _ = _fake_requests(monkeypatch, [(429, "You exceeded your current quota", {})])
    with pytest.raises(teacher.NotBilled):
        teacher.call_openai("m", b"png", "p")
    assert sleeps == []


def test_openai_drops_unsupported_fidelity(monkeypatch):
    teacher, sleeps, sent = _fake_requests(monkeypatch, [(400, "unknown parameter input_fidelity", {}), (200, "", {})])
    teacher.call_openai("m", b"png", "p")
    assert "input_fidelity" in sent[0] and "input_fidelity" not in sent[1]


def test_failed_upload_is_never_marked_ok(monkeypatch, tmp_path):
    job, store, n, out, log = setup(monkeypatch, tmp_path, lambda c: "pass")
    monkeypatch.setattr(job.time, "sleep", lambda s: None)
    good = job.r2.put_bytes

    def flaky(k, d, ct=None):
        if k.endswith("/0_0.target.png"):
            raise OSError("R2 down")
        good(k, d, ct)
    job.r2.put_bytes = flaky
    r = job.run_teacher_set(spec(), out, log)
    man = json.loads(store["runs/ts/manifest.json"])
    bad = next(i for i in man["items"] if i["id"] == "0_0")
    assert not bad.get("ok") and bad["skip"] == "upload failed" and r["pairs"] == 5


def test_out_of_credit_stops_the_whole_job(monkeypatch, tmp_path):
    job, store, n, out, log = setup(monkeypatch, tmp_path, lambda c: "pass" if c == 1 else "quota")
    r = job.run_teacher_set(spec(threads=1), out, log)
    assert n["calls"] == 2 and r["pairs"] == 1 and r["calls"] == 1
    assert r["skipped"] == {"OpenAI credit ran out": 5}


def test_refusals_do_not_use_up_tries(monkeypatch, tmp_path):
    # each item: 4 refusals then a pass -> still drawn, though tries=3
    job, store, n, out, log = setup(monkeypatch, tmp_path, lambda c: "pass" if c % 5 == 0 else "refused")
    r = job.run_teacher_set(spec(frames=2, threads=1), out, log)
    assert r["pairs"] == 2 and r["calls"] == 2


def test_endless_refusals_end_the_item(monkeypatch, tmp_path):
    job, store, n, out, log = setup(monkeypatch, tmp_path, lambda c: "refused")
    r = job.run_teacher_set(spec(frames=2, threads=1), out, log)
    assert r["skipped"] == {"refused by OpenAI": 2} and r["calls"] == 0 and n["calls"] == 12


def test_bad_image_bytes_do_not_kill_the_run(monkeypatch, tmp_path):
    import teacher
    job, store, n, out, log = setup(monkeypatch, tmp_path, lambda c: "pass")
    monkeypatch.setattr(teacher, "call_openai", lambda *a, **k: (b"not a png", {}))
    r = job.run_teacher_set(spec(frames=2, max_calls=6), out, log)
    assert r["pairs"] == 0 and r["calls"] == 6
    assert json.loads(store["runs/ts/manifest.json"])["partial"] is False


def test_openai_never_waits_past_the_deadline(monkeypatch):
    import time as _t
    teacher, sleeps, _ = _fake_requests(monkeypatch, [(429, "rate limit", {"retry-after": "3600"})])
    with pytest.raises(teacher.NotBilled):
        teacher.call_openai("m", b"png", "p", deadline=_t.time() + 400)
    assert sleeps == []


def test_openai_caps_long_retry_after(monkeypatch):
    teacher, sleeps, _ = _fake_requests(monkeypatch, [(429, "rate limit", {"retry-after": "3600"}), (200, "", {})])
    teacher.call_openai("m", b"png", "p")
    assert sleeps and sleeps[0] <= 310
