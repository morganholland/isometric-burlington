"""Building footprints and heights -> viewer/buildings.json, so a tap on the map can find the building it hit.

usage: python3 pipeline/buildings.py [out.json]

The map is drawn looking down at 30 degrees, so a tap on a roof is not above the ground point under it: the
building sits some way in front of that point. To know which building a tap hit, the viewer follows the line
of sight down from the tap and stops at the first footprint that is tall enough to reach it. That needs each
building's outline and height.

Footprints and heights come from OpenStreetMap, through the public "OpenStreetMap Buildings for North America"
feature service on ArcGIS Online (Overpass is not reachable from where this runs). Where a building has no
height tag, it is guessed from its levels, its kind and its size (same rule as pipeline/labels.py). The ground
under each building is the height of the nearest street point in viewer/labels.json, which is the drawn ground.

Output (compact): {"b": [[base, top, e0, n0, de1, dn1, de2, dn2, ...], ...]}
  base and top are ENU heights in metres; the outline is in half-metres east and north of the map origin, the
  first point as is and each later point as a step from the one before.
"""
import json, math, sys, time, urllib.parse, urllib.request
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from geo import lla_to_enu  # noqa: E402
from labels import building_height  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
URL = "https://services6.arcgis.com/Do88DoK2xjTUCXd1/arcgis/rest/services/OSM_NA_Buildings/FeatureServer/0/query"
BBOX = (44.39, -73.33, 44.55, -73.10)          # lat0, lon0, lat1, lon1 (the viewer's search box)
PAGE = 2000
MIN_AREA = 20                                  # m², drop sheds too small to tap


def get(params, tries=5):
    url = URL + "?" + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "isometric-map/1.0"}), timeout=90) as r:
                j = json.load(r)
            if "error" in j:
                raise RuntimeError(j["error"])
            return j
        except Exception as e:  # noqa: BLE001
            print(f"  retry {i + 1}: {e}")
            time.sleep(3 * (i + 1))
    raise RuntimeError("OSM buildings service unreachable")


def fetch():
    out, off = [], 0
    while True:
        j = get({"geometry": f"{BBOX[1]},{BBOX[0]},{BBOX[3]},{BBOX[2]}", "geometryType": "esriGeometryEnvelope",
                 "inSR": 4326, "outSR": 4326, "spatialRel": "esriSpatialRelIntersects",
                 "outFields": "building,height,building_levels,min_height", "returnGeometry": "true",
                 "maxAllowableOffset": 0.000004, "geometryPrecision": 6, "orderByFields": "OBJECTID",
                 "resultOffset": off, "resultRecordCount": PAGE, "f": "json"})
        fs = j.get("features", [])
        out += fs
        print(f"  {len(out)} buildings")
        if len(fs) < PAGE and not j.get("exceededTransferLimit"):
            return out
        off += len(fs)


def ground(labels):
    """(e, n) -> height of the nearest drawn street point (ENU up)"""
    pts = [p for s in labels["streets"] for p in s[2]]
    e, n, u = lla_to_enu(np.array([p[0] for p in pts]), np.array([p[1] for p in pts]), np.array([p[2] for p in pts]))
    cells = defaultdict(list)
    for x, y, h in zip(e, n, u):
        cells[(int(x // 100), int(y // 100))].append((x, y, h))
    def h(x, y):
        cx, cy = int(x // 100), int(y // 100)
        for r in range(1, 30):
            near = [p for i in range(cx - r, cx + r + 1) for j in range(cy - r, cy + r + 1) for p in cells.get((i, j), ())]
            if near:
                return min(near, key=lambda p: (p[0] - x) ** 2 + (p[1] - y) ** 2)[2]
        return 0.0
    return h


def tags(a):
    t = {"building": a.get("building") or "yes"}
    if a.get("height") not in (None, ""): t["height"] = str(a["height"])
    if a.get("building_levels") not in (None, ""): t["building:levels"] = str(a["building_levels"])
    return t


def build(features, labels):
    h = ground(labels)
    out = []
    for f in features:
        rings = (f.get("geometry") or {}).get("rings") or []
        if not rings:
            continue
        ring = rings[0]                                  # the outer ring; courtyards are rare and small here
        lat = np.array([p[1] for p in ring]); lon = np.array([p[0] for p in ring])
        e, n, _ = lla_to_enu(lat, lon)
        area = abs(sum(e[i - 1] * n[i] - e[i] * n[i - 1] for i in range(len(e)))) / 2
        if area < MIN_AREA:
            continue
        ce, cn = float(e.mean()), float(n.mean())
        base = h(ce, cn)
        top = base + building_height(tags(f["attributes"]), area)
        q = [(round(float(x) * 2), round(float(y) * 2)) for x, y in zip(e[:-1], n[:-1])]   # ArcGIS repeats the first point
        flat, px, py = [], 0, 0
        for x, y in q:                                   # half-metres, each point as a step from the one before
            flat += [x - px, y - py]
            px, py = x, y
        out.append([round(base, 1), round(top, 1)] + flat)
    return {"b": out}


if __name__ == "__main__":
    labels = json.loads((ROOT / "viewer/labels.json").read_text())
    data = build(fetch(), labels)
    dst = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "viewer/buildings.json")
    dst.write_text(json.dumps(data, separators=(",", ":")))
    print(f"{len(data['b'])} buildings -> {dst} ({dst.stat().st_size // 1024} KB)")
