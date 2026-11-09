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


def run_probe(job, out, log):
    import requests
    res = {}
    # OpenAI: which image models this key can use (no image is generated, no cost)
    r = requests.get("https://api.openai.com/v1/models", headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"}, timeout=30)
    res["openai_status"] = r.status_code
    if r.ok:
        res["openai_image_models"] = sorted(m["id"] for m in r.json()["data"] if "image" in m["id"] or "dall" in m["id"])
    else:
        res["openai_error"] = r.text[:300]
    # Vast.ai: balance and current H100 offers (read only)
    vh = {"Authorization": f"Bearer {os.environ['VAST_API_KEY']}"}
    u = requests.get("https://console.vast.ai/api/v0/users/current/", headers=vh, timeout=30)
    res["vast_status"] = u.status_code
    if u.ok:
        res["vast_credit"] = u.json().get("credit")
    q = {"gpu_name": {"in": ["H100 SXM", "H100 PCIE", "H100 NVL"]}, "rentable": {"eq": True}, "verified": {"eq": True},
         "num_gpus": {"eq": 1}, "reliability2": {"gte": 0.98}, "disk_space": {"gte": 150}, "inet_down": {"gte": 500},
         "order": [["dph_total", "asc"]], "type": "on-demand", "limit": 15}
    o = requests.post("https://console.vast.ai/api/v0/bundles/", headers=vh, json=q, timeout=30)
    if o.ok:
        res["vast_h100_offers"] = [{k: x.get(k) for k in ("id", "gpu_name", "dph_total", "reliability2", "inet_down", "geolocation", "cuda_max_good", "disk_space")} for x in o.json().get("offers", [])]
    else:
        res["vast_offers_error"] = o.text[:300]
    # Cesium: does the token reach the Google tiles asset?
    c = requests.get("https://api.cesium.com/v1/assets/2275207/endpoint", params={"access_token": os.environ["CESIUM_ION_TOKEN"]}, timeout=30)
    res["cesium_status"] = c.status_code
    res["cesium_type"] = c.json().get("externalType") if c.ok else c.text[:200]
    log.write(json.dumps(res, indent=1))
    return res


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
        result = {"render": run_render, "probe": run_probe}[job["type"]](job, out, log)
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
