"""Building footprints and heights -> viewer/buildings.json, so a tap on the map can find the building it hit.

usage: python3 pipeline/buildings.py [out.json]

The map is drawn looking down at 30 degrees, so a tap on a roof is not above the ground point under it: the
building sits some way in front of that point. To know which building a tap hit, the viewer follows the line
of sight down from the tap and stops at the first footprint that is tall enough to reach it. That needs each
building's outline and height.

Footprints and heights come from OpenStreetMap, through the public "OpenStreetMap Buildings for North America"
feature service on ArcGIS Online (Overpass is not reachable from where this runs). Where a building has no
height tag, it is guessed from its levels, its kind and its size (same rule as pipeline/labels.py). The ground
under each building is bare-earth terrain (AWS Terrain Tiles, as in pipeline/labels.py), shifted to agree with
the road heights the bus routes were measured at, so roofs land where the drawing has them. (The nearest street
point is not good enough: on the hill a street one block over can be 10 m higher, which puts an outline
40 px above the roof it belongs to.)

Output (compact): {"b": [[base, top, e0, n0, de1, dn1, de2, dn2, ...], ...]}
  base and top are ENU heights in metres; the outline is in half-metres east and north of the map origin, the
  first point as is and each later point as a step from the one before.
"""
import json, math, sys, time, urllib.parse, urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from geo import lla_to_enu  # noqa: E402
import labels  # noqa: E402
from labels import building_height, elev, GEOID_M  # noqa: E402

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


def ground():
    """(lat, lon) -> ground height (ENU up), terrain shifted onto the bus routes' road heights"""
    import statistics
    labels.CACHE.mkdir(parents=True, exist_ok=True)
    transit = json.loads((ROOT / "viewer/transit.json").read_text())
    b = labels.BBOX
    diffs = [p[2] - (elev(p[0], p[1]) + GEOID_M) for s in transit["shapes"] for p in s[::4] if b[0] < p[0] < b[2] and b[1] < p[1] < b[3]]
    off = statistics.median(diffs)
    print(f"terrain vs bus-route heights: median {off:+.2f} m")
    return lambda lat, lon: elev(lat, lon) + GEOID_M + off


def tags(a):
    t = {"building": a.get("building") or "yes"}
    if a.get("height") not in (None, ""): t["height"] = str(a["height"])
    if a.get("building_levels") not in (None, ""): t["building:levels"] = str(a["building_levels"])
    return t


def build(features):
    h = ground()
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
        base = h(float(lat.mean()), float(lon.mean()))
        top = base + building_height(tags(f["attributes"]), area)
        q = [(round(float(x) * 2), round(float(y) * 2)) for x, y in zip(e[:-1], n[:-1])]   # ArcGIS repeats the first point
        flat, px, py = [], 0, 0
        for x, y in q:                                   # half-metres, each point as a step from the one before
            flat += [x - px, y - py]
            px, py = x, y
        out.append([round(base, 1), round(top, 1)] + flat)
    return {"b": out}


if __name__ == "__main__":
    data = build(fetch())
    dst = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "viewer/buildings.json")
    dst.write_text(json.dumps(data, separators=(",", ":")))
    print(f"{len(data['b'])} buildings -> {dst} ({dst.stat().st_size // 1024} KB)")
