// What glows after dark: street lamps and the pools of light under them, lit windows, the airport's
// runway and taxiway lights, and the blinking lights on the breakwater. Data: viewer/lights.json
// (pipeline/streetlife.py). Drawn on one canvas that sits just over the night tint, under the names.
import { llaToEnu, enuToPx } from './geo.js';

const LAMP_MIN = -4.75, WINDOW_MIN = -3.25, CELL = 512;
const LAMP_H = 8, POOL_M = 12;
const GLASS = ['#ffd98a', '#ffe7b3', '#ffc76a', '#fff1cf', '#cfe2ff'];
const hash = i => ((i * 2654435761) >>> 0) / 4294967296;

// The share of windows still lit at a given hour (0..24) of the night: full in the evening, few by 3 am.
export function litShare(hour) {
  const pts = [[0, .35], [2, .16], [5, .12], [6.5, .5], [16, 1], [21.5, 1], [24, .35]];
  for (let i = 1; i < pts.length; i++) {
    if (hour <= pts[i][0]) { const [h0, v0] = pts[i - 1], [h1, v1] = pts[i]; return v0 + (v1 - v0) * (hour - h0) / (h1 - h0); }
  }
  return .35;
}

function sprite(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, inner); g.addColorStop(0.45, outer); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return c;
}

class Points {
  constructor(flat, origin) {
    this.n = flat.length / 4;
    this.enu = new Float32Array(this.n * 3); this.flag = new Uint8Array(this.n);
    let x = 0, y = 0, h = 0;                              // stored as differences from the point before
    for (let i = 0; i < this.n; i++) {
      x += flat[i * 4]; y += flat[i * 4 + 1]; h += flat[i * 4 + 2];
      const [e, n, u] = llaToEnu(origin[0] + y / 1e5, origin[1] + x / 1e5, h / 10);
      this.enu.set([e, n, u], i * 3); this.flag[i] = flat[i * 4 + 3];
    }
    this.views = [];
  }
  // map pixels in view a, bucketed in a grid, worked out the first time that view is shown
  view(a) {
    if (!this.views[a]) {
      const xy = new Float32Array(this.n * 2), cells = new Map();
      for (let i = 0; i < this.n; i++) {
        const [x, y] = enuToPx(a, this.enu[i * 3], this.enu[i * 3 + 1], this.enu[i * 3 + 2]);
        xy[i * 2] = x; xy[i * 2 + 1] = y;
        const k = Math.floor(x / CELL) * 65536 + Math.floor(y / CELL);
        let l = cells.get(k); if (!l) cells.set(k, l = []); l.push(i);
      }
      this.views[a] = { xy, cells, inside: new Uint8Array(this.n) };      // inside: 0 not yet asked, 1 in the drawn region, 2 not
    }
    return this.views[a];
  }
  // is point i inside the drawn region in view a? (asked once per point: the region's outline is long)
  inRegion(a, i, test) {
    const v = this.view(a);
    if (!v.inside[i]) v.inside[i] = test(v.xy[i * 2], v.xy[i * 2 + 1]) ? 1 : 2;
    return v.inside[i] === 1;
  }
  each(a, v0, v1, fn) {
    const { xy, cells } = this.view(a);
    for (let cx = Math.floor(v0[0] / CELL); cx <= Math.floor(v1[0] / CELL); cx++) {
      for (let cy = Math.floor(v0[1] / CELL); cy <= Math.floor(v1[1] / CELL); cy++) {
        const l = cells.get(cx * 65536 + cy);
        if (l) for (const i of l) fn(i, xy[i * 2], xy[i * 2 + 1]);
      }
    }
  }
}

export class LightLayer {
  constructor(canvas, map, toLL, getAngle, inRegion, url = 'lights.json') {
    Object.assign(this, { c: canvas, ctx: canvas.getContext('2d'), map, toLL, getAngle, inRegion, url });
    this.night = 0; this.share = 1; this.data = null; this.loading = false; this.zooming = false; this.pending = false;
    this.count = { lamps: 0, windows: 0, field: 0, beacons: 0 };
    this.pool = sprite('rgba(255,206,128,0.55)', 'rgba(255,190,110,0.2)');
    this.halo = sprite('rgba(255,236,190,0.95)', 'rgba(255,214,150,0.3)');
    this.resize(); addEventListener('resize', () => { this.resize(); this.draw(); });
    map.on('zoomstart', () => { this.zooming = true; this.clear(); });
    map.on('zoomend', () => { this.zooming = false; this.draw(); });
    map.on('move viewreset', () => this.draw());
    setInterval(() => { if (this.night > 0.05 && this.blinking) this.draw(); }, 500);
  }
  resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    this.dpr = d; this.c.width = innerWidth * d; this.c.height = innerHeight * d;
  }
  // night 0..1; share = how many of the windows are lit (see litShare)
  set(night, share = 1) {
    this.night = night; this.share = share;
    this.c.style.opacity = Math.min(1, Math.max(0, (night - 0.12) / 0.6)).toFixed(3);
    if (night > 0.05 && !this.data) this.load();
    this.draw();
  }
  async load() {
    if (this.loading) return;
    this.loading = true;
    try {
      const r = await fetch(this.url);
      if (!r.ok) throw new Error(`lights ${r.status}`);
      const d = await r.json();
      this.data = Object.fromEntries(['lamps', 'windows', 'field', 'beacons'].map(k => [k, new Points(d[k] || [], d.origin)]));
      this.draw();
    } catch { setTimeout(() => { this.loading = false; }, 60000); /* a dark night, then; ask again in a minute */ }
  }
  pin() {
    const p = this.map.containerPointToLayerPoint([0, 0]);
    this.c.style.transform = `translate3d(${p.x}px,${p.y}px,0)`;
  }
  clear() { this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, this.c.width, this.c.height); }
  draw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.render(); });
  }
  render(ctx = this.ctx, now = Date.now()) {
    if (ctx === this.ctx) this.clear();
    this.count = { lamps: 0, windows: 0, field: 0, beacons: 0 };
    this.blinking = false;                                 // is a blinking light in view? only then redraw on a timer
    if (!this.data || this.night <= 0.05 || !this.map._loaded || this.zooming) return;
    if (ctx === this.ctx) { this.pin(); ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
    const { map, data, count } = this;
    const z = map.getZoom(), s = 2 ** z, scale = s / 0.23, a = this.getAngle(), bit = 1 << a;
    const o = map.latLngToContainerPoint(this.toLL(0, 0));
    const W = innerWidth, H = innerHeight, pad = 60 + 30 * scale;
    const v0 = [(-o.x - pad) / s, (-o.y - pad) / s], v1 = [(W - o.x + pad) / s, (H - o.y + pad) / s];
    const up = Math.cos(Math.PI / 6) * scale;              // screen pixels per metre of height
    ctx.globalCompositeOperation = 'lighter';

    if (z >= LAMP_MIN) {
      const rp = POOL_M * scale, head = Math.max(1, 0.32 * scale);
      data.lamps.each(a, v0, v1, (i, x, y) => {
        if (!(data.lamps.flag[i] & bit) || !data.lamps.inRegion(a, i, this.inRegion)) return;
        const sx = o.x + x * s, sy = o.y + y * s;
        count.lamps++;
        const hy = sy - LAMP_H * up;
        if (rp >= 7) { ctx.globalAlpha = 0.5; ctx.drawImage(this.pool, sx - rp, sy - rp / 2, rp * 2, rp); }
        else { ctx.globalAlpha = 0.22; ctx.fillStyle = '#ffc878'; ctx.fillRect(sx - rp * 0.7, sy - rp * 0.35, rp * 1.4, rp * 0.7); }   // far off: a smudge of light
        if (head > 1.6) { ctx.globalAlpha = 0.9; ctx.drawImage(this.halo, sx - head * 3, hy - head * 3, head * 6, head * 6); }
        else { ctx.globalAlpha = rp >= 3 ? 0.9 : 0.6; ctx.fillStyle = '#ffdca0'; ctx.fillRect(sx - 0.7, hy - 0.7, 1.4, 1.4); }
      });
    }

    if (z >= WINDOW_MIN) {
      const w = Math.max(1.1, 1.0 * scale), h = Math.max(1.4, 1.5 * scale);
      const paths = GLASS.map(() => new Path2D());
      data.windows.each(a, v0, v1, (i, x, y) => {
        if (!(data.windows.flag[i] & bit) || hash(i) > this.share || !data.windows.inRegion(a, i, this.inRegion)) return;
        count.windows++;
        paths[Math.floor(hash(i + 7919) * 4.3)].rect(o.x + x * s - w / 2, o.y + y * s - h / 2, w, h);
      });
      ctx.globalAlpha = 0.92;
      paths.forEach((p, k) => { ctx.fillStyle = GLASS[k]; ctx.fill(p); });
      if (w > 5) {                                        // close up: a soft spill of light round each window
        ctx.globalAlpha = 0.16; ctx.lineWidth = w * 0.7; ctx.lineJoin = 'round';
        paths.forEach((p, k) => { ctx.strokeStyle = GLASS[k]; ctx.stroke(p); });
      }
    }

    const dot = (sx, sy, r, color, alpha) => {
      ctx.globalAlpha = alpha; ctx.fillStyle = color;
      if (r < 1.3) ctx.fillRect(sx - r, sy - r, r * 2, r * 2); else { ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.fill(); }
    };
    data.field.each(a, v0, v1, (i, x, y) => {
      count.field++;
      dot(o.x + x * s, o.y + y * s, Math.max(1.3, 0.5 * scale), data.field.flag[i] ? '#6f9bff' : '#fff6dc', 1);
    });
    data.beacons.each(a, v0, v1, (i, x, y) => {
      this.blinking = true;
      const kind = data.beacons.flag[i], t = now / 1000 + i * 1.7;
      const flash = kind === 3 ? true : kind === 0 ? t % 4 < 1.2 : t % 2.5 < 1.25;
      if (!flash) return;
      count.beacons++;
      const color = kind === 3 ? (t % 3 < 1.5 ? '#ffffff' : '#7dffa0') : ['#ffffff', '#ff4a3d', '#5dff8f'][kind];
      const sx = o.x + x * s, sy = o.y + y * s, r = Math.max(2.4, 0.9 * scale);
      ctx.globalAlpha = 0.8; ctx.drawImage(this.halo, sx - r * 7, sy - r * 7, r * 14, r * 14);
      dot(sx, sy, r, color, 1);
    });
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
}
