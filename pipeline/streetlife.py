"""The street network cars drive on, and the lights that come on at night
-> viewer/streets.json and viewer/lights.json.

usage: python3 pipeline/streetlife.py

Everything comes from OpenStreetMap (Overpass) and the same terrain heights as pipeline/labels.py
(whose download cache, runs/labels-cache, this shares).

streets.json   the driveable streets inside the drawn region, as a graph
  {"origin": [lat0, lon0], "nodes": [x, y, h, ...], "signals": [node, ...],
   "edges": [[from, to, cls, oneway, [x, y, h, ...], hidden], ...]}
  x, y: 1e-5 degrees east / north of origin; h: decimetres (ellipsoid, like labels.json).
  cls: 0 motorway/trunk, 1 primary, 2 secondary, 3 tertiary, 4 residential, 5 slip road.
  The point list holds the points between the two end nodes. hidden[angle] = flat [m0, m1, ...] stretches
  (metres from the `from` end) that a building stands in front of in that view.

lights.json    what glows after dark
  {"origin": [lat0, lon0], "lamps": [x, y, h, mask, ...], "windows": [x, y, h, mask, ...],
   "field": [x, y, h, kind, ...], "beacons": [x, y, h, kind, ...]}
  mask: bit a set = seen in view a (not behind a building; for windows also on a wall that faces that view).
  Lamps stand along the streets at a spacing typical for the kind of street (OpenStreetMap has few of the
  real poles here), so they are a picture of a lit street, not a survey. Windows are a share of the
  windows a building of that footprint and height would have. field: BTV's runway (kind 0, white) and
  taxiway (kind 1, blue) edge lights along OpenStreetMap's runways and taxiways. beacons: lighthouses and
  lit navigation marks (kind 0 white, 1 red, 2 green) and the airport beacon (kind 3).
"""
import hashlib, json, math, statistics, sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import labels as LB  # noqa: E402

ROOT = LB.ROOT
BBOX = LB.BBOX
ORIGIN = (BBOX[0], BBOX[1])
CLS = {"motorway": 0, "trunk": 0, "primary": 1, "secondary": 2, "tertiary": 3, "residential": 4,
       "unclassified": 4, "living_street": 4, "motorway_link": 5, "trunk_link": 5, "primary_link": 5,
       "secondary_link": 5, "tertiary_link": 5}
LAMP_EVERY = {1: 38, 2: 42, 3: 50, 4: 75, 5: 60}      # metres between street lamps, by class (none on I-89)
LAMP_SIDE, LAMP_H = 5.5, 8.0
MARGIN = 120                                           # metres kept outside the drawn region


def rnd(*key):
    """A steady 0..1 number for a key (the same map every run)."""
    return int(hashlib.md5(repr(key).encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def q(lat, lon, h):
    return [round((lon - ORIGIN[1]) * 1e5), round((lat - ORIGIN[0]) * 1e5), round(h * 10)]


def region():
    g = json.loads((ROOT / "data" / "region_enu.geojson").read_text())["geometry"]["coordinates"]
    polys = [[(x, y) for x, y in poly[0]] for poly in g]
    bbs = [(min(p[0] for p in r), min(p[1] for p in r), max(p[0] for p in r), max(p[1] for p in r)) for r in polys]

    def near(e, n, m=MARGIN):
        for r, bb in zip(polys, bbs):
            if not (bb[0] - m <= e <= bb[2] + m and bb[1] - m <= n <= bb[3] + m):
                continue
            if LB.inside(r, e, n):
                return True
            for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
                dx, dy = x2 - x1, y2 - y1
                t = max(0, min(1, ((e - x1) * dx + (n - y1) * dy) / ((dx * dx + dy * dy) or 1e-9)))
                if math.hypot(e - x1 - dx * t, n - y1 - dy * t) <= m:
                    return True
        return False
    return near


class Buildings:
    """Building footprints as view occluders that know which building they are."""
    CELL = 256

    def __init__(self, ways, H):
        self.grid = [defaultdict(list) for _ in range(4)]
        self.items = []
        for w in ways:
            g = w.get("geometry")
            if not g or len(g) < 4:
                continue
            ring = [LB.enu(p["lat"], p["lon"], 0)[:2] for p in g]
            signed = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:])) / 2
            area = abs(signed)
            if area < 25:
                continue
            cla = sum(p["lat"] for p in g) / len(g); clo = sum(p["lon"] for p in g) / len(g)
            base = H(cla, clo); tags = w.get("tags", {})
            height = LB.building_height(tags, area)
            i = len(self.items)
            self.items.append({"id": w["id"], "geom": g, "ring": ring, "ccw": signed > 0, "area": area,
                               "base": base, "height": height, "tags": tags})
            for a in range(4):
                pts = [LB.to_px(a, e, nn, base) for e, nn in ring] + [LB.to_px(a, e, nn, base + height) for e, nn in ring]
                poly = LB.hull([(round(x, 1), round(y, 1)) for x, y in pts])
                xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
                bb = (min(xs), min(ys), max(xs), max(ys))
                for cx in range(int(bb[0] // self.CELL), int(bb[2] // self.CELL) + 1):
                    for cy in range(int(bb[1] // self.CELL), int(bb[3] // self.CELL) + 1):
                        self.grid[a][(cx, cy)].append((bb, poly, i))
        print(f"{len(self.items)} buildings")

    def hidden(self, a, lat, lon, h, skip=-1):
        x, y = LB.to_px(a, *LB.enu(lat, lon, h))
        for bb, poly, i in self.grid[a].get((int(x // self.CELL), int(y // self.CELL)), ()):
            if i != skip and bb[0] <= x <= bb[2] and bb[1] <= y <= bb[3] and LB.inside(poly, x, y):
                return True
        return False

    def mask(self, lat, lon, h, skip=-1):
        return sum(1 << a for a in range(4) if not self.hidden(a, lat, lon, h, skip))


def along(line, step, start):
    """Points every `step` metres along a [[lat, lon, h], ...] line: (lat, lon, h, unit east, unit north)."""
    out, want, run = [], start, 0.0
    for (la0, lo0, h0), (la1, lo1, h1) in zip(line, line[1:]):
        (x0, y0), (x1, y1) = LB.xy((la0, lo0)), LB.xy((la1, lo1))
        seg = math.hypot(x1 - x0, y1 - y0)
        while seg > 0 and want <= run + seg:
            t = (want - run) / seg
            out.append((la0 + (la1 - la0) * t, lo0 + (lo1 - lo0) * t, h0 + (h1 - h0) * t, (x1 - x0) / seg, (y1 - y0) / seg))
            want += step
        run += seg
    return out


def shift(lat, lon, de, dn):
    return lat + dn / 110950, lon + de / (111320 * math.cos(math.radians(44.47)))


def hidden_metres(bld, line):
    """For each view, the stretches (metres from the start) of a line that buildings stand in front of."""
    out = [[] for _ in range(4)]
    pts = along(line, 3.0, 0.0)
    for a in range(4):
        run = None
        for k, (la, lo, h, _, _) in enumerate(pts):
            m = k * 3.0
            if bld.hidden(a, la, lo, h + 0.8):
                if run is None: run = [max(0, m - 1.5), m]
                run[1] = m + 1.5
            elif run is not None:
                out[a] += [round(run[0]), round(run[1])]; run = None
        if run is not None:
            out[a] += [round(run[0]), round(run[1])]
    return out


def build_streets(H, near, bld):
    ways = LB.overpass("drive", 'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|'
                                'living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](BBOX);')
    sig = LB.overpass("signals", 'node["highway"="traffic_signals"](BBOX);', out="out;")
    signal_ids = {n["id"] for n in sig["elements"] if n["type"] == "node"}
    ways = [w for w in ways["elements"] if w["type"] == "way" and "geometry" in w and "nodes" in w
            and w["tags"].get("access") not in ("private", "no") and w["tags"].get("tunnel") != "yes"
            and w["tags"].get("area") != "yes"]
    use = defaultdict(int)
    for w in ways:
        for k, nid in enumerate(w["nodes"]):
            use[nid] += 2 if k in (0, len(w["nodes"]) - 1) else 1
    node_ix, nodes, edges, lines = {}, [], [], []

    def node(nid, g):
        if nid not in node_ix:
            node_ix[nid] = len(node_ix)
            nodes.extend(q(g["lat"], g["lon"], H(g["lat"], g["lon"])))
        return node_ix[nid]

    for w in ways:
        t = w["tags"]; cls = CLS[t["highway"]]
        ow = t.get("oneway")
        oneway = 1 if (ow in ("yes", "1", "true") or t.get("junction") == "roundabout" or (t["highway"] == "motorway" and ow != "no")) else -1 if ow == "-1" else 0
        ids, geom = w["nodes"], w["geometry"]
        start = 0
        for k in range(1, len(ids)):
            if k < len(ids) - 1 and use[ids[k]] < 2 and ids[k] not in signal_ids:
                continue
            part_ids, part = ids[start:k + 1], geom[start:k + 1]
            start = k
            mid = [((a["lat"] + b["lat"]) / 2, (a["lon"] + b["lon"]) / 2) for a, b in zip(part, part[1:])]
            if not any(near(*LB.enu(la, lo, 0)[:2]) for la, lo in mid + [(p["lat"], p["lon"]) for p in part]):
                continue
            pts = LB.rdp([(p["lat"], p["lon"]) for p in part], 1.0)
            line = [[la, lo, H(la, lo)] for la, lo in pts]
            if LB.length(line) < 2:
                continue
            a, b = node(part_ids[0], part[0]), node(part_ids[-1], part[-1])
            if oneway == -1:
                a, b, line = b, a, line[::-1]
            inner = [v for p in line[1:-1] for v in q(*p)]
            edges.append([a, b, cls, 1 if oneway else 0, inner, hidden_metres(bld, line)])
            lines.append((cls, line, w["id"], len(edges)))
    signals = sorted(node_ix[i] for i in signal_ids if i in node_ix)
    km = sum(LB.length(l) for _, l, _, _ in lines) / 1000
    print(f"{len(edges)} street pieces, {len(nodes) // 3} junctions, {len(signals)} traffic lights, {km:.0f} km")
    return {"origin": list(ORIGIN), "nodes": nodes, "signals": signals, "edges": edges}, lines


def build_lamps(lines, bld, near):
    lamps = []
    for cls, line, wid, k in lines:
        step = LAMP_EVERY.get(cls)
        if not step:
            continue
        for j, (la, lo, h, ue, un) in enumerate(along(line, step, step * (0.25 + 0.5 * rnd("lamp", wid, k)))):
            if not near(*LB.enu(la, lo, 0)[:2], 0):
                continue
            side = 1 if (j + int(rnd("side", wid) * 2)) % 2 else -1
            la2, lo2 = shift(la, lo, un * LAMP_SIDE * side, -ue * LAMP_SIDE * side)
            m = bld.mask(la2, lo2, h + LAMP_H)
            if m:
                lamps.extend(q(la2, lo2, h) + [m])
    print(f"{len(lamps) // 4} street lamps")
    return lamps


def build_windows(bld, near):
    out = []
    for i, b in enumerate(bld.items):
        ring, geom = b["ring"], b["geom"]
        if not near(ring[0][0], ring[0][1], 0):
            continue
        kind = b["tags"].get("building", "yes")
        if kind in ("garage", "garages", "shed", "carport", "roof", "hut", "barn", "greenhouse"):
            continue
        home = b["area"] < 420 and b["height"] <= 10
        share = 0.30 if home else 0.20
        floors = max(1, int((b["height"] - 1.2) // 3.2))
        for k in range(len(ring) - 1):
            (e0, n0), (e1, n1) = ring[k], ring[k + 1]
            L = math.hypot(e1 - e0, n1 - n0)
            if L < 3.5:
                continue
            ue, un = (e1 - e0) / L, (n1 - n0) / L
            oe, on = (un, -ue) if b["ccw"] else (-un, ue)          # outward normal
            # the views this wall faces: view a looks along heading HEADINGS[a]
            face = 0
            for a, hd in enumerate(LB.HEADINGS):
                fe, fn = math.sin(math.radians(hd)), math.cos(math.radians(hd))
                if oe * fe + on * fn < -0.6:
                    face |= 1 << a
            if not face:
                continue
            n_win = int(L // 3.2)
            for j in range(n_win):
                for f in range(floors):
                    if rnd("w", b["id"], k, j, f) > share:
                        continue
                    t = (j + 0.5) / n_win
                    la = geom[k]["lat"] + (geom[k + 1]["lat"] - geom[k]["lat"]) * t
                    lo = geom[k]["lon"] + (geom[k + 1]["lon"] - geom[k]["lon"]) * t
                    la, lo = shift(la, lo, oe * 0.3, on * 0.3)
                    h = b["base"] + 1.9 + f * 3.2
                    m = face & bld.mask(la, lo, h, skip=i)
                    if m:
                        out.extend(q(la, lo, h) + [m])
    print(f"{len(out) // 4} lit windows")
    return out


def build_field(H, bld):
    air = LB.overpass("airfield", 'way["aeroway"~"^(runway|taxiway)$"](BBOX);')
    marks = LB.overpass("marks", 'node["man_made"="lighthouse"](BBOX);node["seamark:type"~"^(light_minor|light_major|beacon_lateral|beacon_special_purpose)$"](BBOX);'
                                 'node["man_made"="beacon"](BBOX);node["aeroway"="beacon"](BBOX);', out="out;")
    field = []
    for w in air["elements"]:
        if "geometry" not in w:
            continue
        runway = w["tags"]["aeroway"] == "runway"
        try: width = float(w["tags"].get("width", ""))
        except ValueError: width = 45 if runway else 18
        line = [[g["lat"], g["lon"], H(g["lat"], g["lon"])] for g in w["geometry"]]
        for la, lo, h, ue, un in along(line, 60 if runway else 45, 10):
            for side in (1, -1):
                la2, lo2 = shift(la, lo, un * width / 2 * side, -ue * width / 2 * side)
                field.extend(q(la2, lo2, h + 0.4) + [0 if runway else 1])
    beacons = []
    for n in marks["elements"]:
        t = n.get("tags", {})
        if t.get("aeroway") == "beacon":
            kind = 3
        else:
            col = (t.get("seamark:light:colour") or t.get("seamark:light:1:colour") or t.get("seamark:beacon_lateral:colour") or "white").lower()
            kind = 1 if "red" in col else 2 if "green" in col else 0
        try: up = float(t.get("height", t.get("seamark:light:height", "9")).split()[0])
        except ValueError: up = 9
        beacons.extend(q(n["lat"], n["lon"], H(n["lat"], n["lon"]) + min(up, 25)) + [kind])
    print(f"{len(field) // 4} airfield lights, {len(beacons) // 4} beacons")
    return field, beacons


def main():
    LB.CACHE.mkdir(parents=True, exist_ok=True)
    transit = json.loads((ROOT / "viewer" / "transit.json").read_text())
    diffs = [p[2] - (LB.elev(p[0], p[1]) + LB.GEOID_M) for s in transit["shapes"] for p in s[::4]
             if BBOX[0] < p[0] < BBOX[2] and BBOX[1] < p[1] < BBOX[3]]
    off = statistics.median(diffs)
    H = lambda lat, lon: round(LB.elev(lat, lon) + LB.GEOID_M + off, 1)
    near = region()

    raw = []
    mid_lat, mid_lon = (BBOX[0] + BBOX[2]) / 2, (BBOX[1] + BBOX[3]) / 2
    quads = [(BBOX[0], BBOX[1], mid_lat, mid_lon), (BBOX[0], mid_lon, mid_lat, BBOX[3]),
             (mid_lat, BBOX[1], BBOX[2], mid_lon), (mid_lat, mid_lon, BBOX[2], BBOX[3])]
    for i, qd in enumerate(quads):
        raw += LB.overpass(f"bld{i + 1}", 'way["building"](BBOX);', out="out tags geom;", bbox=qd)["elements"]
    bld = Buildings({w["id"]: w for w in raw if w["type"] == "way"}.values(), H)

    streets, lines = build_streets(H, near, bld)
    field, beacons = build_field(H, bld)
    lights = {"origin": list(ORIGIN), "lamps": build_lamps(lines, bld, near), "windows": build_windows(bld, near),
              "field": field, "beacons": beacons}
    for name, d in (("streets.json", streets), ("lights.json", lights)):
        f = ROOT / "viewer" / name
        f.write_text(json.dumps(d, separators=(",", ":")))
        print(f"-> {f} ({f.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
