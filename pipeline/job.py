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
    return {"frames": len(frames), "rendered": len([p for p in (out / "frames").glob("*_*.png") if not p.name.endswith(".h.png")]),
            "empty_share": empty_shares(out / "frames")}


def empty_shares(d):
    """Share of fully transparent pixels per frame: inside the map area it should be ~0."""
    import numpy as np
    from PIL import Image
    res = {}
    for p in sorted(Path(d).glob("*_*.png")):
        if p.name.endswith(".h.png"):
            continue
        a = np.asarray(Image.open(p).getchannel("A"))
        res[p.stem] = round(float((a == 0).mean()), 4)
    return res


def run_teacher_test(job, out, log):
    """Render named spots, redraw each with every (model, look), check every drawing."""
    from concurrent.futures import ThreadPoolExecutor
    from PIL import Image
    import io
    import teacher
    size = 1024
    spots = job["spots"]
    frames = []
    for s in spots:
        e, n, u = geo.lla_to_enu(s["lat"], s["lon"], s.get("h", 5.0))
        s["lake_level"] = teacher.lake_level(float(e), float(n))
        x, y = geo.enu_to_px(job.get("angle", 0), float(e), float(n), float(u))
        s["frame"] = [int(round((x - size / 2) / 64)) * 64, int(round((y - size / 2) / 64)) * 64]
        frames.append(s["frame"])
    (out / "frames.json").write_text(json.dumps(frames))
    p = subprocess.run(["node", "pipeline/render/render.mjs", "--angle", str(job.get("angle", 0)), "--frames", str(out / "frames.json"),
                        "--out", str(out / "renders"), "--size", str(size)], cwd=ROOT, capture_output=True, text=True, timeout=3600)
    log.write(p.stdout + p.stderr)
    tasks = []
    empties = empty_shares(out / "renders")
    for s in spots:
        name = f"{s['frame'][0]}_{s['frame'][1]}"
        if not (out / "renders" / f"{name}.png").exists():
            s["error"] = "render incomplete"; continue
        s["empty"] = empties.get(name)
        if s["empty"] is None or s["empty"] > 0.02:   # never pay to redraw a render with holes
            s["error"] = f"render has holes ({s['empty']})"; continue
        for model in job["models"]:
            for look in job["looks"]:
                tasks.append((s, name, model, look))
    (out / "drawn").mkdir(exist_ok=True)
    usage = []

    def one(t):
        s, name, model, look = t
        rgba = Image.open(out / "renders" / f"{name}.png")
        rgb = Image.new("RGB", rgba.size, (0, 0, 0)); rgb.paste(rgba, mask=rgba.getchannel("A"))
        buf = io.BytesIO(); rgb.save(buf, "PNG")
        try:
            img, u = teacher.call_openai(model, buf.getvalue(), teacher.STYLES[look])
        except Exception as e:  # noqa: BLE001
            return {"spot": s["id"], "model": model, "look": look, "error": str(e)[:300]}
        fn = f"{s['id']}__{model}__{look}.png"
        (out / "drawn" / fn).write_bytes(img)
        hm = teacher.heights(str(out / "renders" / f"{name}.h.png"))
        chk = teacher.check(rgb, Image.open(io.BytesIO(img)), hm, s["lake_level"])
        usage.append(u)
        return {"spot": s["id"], "model": model, "look": look, "file": fn, "check": chk, "usage": u}

    with ThreadPoolExecutor(4) as ex:
        results = list(ex.map(one, tasks))
    (out / "results.json").write_text(json.dumps({"spots": spots, "results": results}, indent=1))
    ok = sum(1 for r in results if r.get("check", {}).get("pass"))
    return {"calls": len(tasks), "drawn": sum(1 for r in results if "file" in r), "passed_checks": ok,
            "errors": [r["error"] for r in results if "error" in r][:5]}


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
        result = {"render": run_render, "probe": run_probe, "teacher_test": run_teacher_test}[job["type"]](job, out, log)
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
