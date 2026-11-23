// Green Mountain Transit buses, moved along their routes by the published timetable (GMT's live
// positions need an API key). Drawn as small 3D boxes on one canvas over the map.
import { llaToEnu, enuToPx } from './geo.js';

const DAY = 86400;
const BOX = { len: 12.2, wid: 2.6, hgt: 3.2 };   // a 40-ft bus, metres
// the Ethan Allen Express: a locomotive and five coaches, metres
export const TRAIN = { cars: [21, 26, 26, 26, 26, 26], gap: 1.5, wid: 3.1, hgt: 4.3 };

// "now" in Burlington: service date (YYYYMMDD), weekday bit (Mon = 0) and seconds after midnight
export function burlingtonClock(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(date).map(x => [x.type, x.value]));
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return { ymd: `${p.year}${p.month}${p.day}`, wd, s: +p.hour * 3600 + +p.minute * 60 + +p.second + date.getMilliseconds() / 1000 };
}

function prevDay(ymd) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) - 1));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

// Where every bus on the road is at clock c: [{trip, route, e, n, u, dir:[de, dn]}]
export function busesAt(data, c) {
  const out = [];
  const days = [{ ymd: c.ymd, wd: c.wd, s: c.s }, { ymd: prevDay(c.ymd), wd: (c.wd + 6) % 7, s: c.s + DAY }];
  for (const d of days) {
    const ex = data.dates?.[d.ymd];
    const off = new Set(ex?.off || []), on = new Set(ex?.on || []);
    for (const tr of data.trips) {
      const [, svc, si, tl] = tr;
      if (!((data.services[svc] >> d.wd & 1) || on.has(svc)) || off.has(svc)) continue;
      if (d.s < tl[0] || d.s >= tl[tl.length - 2]) continue;
      let i = 0;
      while (i + 2 < tl.length - 2 && tl[i + 2] <= d.s) i += 2;
      const t0 = tl[i], t1 = tl[i + 2], d0 = tl[i + 1], d1 = tl[i + 3];
      const dist = t1 > t0 ? d0 + (d1 - d0) * (d.s - t0) / (t1 - t0) : d0;
      const p = pointAlong(data.shapes[si], dist);
      if (p) out.push({ trip: tr, route: tr[0], si, dist, ...p });
    }
  }
  return out;
}

// shape points are [lat, lon, h, metres_along, e, n, u] once prepared
function pointAlong(sh, dist) {
  if (!sh || sh.length < 2 || dist < sh[0][3] || dist > sh[sh.length - 1][3]) return null;
  let lo = 0, hi = sh.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sh[m][3] <= dist) lo = m; else hi = m; }
  const a = sh[lo], b = sh[hi];
  const de = b[4] - a[4], dn = b[5] - a[5], chord = Math.hypot(de, dn), span = b[3] - a[3];
  if (span > chord * 1.6 + 60) return null;          // a stretch cut out because it is off the map
  const t = span > 0 ? (dist - a[3]) / span : 0;
  return { e: a[4] + de * t, n: a[5] + dn * t, u: a[6] + (b[6] - a[6]) * t, dir: chord > 0 ? [de / chord, dn / chord] : [1, 0] };
}

// a train's cars at clock time: [{e, n, u, dir, len, k}], the locomotive (k = 0) at the head. The cars
// trail behind the head along the track; at the start of the track the whole train is moved up so it fits.
export function trainCars(sh, dist) {
  const len = TRAIN.cars.reduce((a, b) => a + b + TRAIN.gap, 0);
  let head = Math.max(dist, sh[0][3] + len);
  head = Math.min(head, sh[sh.length - 1][3]);
  const out = [];
  let back = 0;
  TRAIN.cars.forEach((l, k) => {
    const p = pointAlong(sh, head - back - l / 2);
    back += l + TRAIN.gap;
    if (p) out.push({ ...p, len: l, k });
  });
  return out;
}

// the train's own file joined onto the buses': shape and service numbers of the second shift past the first's
export function mergeTransit(a, b) {
  const ns = a.shapes.length, nv = a.services.length;
  const dates = structuredClone(a.dates || {});
  for (const [ymd, ex] of Object.entries(b.dates || {})) {
    const d = dates[ymd] ||= { off: [], on: [] };
    d.off.push(...(ex.off || []).map(i => i + nv)); d.on.push(...(ex.on || []).map(i => i + nv));
  }
  return {
    routes: { ...a.routes, ...b.routes },
    shapes: [...a.shapes, ...b.shapes],
    services: [...a.services, ...b.services],
    trips: [...a.trips, ...b.trips.map(t => [t[0], t[1] + nv, t[2] + ns, ...t.slice(3)])],
    dates,
  };
}

export function prepare(data) {
  for (const sh of data.shapes) for (const p of sh) { const [e, n, u] = llaToEnu(p[0], p[1], p[2]); p.push(e, n, u); }
  return data;
}

export class BusLayer {
  constructor(canvas, map, toLL, getAngle, inRegion) {
    Object.assign(this, { c: canvas, ctx: canvas.getContext('2d'), map, toLL, getAngle, inRegion });
    this.data = null; this.on = true; this.night = 0; this.offsetMs = 0;
    this.buses = []; this.drawn = []; this.lastLookup = -1e9; this.zooming = false;
    this.resize(); addEventListener('resize', () => this.resize());
    // Leaflet keeps the old zoom and origin until a zoom animation ends: hide buses meanwhile
    map.on('zoomstart', () => { this.zooming = true; });
    map.on('zoomend', () => { this.zooming = false; });
    requestAnimationFrame(t => this.frame(t));
  }
  resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    this.c.width = innerWidth * d; this.c.height = innerHeight * d; this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  async load(url, trainUrl) {
    const get = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`transit ${r.status}`); return r.json(); };
    const [bus, train] = await Promise.all([get(url), trainUrl ? get(trainUrl).catch(() => null) : null]);
    this.data = prepare(train ? mergeTransit(bus, train) : bus);
  }
  screen(e, n, u) {
    const [x, y] = enuToPx(this.getAngle(), e, n, u);
    return this.map.latLngToContainerPoint(this.toLL(x, y));
  }
  // the timetable is looked up ~15 times a second; buses are redrawn every frame so they stay on the
  // streets while the map is dragged
  frame(t) {
    requestAnimationFrame(tt => this.frame(tt));
    const { ctx } = this;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    this.drawn = [];
    if (!this.on || !this.data || !this.map._loaded || this.zooming) return;
    if (t - this.lastLookup > 66) {
      this.lastLookup = t;
      this.buses = busesAt(this.data, burlingtonClock(new Date(Date.now() + this.offsetMs)));
    }
    const z = this.map.getZoom();
    const scale = 2 ** z / 0.23;                       // screen px per metre
    const grow = Math.max(1, 7 / (BOX.len * scale));   // keep a bus at least ~7 px long when zoomed out
    const angle = this.getAngle();
    const todo = [];
    const things = [];
    for (const b of this.buses) {
      if (this.data.routes[b.route]?.[3] !== 'train') { things.push(b); continue; }
      for (const c of trainCars(this.data.shapes[b.si], b.dist)) things.push({ ...b, ...c, train: true });
    }
    for (const b of things) {
      const [px, py] = enuToPx(angle, b.e, b.n, b.u);
      if (!this.inRegion(px, py)) continue;
      const g = this.geometry(b, b.train ? 1 : grow);
      if (g.box.x1 < 0 || g.box.y1 < 0 || g.box.x0 > innerWidth || g.box.y0 > innerHeight) continue;
      todo.push({ b, g });
    }
    todo.sort((p, q) => p.g.depth - q.g.depth);          // farther (higher on screen) first
    for (const d of todo) {
      this.drawBus(d.b, d.g);
      this.drawn.push({ x: (d.g.box.x0 + d.g.box.x1) / 2, y: (d.g.box.y0 + d.g.box.y1) / 2, box: d.g.box, b: d.b });
    }
    if (this.onFrame) this.onFrame();
  }
  geometry(b, grow) {
    const [fe, fn] = b.dir, se = fn, sn = -fe;          // forward and right (ENU)
    const L = (b.len || BOX.len) * grow / 2, W = (b.train ? TRAIN.wid : BOX.wid) * grow / 2, H = (b.train ? TRAIN.hgt : BOX.hgt) * grow;
    const base = [[L, W], [L, -W], [-L, -W], [-L, W]].map(([f, s]) => [b.e + fe * f + se * s, b.n + fn * f + sn * s]);
    const bot = base.map(([e, n]) => this.screen(e, n, b.u));
    const top = base.map(([e, n]) => this.screen(e, n, b.u + H));
    const xs = [...bot, ...top].map(p => p.x), ys = [...bot, ...top].map(p => p.y);
    return { bot, top, depth: (bot[0].y + bot[2].y) / 2,
      box: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }, grow };
  }
  drawBus(b, { bot, top, grow }) {
    const { ctx } = this;
    // Amtrak: silver coaches, a dark blue locomotive
    const color = b.train ? (b.k === 0 ? '#2f4a6d' : '#c3cad1') : this.data.routes[b.route]?.[1] || '#c8472f';
    const shade = (hex, k) => {
      const v = parseInt(hex.slice(1), 16), f = x => Math.round(Math.min(255, x * k * (1 - this.night * 0.45)));
      return `rgb(${f(v >> 16 & 255)},${f(v >> 8 & 255)},${f(v & 255)})`;
    };
    // shadow, then the sides that face the viewer (screen y of their midpoint further down = nearer), then the roof
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath(); bot.forEach((p, i) => i ? ctx.lineTo(p.x + 1.5, p.y + 1) : ctx.moveTo(p.x + 1.5, p.y + 1)); ctx.closePath(); ctx.fill();
    const faces = [0, 1, 2, 3].map(i => ({ i, j: (i + 1) % 4, y: (bot[i].y + bot[(i + 1) % 4].y) / 2 })).sort((a, b2) => a.y - b2.y);
    for (const { i, j } of faces) {
      const front = i === 0 && (!b.train || b.k === 0);   // the face between corners 0 and 1 is the nose
      ctx.fillStyle = front ? shade('#202833', 1) : shade(color, b.train ? 0.8 : 0.72);
      ctx.beginPath(); ctx.moveTo(bot[i].x, bot[i].y); ctx.lineTo(bot[j].x, bot[j].y); ctx.lineTo(top[j].x, top[j].y); ctx.lineTo(top[i].x, top[i].y); ctx.closePath(); ctx.fill();
      if (i % 2 === 1 && Math.hypot(bot[j].x - bot[i].x, bot[j].y - bot[i].y) > 10) {   // windows down the long sides
        // a band of windows, lit at night
        const m = (p, q, k) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
        const a0 = m(bot[i], top[i], 0.55), a1 = m(bot[j], top[j], 0.55), b0 = m(bot[i], top[i], 0.85), b1 = m(bot[j], top[j], 0.85);
        ctx.fillStyle = this.night > 0.5 ? 'rgba(255,226,150,0.85)' : 'rgba(30,42,56,0.55)';
        ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y); ctx.lineTo(b1.x, b1.y); ctx.lineTo(b0.x, b0.y); ctx.closePath(); ctx.fill();
      }
    }
    ctx.fillStyle = shade(color, 1.05);
    ctx.beginPath(); top.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.75; ctx.stroke();
    const nose = { x: (bot[0].x + bot[1].x) / 2, y: (bot[0].y + bot[1].y) / 2 };
    const tail = (bot[2].y + bot[3].y) / 2;
    if (this.night > 0.3 && nose.y > tail && (!b.train || (b.k === 0 && b.trip[5] !== 'parked'))) {   // a parked train is dark             // headlights only when the nose faces the viewer
      const g = ctx.createRadialGradient(nose.x, nose.y, 0, nose.x, nose.y, 10 * Math.min(grow, 2));
      g.addColorStop(0, `rgba(255,236,170,${0.7 * this.night})`); g.addColorStop(1, 'rgba(255,236,170,0)');
      ctx.fillStyle = g; ctx.fillRect(nose.x - 24, nose.y - 24, 48, 48);
    }
  }
  // the bus under a screen point, if any
  hit(x, y) {
    let best = null, bd = Infinity;
    for (const d of this.drawn) {
      const { x0, x1, y0, y1 } = d.box, pad = 6;
      if (x < x0 - pad || x > x1 + pad || y < y0 - pad || y > y1 + pad) continue;
      const dd = Math.hypot(d.x - x, d.y - y);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  }
  describe(d) {
    const r = this.data.routes[d.b.route] || ['?', '#888', ''];
    const tl = d.b.trip[3];
    const clock = t => {
      t %= DAY;
      const hh = Math.floor(t / 3600), mm = String(Math.floor(t % 3600 / 60)).padStart(2, '0');
      return `${(hh + 11) % 12 + 1}:${mm} ${hh < 12 ? 'am' : 'pm'}`;
    };
    const end = clock(tl[tl.length - 2]);
    if (r[3] === 'train') {
      const [, , , , num, sign] = d.b.trip;
      if (sign === 'parked') return { name: `Amtrak ${r[2]}`, long: 'Parked at Union Station for the night', color: '#2f4a6d', until: `On the timetable, leaves for New York at ${end}` };
      return { name: `Amtrak ${r[2]}`, long: sign === 'Burlington' ? `Train ${num} from New York to Burlington` : `Train ${num} from Burlington to New York`,
        color: '#2f4a6d', until: sign === 'Burlington' ? `On the timetable, due at Union Station at ${end}` : `On the timetable, due in New York at ${end}` };
    }
    return { name: `Route ${r[0]}`, long: r[2], color: r[1], until: `On the timetable, in service until ${end}` };
  }
}
