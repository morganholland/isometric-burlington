// Local moments: snow lying on the ground, fireworks over the waterfront on July 3 and New Year's Eve,
// Champ surfacing in the lake now and then, and holiday lights on the Church Street Marketplace.
// They follow Burlington's calendar and clock; a link can ask for one (#...&m=fireworks) on any day.
import { llaToEnu, enuToPx } from './geo.js';
import { burlingtonClock } from './transit.js';

export const MOMENTS = ['fireworks', 'champ', 'holiday'];
const LAKE_U = -0.9;                                     // the lake's surface (m, ENU up)
export const FW_SITE = [44.4790, -73.2262];              // the barge off Waterfront Park
// open water inside the drawn area in all four views, nearest the waterfront first
export const CHAMP_SPOTS = [[44.4772, -73.2275], [44.4850, -73.2330], [44.4700, -73.2280], [44.4740, -73.2320], [44.4620, -73.2320], [44.4900, -73.2440]];
const CHAMP_EVERY = 300, CHAMP_FOR = 40;                 // seconds: a chance to surface every 5 minutes, for 40 s
const MARKET = [44.4762, 44.4806];                       // Church Street Marketplace: Main Street to Pearl Street
const BULBS = ['#ff5a4e', '#ffd25a', '#5ad16a', '#5aa8ff', '#ff8ae0', '#fff3c4'];
const hash = i => ((Math.imul(i | 0, 2654435761) >>> 0) / 4294967296);

// ---------- snow on the ground ----------
// 0 with less than a centimetre lying, 1 from ten centimetres
export function snowCover(depthM) {
  if (depthM == null || !Number.isFinite(depthM)) return 0;
  return Math.max(0, Math.min(1, (depthM - 0.01) / 0.09));
}
// how white the map is: a chosen weather decides it; live, the measured depth does (or, without one,
// a little while it is snowing)
export function groundSnow(mode, depthM, falling) {
  if (mode === 'snow') return 1;
  if (mode !== 'live') return 0;
  if (depthM != null && Number.isFinite(depthM)) return snowCover(depthM);
  return falling ? 0.4 : 0;
}
export async function fetchSnowDepth(signal) {
  const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=44.47&longitude=-73.15&current=snow_depth', { signal });
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  const d = (await r.json())?.current?.snow_depth;
  if (typeof d !== 'number') throw new Error('no snow depth');
  return d;
}

// ---------- the calendar ----------
// which moments are on at this instant, by Burlington's clock
export function momentsAt(date = new Date()) {
  const { ymd, s } = burlingtonClock(date);
  const md = ymd.slice(4), h = s / 3600;
  const fireworks = (md === '0703' && h >= 21.25 && h < 22.25) ||       // Independence Day, over the lake
    (md === '1231' && h >= 23.75) || (md === '0101' && h < 0.33);       // New Year
  const holiday = md >= '1120' || md === '0101';        // late November to New Year's Day
  return { fireworks, holiday, champ: champAt(date.getTime() / 1000) };
}
// Champ: every five minutes there is a chance it surfaces, at one of the lake spots, for 40 seconds.
// Gives { spot, t } with t running 0..1 while it is up, or null.
export function champAt(epochS) {
  const k = Math.floor(epochS / CHAMP_EVERY), into = epochS - k * CHAMP_EVERY;
  if (into >= CHAMP_FOR || hash(k + 7) >= 0.45) return null;
  return { spot: Math.floor(hash(k + 101) * CHAMP_SPOTS.length), t: into / CHAMP_FOR };
}

// ---------- drawing ----------
export class MomentLayer {
  constructor(canvas, map, toLL, getAngle, inRegion) {
    Object.assign(this, { c: canvas, ctx: canvas.getContext('2d'), map, toLL, getAngle, inRegion });
    // like the cars, these start switched off for people who ask for less motion
    this.on = !matchMedia('(prefers-reduced-motion: reduce)').matches; this.forced = null; this.night = 0; this.offsetMs = 0; this.zooming = false;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.shells = []; this.sparks = []; this.nextShell = 0; this.bulbs = null; this.champBox = null;
    this.drawn = { fireworks: 0, champ: false, holiday: 0 };
    this.onShown = () => {}; this.onFrame = () => {};
    this.last = performance.now();
    this.resize(); addEventListener('resize', () => this.resize());
    map.on('zoomstart', () => { this.zooming = true; });
    map.on('zoomend', () => { this.zooming = false; });
    requestAnimationFrame(t => this.frame(t));
  }
  resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    this.c.width = innerWidth * d; this.c.height = innerHeight * d; this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  // the Marketplace's stretch of Church Street, from labels.json: bulbs every 2.5 m on both sides
  useStreets(streets) {
    const bulbs = [];
    for (const [name, , pts, hidden] of streets) {
      if (name !== 'Church Street') continue;
      const enu = pts.map(([la, lo, h]) => llaToEnu(la, lo, h));
      for (let i = 0; i + 1 < pts.length; i++) {
        const [e0, n0, u0] = enu[i], [e1, n1, u1] = enu[i + 1];
        const len = Math.hypot(e1 - e0, n1 - n0); if (!len) continue;
        const px = -(n1 - n0) / len, py = (e1 - e0) / len;
        for (let d = 0; d < len; d += 2.5) {
          const t = d / len, lat = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
          if (lat < MARKET[0] || lat > MARKET[1]) continue;
          for (const side of [-1, 1]) {
            const k = bulbs.length;
            bulbs.push({ e: e0 + (e1 - e0) * t + px * 5 * side, n: n0 + (n1 - n0) * t + py * 5 * side, u: u0 + (u1 - u0) * t + 3 + hash(k) * 2.5,
              p: i + t, hidden: hidden || [[], [], [], []], color: BULBS[Math.floor(hash(k + 3) * BULBS.length)], ph: hash(k + 9) * 6.283 });
          }
        }
      }
    }
    this.bulbs = bulbs;
  }
  now() { return new Date(Date.now() + this.offsetMs); }
  active() {
    // a moment a link asks for comes on top of whatever Burlington's calendar has on
    const on = momentsAt(this.now());
    if (this.forced === 'fireworks') on.fireworks = true;
    if (this.forced === 'holiday') on.holiday = true;
    if (this.forced === 'champ') on.champ = { spot: 0, t: this.reduced ? 0.5 : ((Date.now() / 1000) % CHAMP_FOR) / CHAMP_FOR * 0.7 + 0.15 };
    return on;
  }
  // screen = origin + E*e + N*n + U*u (the projection is linear): worked out once a frame
  basis() {
    const a = this.getAngle();
    const p = (e, n, u) => { const [x, y] = enuToPx(a, e, n, u); return this.map.latLngToContainerPoint(this.toLL(x, y)); };
    // Leaflet rounds screen points to whole pixels, so measure each axis over a kilometre
    const K = 1000, o = p(0, 0, 0), E = p(K, 0, 0), N = p(0, K, 0), U = p(0, 0, K);
    const B = { ox: o.x, oy: o.y, ex: (E.x - o.x) / K, ey: (E.y - o.y) / K, nx: (N.x - o.x) / K, ny: (N.y - o.y) / K, ux: (U.x - o.x) / K, uy: (U.y - o.y) / K };
    B.at = (e, n, u) => [B.ox + B.ex * e + B.nx * n + B.ux * u, B.oy + B.ey * e + B.ny * n + B.uy * u];
    B.mpx = Math.max(Math.hypot(B.ex, B.ey), Math.hypot(B.nx, B.ny));   // screen px per metre across the screen
    return B;
  }
  frame(t) {
    requestAnimationFrame(tt => this.frame(tt));
    const dt = Math.min(0.05, (t - this.last) / 1000); this.last = t;
    const { ctx } = this;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    this.drawn = { fireworks: 0, champ: false, holiday: 0 }; this.champBox = null;
    if (!this.on || !this.map._loaded || this.zooming) { this.shells.length = 0; this.sparks.length = 0; return; }
    const on = this.active();
    const B = this.basis(), a = this.getAngle();
    const near = ([x, y], m = 1) => x > -innerWidth * m && y > -innerHeight * m && x < innerWidth * (1 + m) && y < innerHeight * (1 + m);
    // lights and fireworks are night things, even when a link asks for them: choosing day puts them out
    const dark = this.night > 0.35;
    if (on.holiday && dark && this.bulbs && this.map.getZoom() >= -3.25) this.holiday(B, a, t);
    if (!dark) { this.shells.length = 0; this.sparks.length = 0; }
    else if (on.fireworks || this.sparks.length) {
      const [fe, fn] = llaToEnu(FW_SITE[0], FW_SITE[1], 0);
      if (near(B.at(fe, fn, 150), 0.5)) this.fireworks(B, dt, on.fireworks, fe, fn);
      else { this.shells.length = 0; this.sparks.length = 0; }
    }
    if (on.champ) this.champ(B, on.champ, t);
    for (const k of MOMENTS) if (k === 'champ' ? this.drawn.champ : this.drawn[k] > 0) this.onShown(k);
    this.onFrame();
  }
  holiday(B, a, t) {
    const { ctx } = this;
    const r = Math.max(1.5, Math.min(3.5, B.mpx * 0.5));
    ctx.globalCompositeOperation = 'lighter';
    for (const b of this.bulbs) {
      const h = b.hidden[a];
      let hid = false; for (let i = 0; i < h.length; i += 2) if (b.p >= h[i] && b.p <= h[i + 1]) { hid = true; break; }
      if (hid) continue;
      const [x, y] = B.at(b.e, b.n, b.u);
      if (x < -10 || y < -10 || x > innerWidth + 10 || y > innerHeight + 10) continue;
      const tw = this.reduced ? 0.85 : 0.65 + 0.35 * Math.sin(t / 420 + b.ph);
      ctx.globalAlpha = 0.35 * tw; ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, 6.283); ctx.fill();
      ctx.globalAlpha = tw;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
      this.drawn.holiday++;
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  fireworks(B, dt, launching, fe, fn) {
    const { ctx } = this;
    const now = performance.now() / 1000;
    if (this.reduced) {
      // less motion: three bursts held still in the sky, nothing launching or flashing
      if (launching && !this.sparks.length) for (const [de, dn, top, hue] of [[-40, 10, 230, 350], [30, -20, 270, 45], [5, 35, 200, 200]]) {
        const n = 48;
        for (let i = 0; i < n; i++) {
          const z = 1 - 2 * (i + 0.5) / n, rr = Math.sqrt(1 - z * z), ph = i * 2.39996, d = 45;
          this.sparks.push({ ce: fe + de, cn: fn + dn, cu: top, e: Math.cos(ph) * rr * d, n: Math.sin(ph) * rr * d, u: z * d, ve: 0, vn: 0, vu: 0, life: 0.4, max: 1e9, hue, drag: 0 });
        }
      }
      if (!launching) this.sparks.length = 0;
    } else if (launching && now >= this.nextShell) {
      this.shells.push({ e: fe + (Math.random() - 0.5) * 60, n: fn + (Math.random() - 0.5) * 60, top: 200 + Math.random() * 110, t: 0, rise: 1.2 + Math.random() * 0.5,
        hue: Math.floor(Math.random() * 360), kind: Math.random() < 0.3 ? 'willow' : 'peony' });
      this.nextShell = now + (this.reduced ? 1.6 : 0.3 + Math.random() * 0.7);
    }
    const g = 9.8 * 0.55;
    ctx.globalCompositeOperation = 'lighter';
    // rising shells: a short climbing streak
    for (const s of this.shells) {
      s.t += dt;
      const k = Math.min(1, s.t / s.rise), u = LAKE_U + (s.top - LAKE_U) * (1 - (1 - k) * (1 - k));
      const [x, y] = B.at(s.e, s.n, u), [x0, y0] = B.at(s.e, s.n, Math.max(LAKE_U, u - 14));
      ctx.strokeStyle = 'rgba(255,220,170,0.8)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x, y); ctx.stroke();
      if (k >= 1) {
        s.done = true;
        const n = this.reduced ? 36 : 70, speed = s.kind === 'willow' ? 38 : 58;
        for (let i = 0; i < n; i++) {
          // an even spread over a sphere
          const z = 1 - 2 * (i + 0.5) / n, rr = Math.sqrt(1 - z * z), ph = i * 2.39996;
          const v = speed * (0.85 + Math.random() * 0.3);
          this.sparks.push({ ce: s.e, cn: s.n, cu: s.top, e: 0, n: 0, u: 0, ve: Math.cos(ph) * rr * v, vn: Math.sin(ph) * rr * v, vu: z * v, life: 0,
            max: (s.kind === 'willow' ? 2.6 : 1.7) + Math.random() * 0.4, hue: s.hue + (Math.random() - 0.5) * 30, drag: s.kind === 'willow' ? 1.6 : 1.1 });
        }
      }
    }
    this.shells = this.shells.filter(s => !s.done);
    const r = Math.max(1.4, Math.min(3, B.mpx * 0.6));
    // zoomed out, a real-size burst is a speck: draw each burst at least ~70 px across, about its centre
    const k = Math.max(1, 70 / (60 * B.mpx));
    const at = p => { const [cx, cy] = B.at(p.ce, p.cn, p.cu); return [cx + (B.ex * p.e + B.nx * p.n + B.ux * p.u) * k, cy + (B.ey * p.e + B.ny * p.n + B.uy * p.u) * k]; };
    for (const p of this.sparks) {
      const [x0, y0] = at(p);
      if (!this.reduced) {
        p.e += p.ve * dt; p.n += p.vn * dt; p.u += p.vu * dt;
        const d = Math.exp(-p.drag * dt); p.ve *= d; p.vn *= d; p.vu = p.vu * d - g * dt;
      }
      if (!this.reduced) p.life += dt;
      const [x, y] = at(p);
      const fade = Math.max(0, 1 - p.life / p.max);
      ctx.strokeStyle = ctx.fillStyle = `hsla(${p.hue},100%,${55 + 20 * fade}%,${fade})`;
      ctx.lineWidth = r; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x + (x - x0) * 0.5, y + (y - y0) * 0.5); ctx.stroke();
      if (fade > 0.8) { ctx.globalAlpha = (fade - 0.8) * 0.6; ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, 6.283); ctx.fill(); ctx.globalAlpha = 1; }
      this.drawn.fireworks++;
    }
    this.sparks = this.sparks.filter(p => p.life < p.max && p.cu + p.u * k > LAKE_U);
    ctx.globalCompositeOperation = 'source-over';
  }
  // three humps and a head, in the drawing's ink, rising out of the water and sinking back
  champ(B, c, t) {
    const [la, lo] = CHAMP_SPOTS[c.spot];
    const [e, n] = llaToEnu(la, lo, 0);
    const [x, y] = B.at(e, n, LAKE_U);
    if (x < -80 || y < -80 || x > innerWidth + 80 || y > innerHeight + 80) return;
    const { ctx } = this;
    const s = Math.max(1.1, Math.min(5, B.mpx));               // body ~60 m long, never too small to spot
    const up = this.reduced ? 1 : Math.min(1, c.t / 0.15, (1 - c.t) / 0.15);      // surfacing and diving (or simply there)
    const bob = this.reduced ? 0 : Math.sin(t / 600) * 1.2 * s;
    const dir = Math.sign(B.ex) || 1;                          // swim the same way on screen in every view
    const ink = '#14201a', body = this.night > 0.5 ? '#4f7a62' : '#5e9a6e', belly = this.night > 0.5 ? '#6f9a80' : '#9cc79f';
    ctx.save(); ctx.translate(x, y); ctx.scale(dir, 1);
    // ripples
    ctx.strokeStyle = `rgba(240,248,250,${0.8 * up})`; ctx.lineWidth = Math.max(1.2, s * 0.8);
    for (const [hx, w] of [[-26, 9], [-12, 8], [2, 8], [16, 6]]) { ctx.beginPath(); ctx.ellipse(hx * s, 1.5 * s, w * s, 2 * s, 0, 0, 6.283); ctx.stroke(); }
    // clip at the waterline so it comes up out of the lake
    ctx.beginPath(); ctx.rect(-60 * s, -60 * s, 120 * s, 61 * s); ctx.clip();
    ctx.translate(0, (1 - up) * 22 * s + bob);
    ctx.lineWidth = Math.max(1, 1.1 * s); ctx.strokeStyle = ink; ctx.lineJoin = 'round';
    const hump = (cx, w, h) => {
      ctx.beginPath(); ctx.moveTo(cx - w, 0); ctx.bezierCurveTo(cx - w, -h * 1.3, cx + w, -h * 1.3, cx + w, 0); ctx.closePath();
      ctx.fillStyle = body; ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - w * 0.6, -1); ctx.bezierCurveTo(cx - w * 0.5, -h * 0.5, cx + w * 0.5, -h * 0.5, cx + w * 0.6, -1);
      ctx.fillStyle = belly; ctx.fill();
    };
    hump(-26 * s, 6 * s, 5 * s); hump(-12 * s, 6.5 * s, 7 * s); hump(2 * s, 6 * s, 6 * s);
    // neck and head
    ctx.beginPath();
    ctx.moveTo(10 * s, 0); ctx.bezierCurveTo(12 * s, -10 * s, 14 * s, -18 * s, 20 * s, -19 * s);
    ctx.quadraticCurveTo(26 * s, -19.5 * s, 27 * s, -16.5 * s); ctx.quadraticCurveTo(23 * s, -15 * s, 19 * s, -14.5 * s);
    ctx.bezierCurveTo(17 * s, -10 * s, 17 * s, -4 * s, 18 * s, 0); ctx.closePath();
    ctx.fillStyle = body; ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#f4f0dc'; ctx.beginPath(); ctx.arc(21.5 * s, -17.6 * s, 1.1 * s, 0, 6.283); ctx.fill();
    ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(21.8 * s, -17.6 * s, 0.55 * s, 0, 6.283); ctx.fill();
    ctx.restore();
    if (up > 0.3) {
      const x0 = dir > 0 ? x - 34 * s : x - 28 * s, x1 = dir > 0 ? x + 28 * s : x + 34 * s;
      this.champBox = { x0: Math.min(x0, x1) - 6, x1: Math.max(x0, x1) + 6, y0: y - 22 * s - 6, y1: y + 6 };
      this.drawn.champ = true;
    }
  }
  hit(x, y) {
    const b = this.champBox;
    return b && x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 ? { champ: true } : null;
  }
  describe() {
    return { name: 'Champ', long: "Lake Champlain's monster. People have reported sightings since the 1800s; the best-known photo was taken in 1977.", until: 'A legend, drawn here for fun', color: '#4f7d5f' };
  }
}
