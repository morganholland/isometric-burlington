// Cars on the streets. They are simulated, not tracked: each one drives OpenStreetMap's streets
// (viewer/streets.json, from pipeline/streetlife.py), keeps its distance from the car ahead, waits at red
// lights and gives way at side-street junctions. How many are out follows a typical day's traffic for the
// hour in Burlington. Only the streets near the view are simulated, and only once you are close enough to
// see a car.
import { llaToEnu, enuToPx, pxToEnu } from './geo.js';
import { burlingtonClock } from './transit.js';

export const CAR_MIN_ZOOM = -3.25;
const SPEED = [26, 13, 12, 11, 8.5, 11];          // m/s by street class (motorway .. residential, slip road)
const DENSITY = [20, 22, 16, 11, 3, 12];           // cars per km of lane at the busiest hour
const WEIGHT = [6, 6, 4, 3, 1, 3];                // how strongly a turning car prefers each class
const GAP = 3.5, ACCEL = 2.2, BRAKE = 4.5, STOP_LINE = 4, LANE = 1.7, CYCLE = 60, MAX_CARS = 1500;
const WEEKDAY = [.06, .04, .03, .03, .05, .14, .35, .7, .9, .75, .65, .68, .75, .72, .72, .8, .95, 1, .85, .6, .45, .32, .2, .11];
const WEEKEND = [.1, .07, .05, .04, .04, .06, .12, .22, .38, .55, .68, .76, .8, .8, .78, .75, .72, .68, .6, .5, .4, .3, .22, .15];
const PAINT = ['#eef0f1', '#eef0f1', '#f6f5f1', '#1e2226', '#1e2226', '#2b2f36', '#8d949b', '#b9bec4', '#b9bec4', '#5c636b',
  '#9a2a23', '#27457a', '#2f5d4a', '#7a8f9e', '#c9b98f', '#3b4a5a'];

// How busy the streets are, 0..1, for a Burlington clock ({wd: Mon = 0, s: seconds after midnight}).
export function trafficLevel(c) {
  const t = c.wd >= 5 ? WEEKEND : WEEKDAY;
  const h = ((c.s / 3600) % 24 + 24) % 24, i = Math.floor(h), f = h - i;
  return t[i] * (1 - f) + t[(i + 1) % 24] * f;
}

// streets.json -> lanes (one per direction of travel) joined at junctions
export function buildGraph(d) {
  const [lat0, lon0] = d.origin;
  const at = (a, i) => llaToEnu(lat0 + a[i + 1] / 1e5, lon0 + a[i] / 1e5, a[i + 2] / 10);
  const nNodes = d.nodes.length / 3;
  const node = Array.from({ length: nNodes }, (_, i) => at(d.nodes, i * 3));
  const out = Array.from({ length: nNodes }, () => []);
  const lanes = [];
  const lane = (edge, from, to, cls, pts, hidden, back, oneway) => {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const len = cum[cum.length - 1];
    if (len < 0.5) return;
    const unit = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
    const es = pts.map(p => p[0]), ns = pts.map(p => p[1]);
    const l = { id: lanes.length, edge, from, to, cls, pts, cum, len, hidden, back, off: oneway ? 0 : LANE, cars: [],
      d0: unit(pts[0], pts[1]), d1: unit(pts[pts.length - 2], pts[pts.length - 1]),
      bb: [Math.min(...es), Math.min(...ns), Math.max(...es), Math.max(...ns)],
      seed: ((edge * 2654435761 + (back ? 97 : 0)) >>> 0) % 1000 / 1000, live: false, giveWay: false };
    lanes.push(l); out[from].push(l);
  };
  d.edges.forEach(([a, b, cls, oneway, inner, hidden], i) => {
    const pts = [node[a]];
    for (let k = 0; k < inner.length; k += 3) pts.push(at(inner, k));
    pts.push(node[b]);
    lane(i, a, b, cls, pts, hidden, false, oneway);
    if (!oneway) lane(i, b, a, cls, pts.slice().reverse(), hidden, true, oneway);
  });
  // a side street gives way where it meets a bigger one
  const best = new Array(nNodes).fill(9);
  for (const l of lanes) { if (l.cls < best[l.from]) best[l.from] = l.cls; if (l.cls < best[l.to]) best[l.to] = l.cls; }
  const rank = c => (c === 5 ? 3 : c);
  for (const l of lanes) l.giveWay = rank(l.cls) > rank(best[l.to]);
  return { node, out, lanes, signals: new Set(d.signals) };
}

// where a lane is `s` metres along: ground point, direction of travel
export function laneAt(l, s) {
  const { cum, pts } = l;
  let lo = 0, hi = cum.length - 1;
  s = Math.min(Math.max(s, 0), l.len);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi], span = cum[hi] - cum[lo], t = span > 0 ? (s - cum[lo]) / span : 0;
  const de = b[0] - a[0], dn = b[1] - a[1], L = Math.hypot(de, dn) || 1;
  return { e: a[0] + de * t, n: a[1] + dn * t, u: a[2] + (b[2] - a[2]) * t, dir: [de / L, dn / L] };
}

// is the light at the end of this lane red at time t (seconds)? The two cross streets take turns.
export function isRed(g, l, t) {
  if (!g.signals.has(l.to)) return false;
  const phase = ((t + (l.to * 37) % CYCLE) % CYCLE + CYCLE) % CYCLE;
  return Math.abs(l.d1[0]) > Math.abs(l.d1[1]) ? phase >= 27 : !(phase >= 30 && phase < 57);
}

export class Traffic {
  constructor(graph, rng = Math.random) {
    this.g = graph; this.rng = rng; this.cars = []; this.live = []; this.inner = null; this.since = 0;
    this.cells = new Map();
    for (const l of graph.lanes) {
      for (let cx = Math.floor(l.bb[0] / 250); cx <= Math.floor(l.bb[2] / 250); cx++) {
        for (let cy = Math.floor(l.bb[1] / 250); cy <= Math.floor(l.bb[3] / 250); cy++) {
          const k = cx + ',' + cy;
          if (!this.cells.has(k)) this.cells.set(k, []);
          this.cells.get(k).push(l);
        }
      }
    }
  }
  wanted(l, level) { return Math.floor(DENSITY[l.cls] * level * l.len / 1000 + l.seed); }
  // The streets to simulate: those touching `area` ([e0, n0, e1, n1], metres); `inner` is what is on screen.
  // null switches everything off.
  setArea(area, inner, level) {
    const next = new Set();
    if (area) {
      for (let cx = Math.floor(area[0] / 250); cx <= Math.floor(area[2] / 250); cx++) {
        for (let cy = Math.floor(area[1] / 250); cy <= Math.floor(area[3] / 250); cy++) {
          for (const l of this.cells.get(cx + ',' + cy) || []) {
            if (l.bb[2] >= area[0] && l.bb[0] <= area[2] && l.bb[3] >= area[1] && l.bb[1] <= area[3]) next.add(l);
          }
        }
      }
    }
    for (const l of this.live) if (!next.has(l)) { l.live = false; for (const c of l.cars) c.gone = true; l.cars = []; }
    for (const l of next) {
      if (l.live) continue;
      l.live = true;
      // spread along the street, front car first, each with room behind the one ahead
      const n = Math.min(this.wanted(l, level), Math.floor(l.len / 11));
      for (let i = 0; i < n && this.cars.length < MAX_CARS; i++) this.add(l, l.len * (n - i - this.rng() * 0.35) / n, 1);
    }
    this.live = [...next]; this.inner = inner;
    this.cars = this.cars.filter(c => !c.gone);
  }
  add(l, s, alpha) {
    const van = this.rng() < 0.13;
    const c = { lane: l, s, v: SPEED[l.cls] * 0.7, k: 0.82 + this.rng() * 0.3, alpha, next: undefined, fade: 0, gone: false,
      van, len: van ? 5.8 : 4.1 + this.rng() * 0.6, paint: van && this.rng() < 0.6 ? '#f1f1ee' : PAINT[Math.floor(this.rng() * PAINT.length)] };
    l.cars.push(c); this.cars.push(c);
    return c;
  }
  pickNext(l) {
    let total = 0; const opts = [];
    for (const o of this.g.out[l.to]) {
      if (o.edge === l.edge && o.to === l.from) continue;         // no U-turns
      const cos = l.d1[0] * o.d0[0] + l.d1[1] * o.d0[1];
      if (cos < -0.7) continue;
      const w = WEIGHT[o.cls] * (1 + Math.max(0, cos) * 2.5);
      opts.push([o, w, cos]); total += w;
    }
    if (!opts.length) return null;
    let r = this.rng() * total;
    for (const o of opts) { r -= o[1]; if (r <= 0) return o; }
    return opts[opts.length - 1];
  }
  outside(l) { const p = this.g.node[l.from], r = this.inner; return !r || p[0] < r[0] || p[0] > r[2] || p[1] < r[1] || p[1] > r[3]; }
  // move every car on by dt seconds; t is the time (seconds) the lights run on, level how busy it is
  step(dt, t, level) {
    const { g } = this;
    for (const l of this.live) {
      let lead = null;
      for (let i = 0; i < l.cars.length; i++) {
        const c = l.cars[i];
        const toEnd = l.len - c.s;
        let room, want = SPEED[l.cls] * c.k;
        if (lead) room = lead.s - lead.len - GAP - c.s;
        else if (isRed(g, l, t) && toEnd > 0.5) room = toEnd - STOP_LINE;
        else {
          if (c.next === undefined) c.next = this.pickNext(l);
          if (!c.next || !c.next[0].live) room = toEnd + 60;
          else {
            const nl = c.next[0], last = nl.cars[nl.cars.length - 1];
            room = toEnd + (last ? last.s - last.len - GAP : 60);
            if (c.next[2] < 0.8) want = Math.min(want, 3.5 + toEnd * 0.5);            // slow for the turn
          }
          if (l.giveWay) want = Math.min(want, 1.2 + toEnd * 0.55);                    // creep up to the bigger street
        }
        room = Math.max(0, room);
        const safe = Math.sqrt(2 * BRAKE * room);
        const v = Math.min(want, safe);
        c.v = c.v < v ? Math.min(v, c.v + ACCEL * dt) : Math.max(v, c.v - BRAKE * 2 * dt);
        c.s += Math.min(c.v * dt, room);
        if (c.fade) c.alpha += c.fade * dt; else if (c.alpha < 1) c.alpha = Math.min(1, c.alpha + dt * 1.5);
        if (c.alpha <= 0 && c.fade < 0) c.gone = true;
        if (!c.next && c.next !== undefined && toEnd < 25 && !c.fade) c.fade = -1.2;   // a dead end: pull in and park
        if (c.s >= l.len && !lead) {
          l.cars.splice(i, 1); i--;
          const nl = c.next && c.next[0];
          if (!nl || !nl.live) { c.gone = true; continue; }
          const last = nl.cars[nl.cars.length - 1], s = c.s - l.len;
          if (last && last.s - last.len < s + 1) {            // someone slipped in first: wait at the corner
            l.cars.splice(i, 0, c); i++; c.s = l.len; c.v = 0; lead = c;
            continue;
          }
          c.s = s; c.lane = nl; c.next = undefined; nl.cars.push(c);
          continue;
        }
        lead = c;
      }
      if (l.cars.some(c => c.gone)) l.cars = l.cars.filter(c => !c.gone);
    }
    // keep the streets as busy as the hour says: cars drive in from off screen; on screen one only fades in
    // where a street has emptied out
    this.since += dt;
    if (this.since >= 0.5) {
      for (const l of this.live) {
        if (this.cars.length >= MAX_CARS) break;
        const first = l.cars[l.cars.length - 1];
        if (first && first.s - first.len < 9) continue;
        const n = this.wanted(l, level);
        if (this.outside(l)) {
          if (this.rng() < DENSITY[l.cls] * level / 1000 * SPEED[l.cls] * this.since) this.add(l, 0, 1);
        } else if (l.cars.length < n - 1 && this.rng() < 0.15) this.add(l, 0, 0);
        if (l.cars.length > n * 2 + 3) { const c = l.cars[Math.floor(this.rng() * l.cars.length)]; if (!c.fade) c.fade = -1; }
      }
      this.since = 0;
    }
    if (this.cars.some(c => c.gone)) this.cars = this.cars.filter(c => !c.gone);
  }
}

// is the lane hidden behind a building in view `a` at `s` metres along it?
export function isHidden(l, a, s) {
  const h = l.hidden[a], m = l.back ? l.len - s : s;
  for (let i = 0; i < h.length; i += 2) if (m >= h[i] && m <= h[i + 1]) return true;
  return false;
}

export class CarLayer {
  constructor(canvas, map, toLL, getAngle, inRegion, url = 'streets.json') {
    Object.assign(this, { c: canvas, ctx: canvas.getContext('2d'), map, toLL, getAngle, inRegion, url });
    this.on = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.night = 0; this.offsetMs = 0; this.sim = null; this.loading = false; this.zooming = false; this.last = 0; this.shown = 0;
    this.resize(); addEventListener('resize', () => { this.resize(); this.aim(); });
    map.on('zoomstart', () => { this.zooming = true; });
    map.on('zoomend', () => { this.zooming = false; this.aim(); });
    map.on('moveend', () => this.aim());
    requestAnimationFrame(t => this.frame(t));
  }
  resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    this.c.width = innerWidth * d; this.c.height = innerHeight * d; this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  active() { return this.on && this.map._loaded && this.map.getZoom() >= CAR_MIN_ZOOM; }
  clock() { return burlingtonClock(new Date(Date.now() + this.offsetMs)); }
  // tell the simulation which streets are in view (call after the map moves, turns or the layer is switched)
  aim() {
    if (!this.active()) { this.sim?.setArea(null); return; }
    if (!this.sim) { this.load(); return; }
    const a = this.getAngle(), es = [], ns = [];
    for (const [x, y] of [[0, 0], [innerWidth, 0], [0, innerHeight], [innerWidth, innerHeight]]) {
      const ll = this.map.containerPointToLatLng([x, y]);
      for (const u of [0, 110]) { const [e, n] = pxToEnu(a, ll.lng, -ll.lat, u); es.push(e); ns.push(n); }
    }
    const inner = [Math.min(...es), Math.min(...ns), Math.max(...es), Math.max(...ns)];
    this.sim.setArea([inner[0] - 90, inner[1] - 90, inner[2] + 90, inner[3] + 90], inner, trafficLevel(this.clock()));
  }
  async load() {
    if (this.loading) return;
    this.loading = true;
    try {
      const r = await fetch(this.url);
      if (!r.ok) throw new Error(`streets ${r.status}`);
      this.sim = new Traffic(buildGraph(await r.json()));
      this.aim();
    } catch { /* no streets, no cars */ }
  }
  frame(t) {
    requestAnimationFrame(tt => this.frame(tt));
    const { ctx } = this;
    const dt = Math.min(0.1, (t - this.last) / 1000 || 0); this.last = t;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    this.shown = 0;
    if (!this.sim || !this.active()) return;
    const c = this.clock();
    this.sim.step(dt, Date.now() / 1000 + this.offsetMs / 1000, trafficLevel(c));
    if (this.zooming) return;
    const a = this.getAngle(), z = this.map.getZoom(), s = 2 ** z;
    const o = this.map.latLngToContainerPoint(this.toLL(0, 0));
    // the projection is linear: screen = o + s * (E*e + N*n + U*u)
    const E = enuToPx(a, 1, 0, 0), N = enuToPx(a, 0, 1, 0), U = enuToPx(a, 0, 0, 1);
    const P = (e, n, u) => [o.x + s * (E[0] * e + N[0] * n + U[0] * u), o.y + s * (E[1] * e + N[1] * n + U[1] * u)];
    const scale = s / 0.23;
    const todo = [];
    for (const car of this.sim.cars) {
      if (isHidden(car.lane, a, car.s + 1.5) || isHidden(car.lane, a, car.s - car.len - 1.5)) continue;   // nose or tail behind a building
      const p = laneAt(car.lane, car.s - car.len / 2);     // s is the car's nose
      const e = p.e + p.dir[1] * car.lane.off, n = p.n - p.dir[0] * car.lane.off;
      const [x, y] = P(e, n, p.u);
      if (x < -40 || y < -40 || x > innerWidth + 40 || y > innerHeight + 40) continue;
      if (!this.inRegion((x - o.x) / s, (y - o.y) / s)) continue;
      todo.push({ car, e, n, u: p.u, dir: p.dir, y });
    }
    todo.sort((p, q) => p.y - q.y);
    for (const d of todo) this.drawCar(d, P, scale);
    this.shown = todo.length;
  }
  drawCar({ car, e, n, u, dir }, P, scale) {
    const { ctx } = this;
    const grow = Math.max(1, 4.5 / (car.len * scale));       // never smaller than a few pixels
    const [fe, fn] = dir, se = fn, sn = -fe;
    const dim = 1 - this.night * 0.5;
    const shade = (hex, k) => {
      const v = parseInt(hex.slice(1), 16), f = x => Math.round(Math.min(255, x * k * dim));
      return `rgb(${f(v >> 16 & 255)},${f(v >> 8 & 255)},${f(v & 255)})`;
    };
    // a rounded outline (front f1, back f0, half-width w) at height h, as screen points
    const ring = (f0, f1, w, h, r = 0.3) => {
      const c = Math.min(r, w * 0.6);
      return [[f1, w - c], [f1 - c, w], [f0 + c, w], [f0, w - c], [f0, c - w], [f0 + c, -w], [f1 - c, -w], [f1, c - w]]
        .map(([f, sd]) => P(e + (fe * f + se * sd) * grow, n + (fn * f + sn * sd) * grow, u + h * grow));
    };
    const path = pts => { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); };
    const L = car.len / 2, W = car.van ? 1.0 : 0.92, px = car.len * scale * grow;
    const top = car.van ? 2.05 : 0.9;
    ctx.globalAlpha = Math.max(0, Math.min(1, car.alpha));
    if (px < 9) {
      // from far away: a dab of paint, and at night a white dot in front and a red one behind
      const c = (f, sd) => P(e + (fe * f + se * sd) * grow, n + (fn * f + sn * sd) * grow, u + top * 0.6 * grow);
      ctx.fillStyle = shade(car.paint, 0.95); path([c(L, W), c(L, -W), c(-L, -W), c(-L, W)]); ctx.fill();
      if (this.night > 0.3) {
        const a = c(L, 0), b = c(-L, 0);
        ctx.globalAlpha *= this.night;
        ctx.fillStyle = '#fff3c4'; ctx.fillRect(a[0] - 1, a[1] - 1, 2, 2);
        ctx.fillStyle = '#ff3b2f'; ctx.fillRect(b[0] - 0.9, b[1] - 0.9, 1.8, 1.8);
      }
      ctx.globalAlpha = 1;
      return;
    }
    const low = ring(-L, L, W, 0.15), deck = ring(-L, L, W, top);
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; path(low.map(([x, y]) => [x + 1.3 * Math.min(2, grow * scale / 2 + 0.5), y + 1])); ctx.fill();
    {
      const ink = `rgba(18,22,28,${0.75 - this.night * 0.25})`;
      ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(0.9, Math.min(2.2, px * 0.035));
      ctx.fillStyle = shade(car.paint, 0.66); ctx.strokeStyle = ink; path(hull([...low, ...deck])); ctx.fill(); ctx.stroke();
      ctx.fillStyle = shade(car.paint, 1); path(deck); ctx.fill();
      const glass = this.night > 0.5 ? 'rgb(22,28,36)' : 'rgb(38,52,66)';
      if (!car.van) {
        const belt = ring(-L * 0.7, L * 0.34, W * 0.9, top, 0.25), roof = ring(-L * 0.5, L * 0.08, W * 0.74, 1.45, 0.25);
        ctx.fillStyle = glass; path(hull([...belt, ...roof])); ctx.fill(); ctx.stroke();
        ctx.fillStyle = shade(car.paint, 1.1); path(roof); ctx.fill();
      } else {
        // a windscreen band across the front of the roof, and the cab's side glass
        ctx.fillStyle = glass; path(hull([...ring(L * 0.62, L - 0.05, W - 0.05, top, 0.2), ...ring(L * 0.7, L, W, 1.25, 0.2)])); ctx.fill();
        ctx.strokeStyle = 'rgba(18,22,28,0.25)'; path(ring(-L + 0.25, L * 0.55, W - 0.2, top, 0.2)); ctx.stroke();
      }
    }
    if (this.night > 0.3) {
      const side = W * 0.62 * grow;
      const at = (f, sd, h) => P(e + fe * f * grow + se * sd, n + fn * f * grow + sn * sd, u + h * grow);
      const nose = at(L, 0, 0.6), tail = at(-L, 0, 0.7);
      const r = Math.max(0.9, Math.min(2.6, px * 0.06));
      ctx.globalAlpha *= this.night;
      const lamp = (p, color, rr) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p[0], p[1], rr, 0, 7); ctx.fill(); };
      if (nose[1] >= tail[1] - 1) {
        const ahead = at(L + 6, 0, 0), R = Math.max(4, 7 * scale * grow);
        const g = ctx.createRadialGradient(ahead[0], ahead[1], 0, ahead[0], ahead[1], R);
        g.addColorStop(0, 'rgba(255,238,180,0.42)'); g.addColorStop(1, 'rgba(255,238,180,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(ahead[0], ahead[1], R, R * 0.6, 0, 0, 7); ctx.fill();
        lamp(at(L, side, 0.6), '#fff3c4', r); lamp(at(L, -side, 0.6), '#fff3c4', r);
      }
      if (tail[1] >= nose[1] - 1) { lamp(at(-L, side, 0.7), '#ff3b2f', r * 0.8); lamp(at(-L, -side, 0.7), '#ff3b2f', r * 0.8); }
    }
    ctx.globalAlpha = 1;
  }
}

// the outline of a set of screen points (convex hull)
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
