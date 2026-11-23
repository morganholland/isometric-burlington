"""Amtrak's Ethan Allen Express -> viewer/amtrak.json, in the same shape as viewer/transit.json, so the
viewer can run the train on its timetable beside the buses.

usage: python3 pipeline/amtrak.py <unzipped Amtrak GTFS dir> [out.json]
(the feed is https://content.amtrak.com/content/gtfs/GTFS.zip)

Amtrak's track shape is coarse (one straight 2 km chord past Red Rocks), so on and near the map it is redrawn
from the federal rail network (data/rail_amtrak.geojson, the tracks Amtrak runs on here, from US DOT BTS
"North American Rail Network Lines"): sampled every 10 m and snapped onto the real rails.

Amtrak's feed has no shape_dist_traveled, so distances along the track are measured here and each
station is placed at the nearest point of the track. Heights come from the map's own street heights
(viewer/labels.json) where a street is within 40 m of the track, interpolated along the track in between,
so the train sits on the drawn ground. The train lays over at Burlington's Union Station between its evening arrival and its
morning departure: that wait is written as a third "trip" that stands still at the end of the track.
"""
import csv, json, math, sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from transit import simplify  # noqa: E402

ROUTE_NAME = "Ethan Allen Express"
ROUTE_ID = "amtrak"
BBOX = (44.39, -73.33, 44.55, -73.10)          # same as pipeline/transit.py
DAY = 86400


def rows(d, name):
    with open(Path(d) / name, newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


def secs(t):
    h, m, s = (int(x) for x in t.split(":"))
    return h * 3600 + m * 60 + s


def metres(a, b):
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((b[0] - a[0]) * 110950, (b[1] - a[1]) * 111320 * k)


def inside(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


def along(pts):
    """[(lat, lon)] -> [(lat, lon, metres from the first point)]"""
    out, d = [], 0.0
    for i, p in enumerate(pts):
        if i:
            d += metres(pts[i - 1], p)
        out.append((p[0], p[1], d))
    return out


def project(pts, q):
    """distance along the polyline [(lat, lon, dist)] of the point nearest to q"""
    best, bd = 0.0, float("inf")
    for a, b in zip(pts, pts[1:]):
        k = math.cos(math.radians(a[0]))
        ax, ay, bx, by = a[1] * 111320 * k, a[0] * 110950, b[1] * 111320 * k, b[0] * 110950
        qx, qy = q[1] * 111320 * k, q[0] * 110950
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, ((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy or 1e-9)))
        dd = math.hypot(qx - ax - t * dx, qy - ay - t * dy)
        if dd < bd:
            bd, best = dd, a[2] + (b[2] - a[2]) * t
    return best


NEAR_STREET_M = 40
SNAP_M = 80


def street_heights(labels):
    """(lat, lon) -> height of the nearest street point, or None when no street is within NEAR_STREET_M"""
    pts = [(p[0], p[1], p[2]) for s in labels["streets"] for p in s[2]]
    def h(lat, lon):
        p = min(pts, key=lambda p: (p[0] - lat) ** 2 + ((p[1] - lon) * 0.713) ** 2)
        return p[2] if metres(p, (lat, lon)) <= NEAR_STREET_M else None
    return h


def fill(vals):
    """None gaps filled by straight lines between the known values (and held flat past the ends)"""
    known = [i for i, v in enumerate(vals) if v is not None]
    if not known:
        return [0.0] * len(vals)
    out = list(vals)
    for i in range(len(vals)):
        if out[i] is not None:
            continue
        lo = max((k for k in known if k < i), default=None)
        hi = min((k for k in known if k > i), default=None)
        if lo is None or hi is None:
            out[i] = vals[hi if lo is None else lo]
        else:
            out[i] = vals[lo] + (vals[hi] - vals[lo]) * (i - lo) / (hi - lo)
    return out


def rail_snapper(path):
    segs = []
    for f in json.loads(Path(path).read_text())["features"]:
        c = f["geometry"]["coordinates"]
        segs += [((a[1], a[0]), (b[1], b[0])) for a, b in zip(c, c[1:])]
    def snap(lat, lon):
        best, bd = (lat, lon), SNAP_M
        k = math.cos(math.radians(lat))
        qx, qy = lon * 111320 * k, lat * 110950
        for a, b in segs:
            ax, ay, bx, by = a[1] * 111320 * k, a[0] * 110950, b[1] * 111320 * k, b[0] * 110950
            dx, dy = bx - ax, by - ay
            t = max(0.0, min(1.0, ((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy or 1e-9)))
            dd = math.hypot(qx - ax - t * dx, qy - ay - t * dy)
            if dd < bd:
                bd, best = dd, (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        return best
    return snap


def densify(pts, step):
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        n = max(1, int(metres(a, b) // step))
        out += [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(1, n + 1)]
    return out


def redraw_near_map(pts, snap):
    """the shape's stretch on and next to the map, sampled every 10 m and snapped onto the real rails"""
    near = [inside(*p) for p in pts]
    idx = [k for k in range(len(pts)) if near[k] or (k > 0 and near[k - 1]) or (k + 1 < len(pts) and near[k + 1])]
    if not idx:
        return pts
    i0, i1 = idx[0], idx[-1]
    mid = [snap(*p) for p in densify(pts[i0:i1 + 1], 10)]
    # the snapped line wobbles where two tracks run side by side: drop points that step backwards
    clean = [mid[0]]
    for p in mid[1:]:
        if metres(clean[-1], p) > 2:
            clean.append(p)
    clean = [(p[0], p[1]) for p in simplify([(p[0], p[1], 0) for p in clean], 1.0)]   # straight runs need few points
    return pts[:i0] + clean + pts[i1 + 1:]


def build(d, labels):
    route = next(r for r in rows(d, "routes.txt") if r["route_long_name"] == ROUTE_NAME)
    trips = [t for t in rows(d, "trips.txt") if t["route_id"] == route["route_id"]]
    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    cal = {c["service_id"]: c for c in rows(d, "calendar.txt")}
    stops = {s["stop_id"]: (float(s["stop_lat"]), float(s["stop_lon"])) for s in rows(d, "stops.txt") if s["stop_lat"]}
    want = {t["trip_id"] for t in trips}
    st = defaultdict(list)
    for r in rows(d, "stop_times.txt"):
        if r["trip_id"] in want:
            st[r["trip_id"]].append((int(r["stop_sequence"]), secs(r["arrival_time"]), secs(r["departure_time"]), r["stop_id"]))
    want_shapes = {t["shape_id"] for t in trips}
    shp = defaultdict(list)
    for r in rows(d, "shapes.txt"):
        if r["shape_id"] in want_shapes:
            shp[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
    height = street_heights(labels)
    snap = rail_snapper(Path(__file__).parent.parent / "data/rail_amtrak.geojson")

    services, shapes, out_trips, sidx = [], [], [], {}
    arrive, leave = None, None                       # (shape index, metres, time) at Burlington
    for t in sorted(trips, key=lambda t: t["direction_id"]):
        c = cal[t["service_id"]]
        if t["service_id"] not in sidx:
            sidx[t["service_id"]] = len(services)
            services.append(sum(1 << i for i, k in enumerate(days) if c[k] == "1"))
        full = along(redraw_near_map([(la, lo) for _, la, lo in sorted(shp[t["shape_id"]])], snap))
        s = sorted(st[t["trip_id"]])
        dist = [project(full, stops[x[3]]) for x in s]
        # keep the track on and next to the map, with distances still measured from the start of the line
        near = [inside(p[0], p[1]) for p in full]
        keep = [p for k, p in enumerate(full) if near[k] or (k > 0 and near[k - 1]) or (k + 1 < len(full) and near[k + 1])]
        si = len(shapes)
        hs = fill([height(p[0], p[1]) for p in keep])
        shapes.append([[round(p[0], 6), round(p[1], 6), round(h, 1), round(p[2], 1)] for p, h in zip(keep, hs)])
        tl = []
        for (_, arr, dep, _), m in zip(s, dist):
            tl += [arr, round(m, 1)]
            if dep != arr:
                tl += [dep, round(m, 1)]
        out_trips.append([ROUTE_ID, sidx[t["service_id"]], si, tl, t["trip_short_name"], t["trip_headsign"]])
        if s[-1][3] == "BTN":
            arrive = (s[-1][1], sidx[t["service_id"]])
        if s[0][3] == "BTN":
            leave = (si, round(dist[0], 1), s[0][2])
    # overnight the train stands where the morning train starts, facing south, so it leaves without a jump
    if arrive and leave:
        (t0, svc), (si, m, dep) = arrive, leave
        t1 = dep + DAY if dep < t0 else dep
        out_trips.append([ROUTE_ID, svc, si, [t0, m, t1, m], "", "parked"])
    return {"routes": {ROUTE_ID: [route["route_short_name"] or "Amtrak", "#" + (route["route_color"] or "cae4f1").lower(),
                                  ROUTE_NAME, "train"]},
            "shapes": shapes, "services": services, "trips": out_trips, "dates": {}}


if __name__ == "__main__":
    root = Path(__file__).parent.parent
    data = build(sys.argv[1], json.loads((root / "viewer/labels.json").read_text()))
    out = Path(sys.argv[2] if len(sys.argv) > 2 else root / "viewer/amtrak.json")
    out.write_text(json.dumps(data, separators=(",", ":")))
    print(f"{len(data['trips'])} trips, {sum(len(s) for s in data['shapes'])} track points -> {out}")
