// Green Mountain Transit buses, moved along their routes by the published timetable (GMT's live
// positions need an API key). Drawn as small 3D boxes on one canvas over the map.
import { llaToEnu, enuToPx } from './geo.js';

const DAY = 86400;
const BOX = { len: 12.2, wid: 2.6, hgt: 3.2 };   // a 40-ft bus, metres

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
    const off = new Set(data.holidays?.[d.ymd] || []);
    for (const tr of data.trips) {
      const [rid, mask, si, tl] = tr;
      if (!(mask >> d.wd & 1) || off.has(mask)) continue;
      if (d.s < tl[0] || d.s >= tl[tl.length - 2]) continue;
      let i = 0;
      while (i + 2 < tl.length - 2 && tl[i + 2] <= d.s) i += 2;
      const t0 = tl[i], t1 = tl[i + 2], d0 = tl[i + 1], d1 = tl[i + 3];
      const dist = t1 > t0 ? d0 + (d1 - d0) * (d.s - t0) / (t1 - t0) : d0;
      const p = pointAlong(data.shapes[si], dist);
      if (p) out.push({ trip: tr, route: rid, ...p });
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

export function prepare(data) {
  for (const sh of data.shapes) for (const p of sh) { const [e, n, u] = llaToEnu(p[0], p[1], p[2]); p.push(e, n, u); }
  return data;
}

export class BusLayer {
  constructor(canvas, map, toLL, getAngle, inRegion) {
    Object.assign(this, { c: canvas, ctx: canvas.getContext('2d'), map, toLL, getAngle, inRegion });
    this.data = null; this.on = true; this.night = 0; this.offsetMs = 0; this.drawn = []; this.lastPaint = 0;
    this.resize(); addEventListener('resize', () => this.resize());
    requestAnimationFrame(t => this.frame(t));
  }
  resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    this.c.width = innerWidth * d; this.c.height = innerHeight * d; this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  async load(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`transit ${r.status}`);
    this.data = prepare(await r.json());
  }
  screen(e, n, u) {
    const [x, y] = enuToPx(this.getAngle(), e, n, u);
    return this.map.latLngToContainerPoint(this.toLL(x, y));
  }
  frame(t) {
    requestAnimationFrame(tt => this.frame(tt));
    if (t - this.lastPaint < 66) return;              // ~15 fps is plenty for buses
    this.lastPaint = t;
    const { ctx } = this;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    this.drawn = [];
    if (!this.on || !this.data) return;
    const z = this.map.getZoom();
    const scale = 2 ** z / 0.23;                       // screen px per metre
    const grow = Math.max(1, 7 / (BOX.len * scale));   // keep a bus at least ~7 px long when zoomed out
    const angle = this.getAngle();
    for (const b of busesAt(this.data, burlingtonClock(new Date(Date.now() + this.offsetMs)))) {
      const [px, py] = enuToPx(angle, b.e, b.n, b.u);
      if (!this.inRegion(px, py)) continue;
      const c = this.map.latLngToContainerPoint(this.toLL(px, py));
      if (c.x < -40 || c.y < -40 || c.x > innerWidth + 40 || c.y > innerHeight + 40) continue;
      this.drawBus(b, grow);
      this.drawn.push({ x: c.x, y: c.y, b });
    }
  }
  drawBus(b, grow) {
    const { ctx } = this;
    const [fe, fn] = b.dir, se = fn, sn = -fe;          // forward and right (ENU)
    const L = BOX.len * grow / 2, W = BOX.wid * grow / 2, H = BOX.hgt * grow;
    const base = [[L, W], [L, -W], [-L, -W], [-L, W]].map(([f, s]) => [b.e + fe * f + se * s, b.n + fn * f + sn * s]);
    const bot = base.map(([e, n]) => this.screen(e, n, b.u));
    const top = base.map(([e, n]) => this.screen(e, n, b.u + H));
    const color = this.data.routes[b.route]?.[1] || '#c8472f';
    const shade = (hex, k) => {
      const v = parseInt(hex.slice(1), 16), f = x => Math.round(Math.min(255, x * k * (1 - this.night * 0.45)));
      return `rgb(${f(v >> 16 & 255)},${f(v >> 8 & 255)},${f(v & 255)})`;
    };
    // shadow, then the sides that face the viewer (screen y of their midpoint further down = nearer), then the roof
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath(); bot.forEach((p, i) => i ? ctx.lineTo(p.x + 1.5, p.y + 1) : ctx.moveTo(p.x + 1.5, p.y + 1)); ctx.closePath(); ctx.fill();
    const faces = [0, 1, 2, 3].map(i => ({ i, j: (i + 1) % 4, y: (bot[i].y + bot[(i + 1) % 4].y) / 2 })).sort((a, b2) => a.y - b2.y);
    for (const { i, j } of faces) {
      const front = i === 0;                          // the face between corners 0 and 1 is the bus's nose
      ctx.fillStyle = front ? shade('#202833', 1) : shade(color, 0.72);
      ctx.beginPath(); ctx.moveTo(bot[i].x, bot[i].y); ctx.lineTo(bot[j].x, bot[j].y); ctx.lineTo(top[j].x, top[j].y); ctx.lineTo(top[i].x, top[i].y); ctx.closePath(); ctx.fill();
      if (!front && Math.hypot(bot[j].x - bot[i].x, bot[j].y - bot[i].y) > 10) {
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
    if (this.night > 0.3) {
      const nose = { x: (bot[0].x + bot[1].x) / 2, y: (bot[0].y + bot[1].y) / 2 };
      const g = ctx.createRadialGradient(nose.x, nose.y, 0, nose.x, nose.y, 10 * Math.min(grow, 2));
      g.addColorStop(0, `rgba(255,236,170,${0.7 * this.night})`); g.addColorStop(1, 'rgba(255,236,170,0)');
      ctx.fillStyle = g; ctx.fillRect(nose.x - 24, nose.y - 24, 48, 48);
    }
  }
  // the bus under a screen point, if any
  hit(x, y) {
    let best = null, bd = 16;
    for (const d of this.drawn) { const dd = Math.hypot(d.x - x, d.y - y); if (dd < bd) { bd = dd; best = d; } }
    return best;
  }
  describe(d) {
    const r = this.data.routes[d.b.route] || ['?', '#888', ''];
    const tl = d.b.trip[3];
    const end = tl[tl.length - 2] % DAY;
    const hh = Math.floor(end / 3600), mm = String(Math.floor(end % 3600 / 60)).padStart(2, '0');
    return { name: `Route ${r[0]}`, long: r[2], color: r[1], until: `${(hh + 11) % 12 + 1}:${mm} ${hh < 12 || hh >= 24 ? 'am' : 'pm'}` };
  }
}
