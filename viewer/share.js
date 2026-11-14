// Share a link to exactly this view, and save a picture of it.

// The address of a view. `time` is 'live', 'day' or 'night': a forced time of day travels with the link,
// so a night view opens as night.
export function viewHash({ angle, x, y, zoom, time }) {
  return `#a=${angle}&x=${Math.round(x)}&y=${Math.round(y)}&z=${zoom}` + (time === 'day' || time === 'night' ? `&t=${time}` : '');
}
export function readViewHash(hash) {
  const p = new URLSearchParams(String(hash).replace(/^#/, ''));
  if (!p.has('x')) return null;
  const n = k => { const v = Number(p.get(k)); return Number.isFinite(v) ? v : 0; };
  const t = p.get('t');
  return { a: ((Math.round(n('a')) % 4) + 4) % 4, x: n('x'), y: n('y'), z: Math.min(3, Math.max(-6.5, n('z'))), t: t === 'day' || t === 'night' ? t : 'live' };
}

// Hand the link to the phone's share sheet where there is one, else copy it. Resolves to how it went:
// 'shared', 'copied', 'cancelled' or 'failed'.
export async function shareLink(url, nav = navigator) {
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (touch && nav.share) {
    try { await nav.share({ title: 'Isometric Burlington', text: 'Burlington, Vermont as a city-builder map', url }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  try { await nav.clipboard.writeText(url); return 'copied'; } catch { /* older browsers below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = url; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    return ok ? 'copied' : 'failed';
  } catch { return 'failed'; }
}

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

// A picture of the map as it looks now: the drawing, the night, and everything moving on it, without the
// buttons. `tiles` are the drawing's tiles on screen ({src, x, y, w, h} in CSS pixels); they are fetched
// through `tileUrl(src)`, which must give a same-site address (a canvas cannot be saved once it holds an
// image from another site). `layers` are the map's canvases, bottom first: [{canvas, blend}].
export async function snapshot({ width, height, tiles, tileUrl, night, layers, caption, scale = Math.min(2, devicePixelRatio || 1) }) {
  const c = document.createElement('canvas');
  c.width = Math.round(width * scale); c.height = Math.round(height * scale);
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  const bg = ctx.createRadialGradient(width / 2, height * 0.4, 0, width / 2, height * 0.4, Math.max(width, height) * 0.9);
  bg.addColorStop(0, '#3c5a6c'); bg.addColorStop(1, '#1d2c36');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  let drawn = 0;
  await Promise.all(tiles.map(async t => {
    try {
      const r = await fetch(tileUrl(t.src));
      if (!r.ok) return;
      const bmp = await createImageBitmap(await r.blob());
      ctx.drawImage(bmp, t.x, t.y, t.w, t.h); drawn++;
    } catch { /* a missing tile leaves the background */ }
  }));
  if (night > 0.01) {
    // the same dimming the page does with CSS: darker, then a blue tint multiplied over
    ctx.globalCompositeOperation = 'multiply';
    const v = Math.round(255 * (1 - night * 0.55));
    ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(0, 0, width, height);
    const k = night * 0.55;
    ctx.fillStyle = `rgb(${lerp(255, 0x14, k)},${lerp(255, 0x23, k)},${lerp(255, 0x4a, k)})`; ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
  }
  for (const l of layers) {
    if (!l.canvas || !l.canvas.width) continue;
    ctx.globalCompositeOperation = l.blend || 'source-over';
    ctx.globalAlpha = l.alpha ?? 1;
    ctx.drawImage(l.canvas, 0, 0, width, height);
  }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  // a small caption, bottom right
  const size = Math.max(12, Math.min(16, width / 60));
  ctx.font = `600 ${size}px "IBM Plex Sans", system-ui, sans-serif`;
  const tw = ctx.measureText(caption).width, padX = size * 0.75, bh = size * 2, bx = width - tw - padX * 2 - 12, by = height - bh - 12;
  ctx.fillStyle = 'rgba(17,26,33,0.82)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, tw + padX * 2, bh, 7); else ctx.rect(bx, by, tw + padX * 2, bh);
  ctx.fill();
  ctx.fillStyle = '#f2f5f6'; ctx.textBaseline = 'middle';
  ctx.fillText(caption, bx + padX, by + bh / 2 + 0.5);
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.92));
  return { blob, drawn };
}

// Give the picture to the person: the share sheet on a phone, a download elsewhere.
export async function deliver(blob, name, nav = navigator) {
  const file = new File([blob], name, { type: blob.type });
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (touch && nav.canShare && nav.canShare({ files: [file] })) {
    try { await nav.share({ files: [file], title: 'Isometric Burlington' }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  return 'saved';
}
