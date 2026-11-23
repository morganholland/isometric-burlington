// Interactions and anonymous analytics for the About page (how.html).
import { initTracking, track } from './track.js';

initTracking();

// Drag-to-compare: the slider (keyboard, screen readers) sets where the "before" picture is cut;
// a mouse drags anywhere on the picture, a finger only once it moves sideways, so vertical swipes still scroll.
for (const f of document.querySelectorAll('.compare .frame')) {
  const r = f.querySelector('input');
  const set = () => {
    f.style.setProperty('--cut', r.value + '%');
    r.setAttribute('aria-valuetext', `${r.value}% Google's model, ${100 - r.value}% drawn`);
  };
  const at = e => {
    const b = f.getBoundingClientRect();
    r.value = Math.round(Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)) * 100);
    set();
  };
  let start = null, dragging = false;
  f.addEventListener('pointerdown', e => {
    start = [e.clientX, e.clientY];
    dragging = e.pointerType === 'mouse';
    if (dragging) { e.preventDefault(); f.setPointerCapture(e.pointerId); at(e); }
  });
  f.addEventListener('pointermove', e => {
    if (!start) return;
    if (!dragging) {
      const dx = Math.abs(e.clientX - start[0]), dy = Math.abs(e.clientY - start[1]);
      if (dx > 6 && dx > dy) { dragging = true; f.setPointerCapture(e.pointerId); } else return;
    }
    at(e);
  });
  const end = () => { start = null; dragging = false; };
  f.addEventListener('pointerup', end);
  f.addEventListener('pointercancel', end);
  r.addEventListener('input', set);
  set();
}

// Track tip clicks on the Support card (click + middle-click), matching the map's tip links.
const tipBtn = document.querySelector('#support a.tip-btn');
if (tipBtn) {
  for (const ev of ['click', 'auxclick']) {
    tipBtn.addEventListener(ev, e => {
      if (ev === 'click' || e.button === 1) track('tip_clicked', { placement: 'about_page' });
    });
  }
}

// Return to the map where you left it (its position lives in the map's URL hash) when coming from it,
// unless the visitor jumped to in-page sections (#story, #changes, ...), in which case history.back()
// would only step to the previous section instead of returning to the map.
let samePageNavs = 0;
addEventListener('hashchange', () => { samePageNavs++; });
for (const a of document.querySelectorAll('a[href="./"]')) {
  a.addEventListener('click', e => {
    try {
      if (samePageNavs === 0 && !location.hash && document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) {
        e.preventDefault();
        history.back();
      }
    } catch {}
  });
}
