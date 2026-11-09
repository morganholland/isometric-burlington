"""Run one pipeline job described by a JSON file, reporting to R2 under runs/<name>/.

{"type": "render", "name": "render-test-1", "angle": 0, "centers": [[44.4759, -73.2121]], "n": 2, "size": 1024}
"""
import json, os, subprocess, sys, time, traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import geo, r2  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def frames_around(angle, lat, lon, n, size, h=35.0):
    e, nn, u = geo.lla_to_enu(lat, lon, h)
    x, y = geo.enu_to_px(angle, float(e), float(nn), float(u))
    x0 = int(round((x - n * size / 2) / geo.FRAME)) * geo.FRAME
    y0 = int(round((y - n * size / 2) / geo.FRAME)) * geo.FRAME
    return [[x0 + i * size, y0 + j * size] for j in range(n) for i in range(n)]


def run_render(job, out, log):
    frames = []
    for lat, lon in job["centers"]:
        frames += frames_around(job["angle"], lat, lon, job.get("n", 2), job.get("size", 1024))
    (out / "frames.json").write_text(json.dumps(frames))
    cmd = ["node", "pipeline/render/render.mjs", "--angle", str(job["angle"]), "--frames", str(out / "frames.json"),
           "--out", str(out / "frames"), "--size", str(job.get("size", 1024))]
    if job.get("errorTarget"):
        cmd += ["--errorTarget", str(job["errorTarget"])]
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=job.get("timeout", 3 * 3600))
    log.write(p.stdout + p.stderr)
    if p.returncode:
        raise RuntimeError(f"render exited {p.returncode}")
    return {"frames": len(frames), "rendered": len(list((out / "frames").glob("*_*.png"))) // 2}


def main(path):
    job = json.loads(Path(path).read_text())
    name = job["name"]
    out = ROOT / "runs" / name
    out.mkdir(parents=True, exist_ok=True)
    status = {"name": name, "type": job["type"], "started": time.time(), "state": "running",
              "commit": os.environ.get("GITHUB_SHA"), "run": os.environ.get("GITHUB_RUN_ID")}
    r2.put_json(f"runs/{name}/status.json", status)
    log = open(out / "log.txt", "w")
    try:
        result = {"render": run_render}[job["type"]](job, out, log)
        status.update(state="done", result=result)
    except Exception:
        status.update(state="failed", error=traceback.format_exc()[-3000:])
    finally:
        log.close()
        status["finished"] = time.time()
        status["minutes"] = round((status["finished"] - status["started"]) / 60, 1)
        n = r2.put_dir(out, f"runs/{name}")
        status["files"] = n
        r2.put_json(f"runs/{name}/status.json", status)
        print(json.dumps({k: v for k, v in status.items() if k != "error"}), status.get("error", ""))
    if status["state"] != "done":
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1])
