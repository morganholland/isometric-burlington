"""Offline tests of run_train against a fake Vast.ai and a fake R2: every path must delete the machine."""
import json, sys, types
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))


class Clock:
    def __init__(self): self.t = 1_800_000_000.0
    def time(self): return self.t
    def sleep(self, s): self.t += s


def setup(monkeypatch, tmp_path, script, create_fails=False):
    """script: list of (minute, state) the box reports, or a callable(machine_no) -> list."""
    import job
    clock = Clock()
    monkeypatch.setattr(job.time, "time", clock.time)
    monkeypatch.setattr(job.time, "sleep", clock.sleep)
    monkeypatch.setattr(job, "JOB_START", clock.t)
    for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(k, "x")
    store = {"runs/p/manifest.json": json.dumps({"angle": 0, "items": [{"id": "1_2", "ok": True, "split": "val"}]}).encode()}
    fake_r2 = types.SimpleNamespace(get_bytes=lambda k: store[k], put_json=lambda k, o: store.__setitem__(k, json.dumps(o).encode()))
    monkeypatch.setattr(job, "r2", fake_r2)
    vast = types.ModuleType("vast")
    vast.created, vast.destroyed, vast.machines = [], [], 0
    vast.credit = lambda: 80.0
    vast.offers = lambda max_dph=3.2: [{"id": i, "dph_total": 2.5, "gpu_name": "H100 SXM"} for i in (11, 12, 13)]

    def create(offer, label, onstart, env):
        if create_fails:
            raise RuntimeError("timeout")
        vast.machines += 1
        iid = 100 + vast.machines
        vast.created.append(iid)
        events = script(vast.machines) if callable(script) else script
        start = clock.t
        orig_get = fake_r2.get_bytes

        def get(k, events=events, start=start, token=env["ATTEMPT"]):
            if k.endswith("box.json"):
                st = None
                for minute, s in events:
                    if clock.t - start >= minute * 60:
                        st = s
                if st is None:
                    raise KeyError(k)
                return json.dumps({"state": st, "attempt": token, "t": clock.t}).encode()
            return orig_get(k)
        fake_r2.get_bytes = get
        return iid
    vast.create = create
    vast.instance = lambda iid: {"actual_status": "running"}
    vast.destroy = lambda iid: vast.destroyed.append(iid) or True
    vast.destroy_labelled = lambda label=None, prefix=None: 0
    monkeypatch.setitem(sys.modules, "vast", vast)
    out = tmp_path / "out"; out.mkdir()
    return job, vast, out, open(tmp_path / "log.txt", "w")


def test_done_deletes_machine(monkeypatch, tmp_path):
    job, vast, out, log = setup(monkeypatch, tmp_path, [(3, "booted"), (8, "downloading data"), (12, "training"), (110, "done")])
    r = job.run_train({"name": "t", "pairs": ["runs/p"]}, out, log)
    assert r["state"] == "done" and vast.destroyed == vast.created == [101]


def test_failed_training_deletes_and_does_not_retry(monkeypatch, tmp_path):
    job, vast, out, log = setup(monkeypatch, tmp_path, [(3, "booted"), (12, "training"), (40, "failed")])
    with pytest.raises(RuntimeError):
        job.run_train({"name": "t", "pairs": ["runs/p"]}, out, log)
    assert vast.destroyed == vast.created == [101]


def test_refused_gpu_moves_to_next_machine(monkeypatch, tmp_path):
    job, vast, out, log = setup(monkeypatch, tmp_path, lambda n: [(3, "refused")] if n == 1 else [(3, "booted"), (10, "training"), (60, "done")])
    r = job.run_train({"name": "t", "pairs": ["runs/p"]}, out, log)
    assert r["state"] == "done" and vast.destroyed == vast.created == [101, 102]


def test_stall_in_install_is_killed_quickly(monkeypatch, tmp_path):
    job, vast, out, log = setup(monkeypatch, tmp_path, [(3, "booted"), (5, "downloading data")])
    with pytest.raises(RuntimeError):
        job.run_train({"name": "t", "pairs": ["runs/p"]}, out, log)
    assert vast.destroyed == vast.created == [101]   # a stall after boot is not retried on a 2nd machine


def test_training_past_deadline_is_deleted(monkeypatch, tmp_path):
    job, vast, out, log = setup(monkeypatch, tmp_path, [(3, "booted"), (8, "training")])
    with pytest.raises(RuntimeError, match="deadline"):
        job.run_train({"name": "t", "pairs": ["runs/p"], "max_hours": 1}, out, log)
    assert vast.destroyed == vast.created == [101]


def test_create_failure_cleans_up_by_label(monkeypatch, tmp_path):
    job, vast, out, log = setup(monkeypatch, tmp_path, [], create_fails=True)
    calls = []
    vast.destroy_labelled = lambda label=None, prefix=None: calls.append(label) or 0
    with pytest.raises(RuntimeError):
        job.run_train({"name": "t", "pairs": ["runs/p"]}, out, log)
    assert len(calls) == 2 and all(c.startswith("iso-t-dl") for c in calls)


def test_overall_cutoff_respected(monkeypatch, tmp_path):
    job, vast, out, log = setup(monkeypatch, tmp_path, [(3, "booted"), (8, "training")])
    with pytest.raises(RuntimeError):
        job.run_train({"name": "t", "pairs": ["runs/p"], "max_hours": 10}, out, log)
    import job as j
    assert j.time.time() - j.JOB_START <= 331 * 60 + 120
