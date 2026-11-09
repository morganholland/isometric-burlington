"""Rent, watch and always delete Vast.ai GPU machines.

Every machine is labelled iso-<name>-dl<deadline epoch>; the reaper deletes anything of ours past
its deadline. Results come back through R2, never through the machine's disk.
"""
import os, time
import requests

API = "https://console.vast.ai/api/v0"
H = lambda: {"Authorization": f"Bearer {os.environ['VAST_API_KEY']}"}
# ai-toolkit's own image: git, OpenCV system libs, torch 2.13 / CUDA 13, ai-toolkit at /app/ai-toolkit.
# 0.13.41 is the release of 4 Nov 2026, the same code as the pinned ai-toolkit commit.
IMAGE = "ostris/aitoolkit:0.13.41"


def _req(method, path, retries=4, **kw):
    last = None
    for i in range(retries):
        try:
            r = requests.request(method, f"{API}{path}", headers=H(), timeout=45, **kw)
            if r.status_code in (429, 500, 502, 503, 504):
                last = RuntimeError(f"vast {method} {path}: {r.status_code} {r.text[:200]}")
            else:
                return r
        except requests.RequestException as e:
            last = e
        time.sleep(5 * (i + 1))
    raise last


def credit():
    r = _req("GET", "/users/current/"); r.raise_for_status()
    return r.json().get("credit")


def offers(max_dph=3.2, n=10, max_bw_cost=10.0):
    q = {"gpu_name": {"in": ["H100 SXM", "H100 PCIE", "H100 NVL"]}, "rentable": {"eq": True}, "verified": {"eq": True},
         "num_gpus": {"eq": 1}, "reliability2": {"gte": 0.98}, "disk_space": {"gte": 200}, "inet_down": {"gte": 500},
         "cuda_max_good": {"gte": 13.0}, "dph_total": {"lte": max_dph},
         "inet_down_cost": {"lte": max_bw_cost / 1000}, "inet_up_cost": {"lte": max_bw_cost / 1000},  # $/GB; max_bw_cost is $/TB
         "order": [["dph_total", "asc"]], "type": "ondemand", "limit": n}
    r = _req("POST", "/bundles/", json=q); r.raise_for_status()
    return r.json().get("offers", [])


def create(offer_id, label, onstart, env, disk_gb=200):
    body = {"client_id": "me", "image": IMAGE, "disk": disk_gb, "label": label, "onstart": onstart,
            "runtype": "ssh_direct", "env": env}
    r = _req("PUT", f"/asks/{offer_id}/", json=body, retries=1)
    r.raise_for_status()
    j = r.json()
    if not j.get("success"):
        raise RuntimeError(f"vast create failed: {j}")
    return j["new_contract"]


def instance(iid):
    r = _req("GET", f"/instances/{iid}/", params={"owner": "me"}); r.raise_for_status()
    return r.json().get("instances")


def destroy(iid):
    """True once Vast confirms the machine is gone (or never existed)."""
    for i in range(8):
        try:
            r = requests.delete(f"{API}/instances/{iid}/", headers=H(), timeout=45)
            if r.status_code == 404:
                return True
            if r.ok and (r.json().get("success", True) is not False):
                return True
        except (requests.RequestException, ValueError):
            pass
        time.sleep(5 * (i + 1))
    return False


def mine():
    r = _req("GET", "/instances/", params={"owner": "me"}); r.raise_for_status()
    return r.json().get("instances", [])


def destroy_labelled(label=None, prefix=None):
    n = 0
    for i in mine():
        lb = i.get("label") or ""
        if (label and lb == label) or (prefix and lb.startswith(prefix)):
            n += destroy(i["id"])
    return n
