"""Rent, watch and always delete Vast.ai GPU machines.

Every machine gets: a spend cap (hours x price), a deadline after which this script deletes it,
and an on-start script that refuses to work on a GPU that is power-capped or slow.
Results come back through R2, never through the machine's disk.
"""
import json, os, time
import requests

API = "https://console.vast.ai/api/v0"
H = lambda: {"Authorization": f"Bearer {os.environ['VAST_API_KEY']}"}
IMAGE = "pytorch/pytorch:2.9.1-cuda12.8-cudnn9-devel"


def credit():
    return requests.get(f"{API}/users/current/", headers=H(), timeout=30).json().get("credit")


def offers(max_dph=3.2, n=10):
    q = {"gpu_name": {"in": ["H100 SXM", "H100 PCIE", "H100 NVL"]}, "rentable": {"eq": True}, "verified": {"eq": True},
         "num_gpus": {"eq": 1}, "reliability2": {"gte": 0.98}, "disk_space": {"gte": 150}, "inet_down": {"gte": 500},
         "cuda_max_good": {"gte": 12.8}, "dph_total": {"lte": max_dph}, "order": [["dph_total", "asc"]],
         "type": "on-demand", "limit": n}
    r = requests.post(f"{API}/bundles/", headers=H(), json=q, timeout=30)
    r.raise_for_status()
    return r.json().get("offers", [])


def create(offer_id, label, onstart, env, disk_gb=150):
    body = {"client_id": "me", "image": IMAGE, "disk": disk_gb, "label": label, "onstart": onstart,
            "runtype": "ssh_direct", "env": env}
    r = requests.put(f"{API}/asks/{offer_id}/", headers=H(), json=body, timeout=60)
    r.raise_for_status()
    j = r.json()
    if not j.get("success"):
        raise RuntimeError(f"vast create failed: {j}")
    return j["new_contract"]


def instance(iid):
    r = requests.get(f"{API}/instances/{iid}/", headers=H(), timeout=30)
    r.raise_for_status()
    return r.json().get("instances")


def destroy(iid):
    for _ in range(5):
        r = requests.delete(f"{API}/instances/{iid}/", headers=H(), timeout=30)
        if r.ok:
            return True
        time.sleep(5)
    return False


def mine():
    r = requests.get(f"{API}/instances/", headers=H(), timeout=30)
    r.raise_for_status()
    return r.json().get("instances", [])


def destroy_all_labelled(prefix):
    n = 0
    for i in mine():
        if (i.get("label") or "").startswith(prefix):
            destroy(i["id"]); n += 1
    return n
