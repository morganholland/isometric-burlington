// Screen-space weather: rain, snow, fog and drifting cloud shadows, drawn on one canvas.
export class WeatherFX {
  constructor(canvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.kind = 'clear'; this.heavy = false; this.wind = { x: 0.4, y: 0 }; this.parts = []; this.clouds = [];
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.last = performance.now();
    this.resize(); addEventListener('resize', () => this.resize());
    requestAnimationFrame(t => this.frame(t));
  }
  resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth; this.h = innerHeight;
    this.c.width = this.w * d; this.c.height = this.h * d; this.ctx.setTransform(d, 0, 0, d, 0, 0);
    this.reseed();
  }
  set(kind, heavy, windMph = 5, windFromDeg = 270, screenRotDeg = 0) {
    // wind blows FROM windFromDeg; screen rotation turns compass into screen space
    const to = (windFromDeg + 180 - screenRotDeg) * Math.PI / 180;
    const s = Math.min(1.5, 0.15 + windMph / 15);
    this.wind = { x: Math.sin(to) * s, y: -Math.cos(to) * s * 0.5 };
    const changed = kind !== this.kind || heavy !== this.heavy;
    this.kind = kind; this.heavy = heavy;
    if (changed) this.reseed();
  }
  reseed() {
    const area = this.w * this.h / 1e4;
    const n = this.kind === 'rain' || this.kind === 'storm' ? area * (this.heavy ? 5 : 2.6)
      : this.kind === 'snow' ? area * (this.heavy ? 3.2 : 1.6) : 0;
    this.parts = Array.from({ length: Math.round(this.reduced ? n * 0.3 : n) }, () => this.spawn(true));
    const nc = { cloudy: 9, partly: 5, rain: 8, storm: 10, snow: 8, fog: 4 }[this.kind] || 0;
    this.clouds = Array.from({ length: nc }, () => ({ x: Math.random() * this.w * 1.4 - this.w * 0.2, y: Math.random() * this.h, r: 160 + Math.random() * 320 }));
  }
  spawn(anywhere) {
    return { x: Math.random() * this.w, y: anywhere ? Math.random() * this.h : -10, z: 0.4 + Math.random() * 0.6, p: Math.random() * 6.28 };
  }
  frame(t) {
    const dt = Math.min(0.05, (t - this.last) / 1000); this.last = t;
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    // cloud shadows drift with the wind
    if (this.clouds.length) {
      const dark = { cloudy: 0.10, rain: 0.12, storm: 0.16, snow: 0.08, partly: 0.08, fog: 0.04 }[this.kind] || 0;
      for (const c of this.clouds) {
        if (!this.reduced) { c.x += this.wind.x * 14 * dt; c.y += this.wind.y * 14 * dt; }
        if (c.x - c.r > w) c.x = -c.r; if (c.x + c.r < 0) c.x = w + c.r;
        if (c.y - c.r > h) c.y = -c.r; if (c.y + c.r < 0) c.y = h + c.r;
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
        g.addColorStop(0, `rgba(20,28,40,${dark})`); g.addColorStop(1, 'rgba(20,28,40,0)');
        ctx.fillStyle = g; ctx.fillRect(c.x - c.r, c.y - c.r, c.r * 2, c.r * 2);
      }
    }
    if (this.kind === 'fog') {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(214,222,228,0.55)'); g.addColorStop(1, 'rgba(214,222,228,0.25)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    if (this.kind === 'rain' || this.kind === 'storm') {
      ctx.strokeStyle = 'rgba(190,210,230,0.55)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const p of this.parts) {
        const vx = this.wind.x * 120, vy = 700 * p.z;
        if (!this.reduced) { p.x += vx * dt; p.y += vy * dt; }
        if (p.y > h || p.x < -20 || p.x > w + 20) Object.assign(p, this.spawn(false), { x: Math.random() * w });
        ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - vx * 0.02, p.y - vy * 0.02);
      }
      ctx.stroke();
    } else if (this.kind === 'snow') {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      for (const p of this.parts) {
        p.p += dt * 1.5;
        if (!this.reduced) { p.x += (this.wind.x * 40 + Math.sin(p.p) * 14) * dt; p.y += 45 * p.z * dt; }
        if (p.y > h) Object.assign(p, this.spawn(false));
        if (p.x > w) p.x -= w; if (p.x < 0) p.x += w;
        ctx.beginPath(); ctx.arc(p.x, p.y, 1 + p.z * 1.6, 0, 6.283); ctx.fill();
      }
    }
    requestAnimationFrame(tt => this.frame(tt));
  }
}
