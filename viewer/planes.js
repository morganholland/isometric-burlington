// Live aircraft over the map (adsb.lol, or adsb.fi as a fallback, via /api/flights), drawn at their altitude with a shadow on the
// ground, and moved smoothly between updates by their speed and track.
import { llaToEnu, enuToPx } from './geo.js';

const FT = 0.3048, KT = 0.514444;
const GEOID = -29.3;            // sea level -> ellipsoid height here
const SHADOW_U = 45;            // typical ground height (m, ENU up) for the shadow

// where an aircraft is `dt` seconds after its report, by dead reckoning
export function extrapolate(a, dt) {
  const t = Math.max(0, Math.min(dt, 60));           // never guess more than a minute ahead
  const d = a.ground && a.gs < 3 ? 0 : (a.gs || 0) * KT * t;
  const tr = (a.track ?? 0) * Math.PI / 180;
  const dn = d * Math.cos(tr), de = d * Math.sin(tr);
  const lat = a.lat + dn / 111132;
  const lon = a.lon + de / (111320 * Math.cos(a.lat * Math.PI / 180));
  const altFt = a.ground ? 0 : Math.max(0, (a.altFt ?? 0) + (a.vr || 0) * t / 60);
  return { lat, lon, altFt };
}

export class PlaneLayer {
  constructor(canvas, map, toLL, getAngle, url = 'api/flights') {
    Object.assign(this, { c: canvas, ctx: canvas.getContext('2d'), map, toLL, getAngle, url });
    this.on = true; this.night = 0; this.list = []; this.fetchedAt = 0; this.drawn = []; this.zooming = false; this.failures = 0;
    this.resize(); addEventListener('resize', () => this.resize());
    map.on('zoomstart', () => { this.zooming = true; });
    map.on('zoomend', () => { this.zooming = false; });
    this.poll();
    requestAnimationFrame(t => this.frame(t));
  }
  resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    this.c.width = innerWidth * d; this.c.height = innerHeight * d; this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  async poll() {
    if (this.on && document.visibilityState !== 'hidden') {
      try {
        const r = await fetch(this.url, { cache: 'no-store' });
        const j = await r.json();
        this.list = j.ac || []; this.fetchedAt = performance.now(); this.failures = 0;
      } catch { this.failures++; }
    }
    // back off when the service is unreachable
    setTimeout(() => this.poll(), Math.min(120000, 10000 * 2 ** Math.min(this.failures, 4)));
  }
  screen(lat, lon, u) {
    const [e, n] = llaToEnu(lat, lon, 0);
    const [x, y] = enuToPx(this.getAngle(), e, n, u);
    return this.map.latLngToContainerPoint(this.toLL(x, y));
  }
  frame() {
    requestAnimationFrame(t => this.frame(t));
    const { ctx } = this;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    this.drawn = [];
    if (!this.on || !this.list.length || !this.map._loaded || this.zooming) return;
    const since = (performance.now() - this.fetchedAt) / 1000;
    const size = Math.max(14, Math.min(40, 36 * 2 ** this.map.getZoom()));
    for (const a of this.list) {
      const p = extrapolate(a, since + (a.age || 0));
      const u = p.altFt * FT + GEOID;
      const air = this.screen(p.lat, p.lon, Math.max(u, SHADOW_U));
      const gnd = this.screen(p.lat, p.lon, SHADOW_U);
      const tr = (a.track ?? 0) * Math.PI / 180;
      const ahead = this.screen(p.lat + Math.cos(tr) * 0.001, p.lon + Math.sin(tr) * 0.0014, Math.max(u, SHADOW_U));
      const rot = Math.atan2(ahead.y - air.y, ahead.x - air.x) + Math.PI / 2;     // nose up = 0
      const onScreen = q => q.x > -60 && q.y > -60 && q.x < innerWidth + 60 && q.y < innerHeight + 60;
      if (!onScreen(air) && !onScreen(gnd)) continue;
      if (onScreen(gnd)) this.silhouette(gnd.x, gnd.y, rot, size * 0.9, 'rgba(10,20,30,0.28)');
      if (!a.ground && onScreen(air) && onScreen(gnd)) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(gnd.x, gnd.y); ctx.lineTo(air.x, air.y); ctx.stroke(); ctx.setLineDash([]);
      }
      if (onScreen(air)) {
        this.silhouette(air.x, air.y, rot, size, this.night > 0.5 ? '#f3f6fa' : '#ffffff', 'rgba(20,32,44,0.55)');
        if (this.night > 0.3) {                         // beacon
          ctx.fillStyle = `rgba(255,70,60,${0.5 + 0.5 * Math.sin(performance.now() / 180)})`;
          ctx.beginPath(); ctx.arc(air.x, air.y, 2, 0, 6.283); ctx.fill();
        }
        this.drawn.push({ x: air.x, y: air.y, r: size * 0.7, a, altFt: p.altFt });
      }
    }
  }
  silhouette(x, y, rot, s, fill, stroke) {
    const { ctx } = this;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s / 24, s / 24);
    ctx.beginPath();
    // a simple airliner, nose up, 24 units long
    ctx.moveTo(0, -12); ctx.quadraticCurveTo(1.6, -10, 1.6, -6);
    ctx.lineTo(1.6, -2); ctx.lineTo(11, 3); ctx.lineTo(11, 5); ctx.lineTo(1.6, 2.5);
    ctx.lineTo(1.4, 8); ctx.lineTo(4.5, 10.5); ctx.lineTo(4.5, 12); ctx.lineTo(0, 11);
    ctx.lineTo(-4.5, 12); ctx.lineTo(-4.5, 10.5); ctx.lineTo(-1.4, 8); ctx.lineTo(-1.6, 2.5);
    ctx.lineTo(-11, 5); ctx.lineTo(-11, 3); ctx.lineTo(-1.6, -2); ctx.lineTo(-1.6, -6);
    ctx.quadraticCurveTo(-1.6, -10, 0, -12); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.2 * 24 / s; ctx.stroke(); }
    ctx.restore();
  }
  hit(x, y) {
    let best = null, bd = Infinity;
    for (const d of this.drawn) { const dd = Math.hypot(d.x - x, d.y - y); if (dd < Math.max(12, d.r) && dd < bd) { bd = dd; best = d; } }
    return best;
  }
  describe(d) {
    const a = d.a;
    const alt = a.ground ? 'on the ground' : `${Math.round(d.altFt / 100) * 100 > 0 ? (Math.round(d.altFt / 100) * 100).toLocaleString('en-US') + ' ft' : 'low'}`;
    return { name: a.flight || a.id.toUpperCase(), long: [a.type, alt, a.gs ? `${Math.round(a.gs)} kt` : ''].filter(Boolean).join(' · '), until: 'Live position (ADS-B)', color: '#ffffff' };
  }
}
