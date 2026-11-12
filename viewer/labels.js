// Street, neighbourhood, park and water names, drawn as crisp text over the drawing on one canvas.
// The drawing has a real resolution (23 cm a pixel) and goes soft past it; these are drawn fresh at
// any zoom, so zooming in always has something sharp to show. Data: viewer/labels.json (pipeline/labels.py).
import { latLonToPx } from './geo.js';

// smallest zoom each kind of name appears at (0 = the drawing's native size; the map opens at -2.5)
const STREET_MIN = [-2.75, -2.25, -1.75, -1.0];   // by rank: main road .. side street
const RIVER_MIN = -5.25;
const AREA_ZOOM = { hood: [-4.75, 0.25], park: [-2.25, 99], water: [-4, 99], lake: [-6.5, 99] };
const LAKE = ['Lake Champlain', 'lake', 44.4700, -73.2520, -0.3];
const GROUND = 0.4;          // 0 = text upright on screen, 1 = text lying flat on the ground

const FONT = {
  street: z => `600 ${Math.round(Math.min(17, Math.max(11.5, 13.5 + z * 1.4)))}px "IBM Plex Sans", system-ui, sans-serif`,
  river: z => `italic 500 ${Math.round(Math.min(18, Math.max(12, 14 + z)))}px "IBM Plex Serif", Georgia, serif`,
  hood: z => `700 ${Math.round(Math.min(17, Math.max(11, 15 + z * 0.8)))}px "Bricolage Grotesque", system-ui, sans-serif`,
  park: z => `italic 500 ${Math.round(Math.min(16, Math.max(11, 13 + z)))}px "IBM Plex Serif", Georgia, serif`,
  water: z => `italic 500 ${Math.round(Math.min(18, Math.max(12, 14 + z)))}px "IBM Plex Serif", Georgia, serif`,
  lake: z => `italic 500 ${Math.round(Math.min(32, Math.max(19, 27 + z * 1.4)))}px "IBM Plex Serif", Georgia, serif`,
};
const INK = { street: '#1c2731', river: '#1d4f73', hood: '#3a2a22', park: '#2d5527', water: '#1d4f73', lake: '#e8f1f2' };

export class LabelLayer {
  constructor(canvas, map, toLL, getAngle, inRegion) {
    Object.assign(this, { c: canvas, ctx: canvas.getContext('2d'), map, toLL, getAngle, inRegion });
    this.data = null; this.on = true; this.night = 0; this.zooming = false; this.pending = false;
    this.widths = new Map();
    this.reserved = () => [];          // screen boxes other things (place pins) already hold
    this.skip = new Set();             // area names shown some other way (a place pin of the same name)
    this.resize(); addEventListener('resize', () => { this.resize(); this.draw(); });
    map.on('zoomstart', () => { this.zooming = true; this.clear(); });
    map.on('zoomend', () => { this.zooming = false; this.draw(); });
    map.on('move viewreset', () => this.draw());
    // the webfonts arrive after the first draw
    document.fonts?.ready.then(() => { this.widths.clear(); this.draw(); });
  }
  resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    this.dpr = d; this.c.width = innerWidth * d; this.c.height = innerHeight * d;
  }
  use(d) {
    // map pixels for all four views, worked out once
    const proj = pts => [0, 1, 2, 3].map(a => pts.map(([la, lo, h]) => latLonToPx(a, la, lo, h)));
    this.streets = d.streets.map(([name, rank, pts, hidden], id) => {
      const px = proj(pts);
      const bb = px.map(ps => ps.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]));
      return { id, name, rank, kind: rank === 9 ? 'river' : 'street', px, bb, hidden: hidden || [[], [], [], []] };
    });
    // longer, more important streets get first claim on the space
    this.streets.sort((a, b) => a.rank - b.rank || b.px[0].length - a.px[0].length || a.id - b.id);
    this.areas = [...d.areas, LAKE].filter(([name]) => !this.skip.has(name)).map(([name, kind, la, lo, h]) => ({ name, kind, px: [0, 1, 2, 3].map(a => latLonToPx(a, la, lo, h)) }));
    this.data = d;
    this.draw();
  }
  // the canvas lives in a map pane (under the place pins), which Leaflet moves while dragging: keep it
  // pinned to the screen
  pin() {
    if (!this.map._loaded) return;
    const p = this.map.containerPointToLayerPoint([0, 0]);
    this.c.style.transform = `translate3d(${p.x}px,${p.y}px,0)`;
  }
  clear() { this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, this.c.width, this.c.height); }
  draw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.render(); });
  }
  width(font, text) {
    const k = font + '|' + text;
    if (!this.widths.has(k)) { this.ctx.font = font; this.widths.set(k, this.ctx.measureText(text).width); }
    return this.widths.get(k);
  }
  render() {
    this.clear();
    this.placed = []; this.shown = []; this.spots = [];
    if (!this.on || !this.data || !this.map._loaded || this.zooming) return;
    this.pin();
    this.reserved_ = this.reserved();
    const { ctx, map } = this;
    const z = map.getZoom(), s = 2 ** z, a = this.getAngle();
    const o = map.latLngToContainerPoint(this.toLL(0, 0));
    const W = innerWidth, H = innerHeight;
    const toScreen = (x, y) => [o.x + x * s, o.y + y * s];
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    // the view in map pixels, with a margin
    const v0 = [(-o.x - 200) / s, (-o.y - 200) / s], v1 = [(W - o.x + 200) / s, (H - o.y + 200) / s];
    const seen = (bb) => bb[2] >= v0[0] && bb[0] <= v1[0] && bb[3] >= v0[1] && bb[1] <= v1[1];

    // big area names first (neighbourhoods, the lake), so streets fit around them
    for (const ar of this.areas) {
      const [lo, hi] = AREA_ZOOM[ar.kind];
      if (z < lo || z > hi) continue;
      const [x, y] = ar.px[a];
      if (ar.kind !== 'lake' && !this.inRegion(x, y)) continue;
      const [sx, sy] = toScreen(x, y);
      if (sx < -200 || sy < -50 || sx > W + 200 || sy > H + 50) continue;
      const font = FONT[ar.kind](z);
      const text = ar.kind === 'hood' ? ar.name.toUpperCase() : ar.name;
      const spacing = ar.kind === 'hood' ? 2.5 : 0;
      const w = this.width(font, text) + spacing * text.length, h = parseInt(font.match(/(\d+)px/)[1], 10);
      const box = { x0: sx - w / 2 - 4, x1: sx + w / 2 + 4, y0: sy - h / 2 - 3, y1: sy + h / 2 + 3 };
      if (this.hits(box)) continue;
      this.placed.push(box); this.shown.push(text);
      this.text(text, font, INK[ar.kind], [sx, sy], [1, 0], [0, 1], spacing, ar.kind);
    }

    for (const st of this.streets) {
      const zmin = st.kind === 'river' ? RIVER_MIN : STREET_MIN[st.rank];
      if (z < zmin || !seen(st.bb[a])) continue;
      const font = FONT[st.kind](z);
      const w = this.width(font, st.name), pad = 10;
      const pts = st.px[a];
      // distance along the line, in map pixels; labels sit at fixed points along it so they hold still while dragging
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const len = cum[cum.length - 1] * s;
      if (len < w + 2 * pad) continue;
      const every = Math.max(w * 4, st.kind === 'river' ? 900 : 520) / s;   // map px between repeats
      const first = (cum[cum.length - 1] % every) / 2;
      for (let d = Math.max(first, (w / 2 + pad) / s); d <= cum[cum.length - 1] - (w / 2 + pad) / s; d += every) {
        const half = (w / 2 + pad) / s;
        const p0 = at(pts, cum, d - half), p1 = at(pts, cum, d + half), pm = at(pts, cum, d);
        if (!this.inRegion(pm[0], pm[1])) continue;
        // not where a building stands in front of the street in this view: the name would sit on its roof
        if (covered(st.hidden[a], cum, d - half, d + half)) continue;
        const [sx, sy] = toScreen(pm[0], pm[1]);
        if (sx < -w || sy < -w || sx > W + w || sy > H + w) continue;
        // only along a fairly straight stretch
        let dx = p1[0] - p0[0], dy = p1[1] - p0[1];
        const chord = Math.hypot(dx, dy);
        if (chord < 2 * half * 0.93) continue;
        if (dx < 0) { dx = -dx; dy = -dy; }
        const ux = dx / chord, uy = dy / chord;
        // text lies partly on the ground: this view squashes the ground's depth to half height, so a
        // street's ground perpendicular shows on screen as G; blend it with the upright perpendicular P
        const Px = -uy, Py = ux, Gx = -2 * uy, Gy = 0.5 * ux;
        let yx = Px * (1 - GROUND) + Gx * GROUND, yy = Py * (1 - GROUND) + Gy * GROUND;
        const yl = Math.hypot(yx, yy), lim = Math.min(1.05, Math.max(0.62, yl));
        yx *= lim / yl; yy *= lim / yl;
        const h = parseInt(font.match(/(\d+)px/)[1], 10);
        const ex = Math.abs(ux) * (w / 2 + 3) + Math.abs(yx) * (h / 2 + 2), ey = Math.abs(uy) * (w / 2 + 3) + Math.abs(yy) * (h / 2 + 2);
        const box = { x0: sx - ex, x1: sx + ex, y0: sy - ey, y1: sy + ey };
        if (this.hits(box)) continue;
        this.placed.push(box); this.shown.push(st.name); this.spots.push({ st, a, d0: d - half, d1: d + half, cum });
        this.text(st.name, font, INK[st.kind], [sx, sy], [ux, uy], [yx, yy], 0, st.kind);
      }
    }
  }
  // for tests: drawn names whose stretch of street a building covers (should be none)
  audit() {
    return this.spots.filter(p => covered(p.st.hidden[p.a], p.cum, p.d0, p.d1)).map(p => p.st.name);
  }
  hits(b) {
    for (const p of this.reserved_ || []) if (b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0) return true;
    for (const p of this.placed) if (b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0) return true;
    return false;
  }
  text(text, font, ink, [x, y], [ax, ay], [bx, by], spacing, kind) {
    const { ctx } = this, d = this.dpr;
    ctx.setTransform(ax * d, ay * d, bx * d, by * d, x * d, y * d);
    ctx.font = font;
    if (spacing) ctx.letterSpacing = `${spacing}px`;
    // a soft paper halo keeps the ink readable over any part of the drawing; at night the names turn
    // to pale lettering on a dark halo, like a lit map
    const night = this.night > 0.5;
    ctx.strokeStyle = kind === 'lake' || night ? 'rgba(10,22,40,.55)' : kind === 'water' || kind === 'river'
      ? 'rgba(226,238,242,.75)' : 'rgba(250,246,236,.88)';
    ctx.lineWidth = kind === 'hood' || kind === 'lake' ? 4 : 3.2;
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = night && kind !== 'lake' ? mix(ink, '#f4ecd8', 0.85) : ink;
    ctx.globalAlpha = kind === 'hood' ? 0.85 : 1;
    ctx.fillText(text, 0, 0);
    ctx.globalAlpha = 1;
    if (spacing) ctx.letterSpacing = '0px';
  }
}

// does a [p0, p1, p0, p1, ...] list of hidden stretches (p = point index + fraction) cover more than a
// sliver of the distance range d0..d1 along the line?
function covered(h, cum, d0, d1) {
  if (!h.length) return false;
  const param = d => {
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
    return lo + (cum[hi] > cum[lo] ? (d - cum[lo]) / (cum[hi] - cum[lo]) : 0);
  };
  let n = 0;
  for (let k = 0; k <= 8; k++) {
    const p = param(d0 + (d1 - d0) * k / 8);
    for (let i = 0; i < h.length; i += 2) if (p >= h[i] && p <= h[i + 1]) { n++; break; }
  }
  return n > 1;
}

// point at distance d along a polyline
function at(pts, cum, d) {
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
  const t = cum[hi] > cum[lo] ? (d - cum[lo]) / (cum[hi] - cum[lo]) : 0;
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t];
}

function mix(a, b, t) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
}
