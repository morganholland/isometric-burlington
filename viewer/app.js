import L from 'leaflet';
import grid from './grid-lite.json';
import { latLonToPx, pxToEnu, enuToPx, enuToLla, GRID } from './geo.js';
import { nightFactor, fetchWeather, sunTimes } from './sky.js';
import { WeatherFX } from './fx.js';
import { BusLayer } from './transit.js';
import { PlaneLayer } from './planes.js';
import { LabelLayer } from './labels.js';
import { CarLayer } from './traffic.js';
import { LightLayer, litShare } from './lights.js';
import { burlingtonClock } from './transit.js';
import { viewHash, readViewHash, shareLink, snapshot, deliver } from './share.js';
import { initTracking, track } from './track.js';

initTracking();

const TILE_BASE = (window.ISO_CONFIG && window.ISO_CONFIG.tileBase) || '';
const GROUND_U = 40;           // typical ground height (m) used when turning the map
const $ = s => document.querySelector(s);

const state = {
  angle: 0, manifest: null, layer: null, outline: null,
  timeMode: 'live', weatherMode: 'live', weather: null, marker: null,
};

// ---------- map ----------
const toLL = (x, y) => L.latLng(-y, x);
const toPx = ll => [ll.lng, -ll.lat];

const map = L.map('map', {
  crs: L.CRS.Simple, minZoom: -6.5, maxZoom: 3, zoomSnap: 0.25, zoomDelta: 0.5,
  wheelPxPerZoomLevel: 90, zoomControl: false, attributionControl: false, inertia: true,
  maxBoundsViscosity: 0.8,
});

// the paper grain and night tint sit just over the drawing, the names above them, and the place pins
// (Leaflet's marker pane, 600) on top of all three
map.createPane('tint').style.zIndex = 250;
map.createPane('glow').style.zIndex = 300;   // what is lit at night: over the tint, under the names
map.createPane('ink').style.zIndex = 450;
map.getPane('tint').append($('#paper'), $('#night'));
map.getPane('glow').append($('#lights'));
map.getPane('ink').append($('#labels'));
// Leaflet moves its panes while dragging; keep the tint fixed to the screen
function pinTint() {
  const p = map.containerPointToLayerPoint([0, 0]);
  map.getPane('tint').style.transform = `translate3d(${p.x}px,${p.y}px,0)`;
}
map.on('move zoomend viewreset resize', pinTint);

function angleBounds(a) {
  const g = grid.angles[a];
  return L.latLngBounds(toLL(g.x0, g.y1), toLL(g.x1, g.y0));
}

function tileLayerFor(a, kind) {
  const Layer = L.TileLayer.extend({
    getTileUrl(c) { return `${TILE_BASE}/${kind}/a${a}/${c.z}/${c.x}/${c.y}.webp`; },
  });
  const m = state.manifest;
  return new Layer('', {
    tileSize: 512, minZoom: -7, maxZoom: 3, minNativeZoom: m.minZoom, maxNativeZoom: m.maxZoom,
    bounds: angleBounds(a), noWrap: true, errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', keepBuffer: 3, updateWhenZooming: false, className: 'iso-tiles',
  });
}

function showAngle(a, centerPx, zoom) {
  state.angle = a;
  if (state.layer) { map.removeLayer(state.layer); state.layer = null; }
  if (state.outline) { map.removeLayer(state.outline); state.outline = null; }
  const ready = state.manifest && state.manifest.angles && state.manifest.angles[a];
  if (ready) {
    state.layer = tileLayerFor(a, state.manifest.angles[a]).addTo(map);
  } else {
    state.outline = L.polygon(grid.angles[a].region.map(([x, y]) => toLL(x, y)), {
      color: '#e7c48b', weight: 1.5, fillColor: '#e7c48b', fillOpacity: 0.08, interactive: false,
    }).addTo(map);
  }
  map.setMaxBounds(angleBounds(a).pad(0.6));
  if (centerPx) map.setView(toLL(...centerPx), zoom ?? map.getZoom(), { animate: false });
  $('#compass').style.setProperty('--north', `${-GRID.headings[a]}deg`);
  $('#compass').setAttribute('aria-label', `North is ${['to the left', 'down', 'to the right', 'up'][a]}`);
  if (state.marker) placeMarker(state.marker.lat, state.marker.lon, state.marker.label, false);
  applySky();
  labels.draw();
  cars.aim();
  if (places.list.length) drawPlaces();
  saveHash();
}

function rotate(dir) {
  const [x, y] = toPx(map.getCenter());
  const [e, n] = pxToEnu(state.angle, x, y, GROUND_U);
  const a = (state.angle + dir + 4) % 4;
  track('map_rotated', { angle: a, direction: dir < 0 ? 'left' : 'right' });
  const [nx, ny] = enuToPx(a, e, n, GROUND_U);
  document.body.classList.add('turning');
  setTimeout(() => document.body.classList.remove('turning'), 260);
  showAngle(a, [nx, ny]);
}

// ---------- hash (shareable view) ----------
function saveHash() {
  if (!map._loaded) return;
  const [x, y] = toPx(map.getCenter());
  history.replaceState(null, '', viewHash({ angle: state.angle, x, y, zoom: map.getZoom(), time: state.timeMode }));
}
const readHash = () => readViewHash(location.hash);
map.on('moveend', saveHash);
// the paper grain shows more the further past the drawing's own resolution (zoom 0) you go
const setPaper = () => document.documentElement.style.setProperty('--paper', Math.min(1, Math.max(0, (map.getZoom() + 0.5) / 2.5)).toFixed(2));
map.on('zoomend', setPaper);

// ---------- search ----------
let searchCtl;
async function search(q) {
  searchCtl?.abort(); searchCtl = new AbortController();
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ q, format: 'jsonv2', limit: '6', viewbox: '-73.33,44.55,-73.10,44.39', bounded: '1', addressdetails: '0' });
  const r = await fetch(url, { signal: searchCtl.signal, headers: { 'Accept-Language': 'en' } });
  return r.ok ? r.json() : [];
}
function renderResults(list) {
  const ul = $('#results'); ul.innerHTML = '';
  if (!list.length) { ul.hidden = false; ul.innerHTML = '<li class="empty">Nothing found in Burlington, South Burlington or Winooski.</li>'; return; }
  for (const r of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    const [name, ...rest] = r.display_name.split(', ');
    b.innerHTML = `<b></b><span></span>`; b.querySelector('b').textContent = name; b.querySelector('span').textContent = rest.slice(0, 3).join(', ');
    b.addEventListener('click', () => { track('place_searched', { via: 'list', found: true }); ul.hidden = true; $('#q').blur(); goTo(+r.lat, +r.lon, name); });
    li.appendChild(b); ul.appendChild(li);
  }
  ul.hidden = false;
}
let debounce;
$('#q').addEventListener('input', e => {
  clearTimeout(debounce);
  const q = e.target.value.trim();
  if (q.length < 3) { $('#results').hidden = true; return; }
  debounce = setTimeout(() => search(q).then(renderResults).catch(() => {}), 350);
});
$('#search').addEventListener('submit', e => { e.preventDefault(); const q = $('#q').value.trim(); if (q) search(q).then(l => { track('place_searched', { via: 'enter', found: !!l[0] }); return l; }).then(l => l[0] ? goTo(+l[0].lat, +l[0].lon, l[0].display_name.split(', ')[0]) : renderResults([])); });
document.addEventListener('click', e => { if (!e.target.closest('#search')) $('#results').hidden = true; });

function placeMarker(lat, lon, label) {
  if (state.marker?.layer) map.removeLayer(state.marker.layer);
  const [x, y] = latLonToPx(state.angle, lat, lon, GROUND_U);
  const icon = L.divIcon({ className: 'pin', html: `<span class="pin-dot"></span><span class="pin-label"></span>`, iconSize: [0, 0] });
  const layer = L.marker(toLL(x, y), { icon, interactive: false }).addTo(map);
  layer.getElement().querySelector('.pin-label').textContent = label;
  state.marker = { lat, lon, label, layer };
  return [x, y];
}
function goTo(lat, lon, label) {
  const p = placeMarker(lat, lon, label);
  map.flyTo(toLL(...p), Math.max(map.getZoom(), -1), { duration: 1.1 });
}

// ---------- hand-picked places: a pin and a short note each ----------
const places = { list: [], markers: [], open: null, opener: null };
const esc = t => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function drawPlaces() {
  const focused = document.activeElement?.closest?.('.place-pin')?.dataset.i;
  for (const m of places.markers) map.removeLayer(m);
  places.markers = [];
  if ($('#show-places').checked) places.list.forEach((p, i) => {
    const [x, y] = latLonToPx(state.angle, p.lat, p.lon, p.h);
    if (!inRegion(state.angle, x, y)) return;
    const icon = L.divIcon({ className: 'place', iconSize: [0, 0],
      html: `<button type="button" class="place-pin" data-i="${i}" aria-label="${esc(p.name)}: read the note"><span class="place-mark"></span><span class="place-name">${esc(p.name)}</span></button>` });
    const m = L.marker(toLL(x, y), { icon, keyboard: false, zIndexOffset: 500 }).addTo(map);
    // Leaflet's own click: it is not fired when the press turns out to be a drag of the map
    m.on('click', () => openPlace(i, 'pin', m.getElement()?.querySelector('button')));
    m.placeIndex = i;
    places.markers.push(m);
  });
  zoomBand();
  // turning the map rebuilds the pins: keep keyboard focus on the same one
  if (focused != null) document.querySelector(`.place-pin[data-i="${focused}"]`)?.focus();
  labels.draw();
}
function openPlace(i, via, opener) {
  const p = places.list[i];
  places.open = i;
  places.opener = opener || null;
  $('#place h2').textContent = p.name;
  $('#place p').textContent = p.note;
  $('#place').hidden = false;
  closePlacesList();
  $('#place-close').focus();
  track('place_opened', { place: p.name, via });
}
function closePlace() {
  if ($('#place').hidden) return;
  const i = places.open;
  $('#place').hidden = true; places.open = null;
  const back = places.opener?.isConnected ? places.opener : document.querySelector(`.place-pin[data-i="${i}"]`) || $('#places-btn');
  back.focus();
}
function closePlacesList() { $('#places-list').hidden = true; $('#places-btn').setAttribute('aria-expanded', 'false'); }
function flyToPlace(i) {
  const p = places.list[i];
  const [x, y] = latLonToPx(state.angle, p.lat, p.lon, p.h);
  map.flyTo(toLL(x, y), Math.max(map.getZoom(), -0.5), { duration: 1.1 });
  openPlace(i, 'list', null);
}
// pins show from the overview in; their names once you are close enough to read the streets
function zoomBand() {
  const z = map.getZoom();
  $('#map').classList.toggle('places-far', z < -3.75);
  $('#map').classList.toggle('places-named', z >= -1.25);
}
map.on('zoomend', zoomBand);
// the screen space pins (and their names) take, so street names keep clear of them
function placeBoxes() {
  if ($('#map').classList.contains('places-far')) return [];
  const named = $('#map').classList.contains('places-named');
  return places.markers.map(m => {
    const c = map.latLngToContainerPoint(m.getLatLng());
    const w = named ? 30 + places.list[m.placeIndex].name.length * 7.4 : 20;
    return { x0: c.x - 11, x1: c.x - 11 + w, y0: c.y - 12, y1: c.y + 12 };
  });
}
function setupPlaces(d) {
  places.list = d.places.map(([name, note, lat, lon, h]) => ({ name, note, lat, lon, h }));
  const ul = $('#places-list ul');
  places.list.forEach((p, i) => {
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button'; b.textContent = p.name; b.addEventListener('click', () => flyToPlace(i));
    li.appendChild(b); ul.appendChild(li);
  });
  $('#places-btn').hidden = false;
  drawPlaces();
}
$('#place-close').addEventListener('click', closePlace);
// keyboard: Enter or Space on a focused pin (Leaflet only passes on pointer clicks)
$('#map').addEventListener('keydown', e => {
  const b = e.target.closest?.('.place-pin');
  if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); openPlace(+b.dataset.i, 'pin', b); }
});
$('#show-places').addEventListener('change', drawPlaces);
$('#places-btn').addEventListener('click', () => {
  const l = $('#places-list'); l.hidden = !l.hidden; $('#places-btn').setAttribute('aria-expanded', String(!l.hidden));
  if (!l.hidden) { $('#layers').hidden = true; $('#layers-btn').setAttribute('aria-expanded', 'false'); l.querySelector('button')?.focus(); }
});

// ---------- sky: night + weather ----------
const fx = new WeatherFX($('#fx'));

// ---------- buses (GMT timetable) ----------
function inRegion(a, x, y) {
  const g = grid.angles[a];
  if (x < g.x0 || x > g.x1 || y < g.y0 || y > g.y1) return false;
  const poly = g.region; let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const labels = new LabelLayer($('#labels'), map, toLL, () => state.angle, (x, y) => inRegion(state.angle, x, y));
labels.reserved = placeBoxes;
// one download feeds the names and the places
fetch('labels.json').then(r => r.ok ? r.json() : Promise.reject(new Error(`labels ${r.status}`))).then(d => {
  labels.skip = new Set((d.places || []).map(p => p[0]));
  labels.use(d);
  if (d.places) setupPlaces(d);
}).catch(() => { labels.data = null; });
const buses = new BusLayer($('#buses'), map, toLL, () => state.angle, (x, y) => inRegion(state.angle, x, y));
buses.load('transit.json').catch(() => { buses.data = null; });
const planes = new PlaneLayer($('#planes'), map, toLL, () => state.angle);
const cars = new CarLayer($('#cars'), map, toLL, () => state.angle, (x, y) => inRegion(state.angle, x, y));
const lights = new LightLayer($('#lights'), map, toLL, () => state.angle, (x, y) => inRegion(state.angle, x, y));
$('#show-cars').checked = cars.on;
let tipAt = null, tipBus = null;
function showTip() {
  const tip = $('#bus-tip');
  let d = tipAt && planes.on && planes.hit(tipAt.x, tipAt.y), layer = planes, key = d && d.a.id;
  if (!d) { d = tipAt && buses.on && buses.data && buses.hit(tipAt.x, tipAt.y); layer = buses; key = d && d.b.trip; }
  if (!d) { tip.hidden = true; tipBus = null; return false; }
  if (key !== tipBus) {                         // rewrite the text only when what is under the pointer changes
    tipBus = key;
    const info = layer.describe(d);
    tip.querySelector('.sw').style.background = info.color;
    tip.querySelector('b').textContent = info.name;
    tip.querySelector('.long').textContent = info.long;
    tip.querySelector('.until').textContent = layer === buses ? `On the timetable, in service until ${info.until}` : info.until;
  }
  tip.hidden = false;
  // beside the pointer, kept on screen
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const x = tipAt.x + 14 + w > innerWidth - 8 ? tipAt.x - 14 - w : tipAt.x + 14;
  const y = Math.min(Math.max(8, tipAt.y - h / 2), innerHeight - h - 8);
  tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${y}px`;
  return true;
}
function busTip(e) { tipAt = e.containerPoint; showTip(); }
buses.onFrame = () => { if (tipAt && !$('#bus-tip').hidden) showTip(); };
map.on('mousemove', busTip);
map.on('click', busTip);
map.on('mouseout', () => { tipAt = null; $('#bus-tip').hidden = true; });
map.on('movestart zoomstart', () => { tipAt = null; $('#bus-tip').hidden = true; });
$('#show-labels').addEventListener('change', e => { labels.on = e.target.checked; labels.draw(); });
$('#show-buses').addEventListener('change', e => { buses.on = e.target.checked; if (!buses.on) $('#bus-tip').hidden = true; });
$('#show-planes').addEventListener('change', e => { planes.on = e.target.checked; if (!planes.on) $('#bus-tip').hidden = true; });
$('#show-cars').addEventListener('change', e => { cars.on = e.target.checked; cars.aim(); track('cars_toggled', { on: cars.on }); });
function applySky() {
  const live = nightFactor();
  const night = state.timeMode === 'day' ? 0 : state.timeMode === 'night' ? 1 : live;
  document.documentElement.style.setProperty('--night', night.toFixed(3));
  document.body.classList.toggle('is-night', night > 0.5);
  buses.night = night; planes.night = night; cars.night = night; labels.night = night; labels.draw();
  // in the small hours most windows are dark; a forced night is always an evening
  lights.set(night, state.timeMode === 'night' ? 1 : litShare(burlingtonClock().s / 3600));
  const w = state.weatherMode === 'live' ? (state.weather || { kind: 'clear' }) : { kind: state.weatherMode, heavy: false, windMph: 8, windFromDeg: 300 };
  fx.set(w.kind, w.heavy, w.windMph, w.windFromDeg, GRID.headings[state.angle]);
  const t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const ww = state.weather;
  $('#status').textContent = `Burlington ${t}` + (ww ? ` · ${ww.tempF != null ? ww.tempF + '°F ' : ''}${ww.text.toLowerCase()}` : '');
}
async function refreshWeather() {
  try { state.weather = await fetchWeather(); } catch { /* keep last */ }
  applySky();
}
setInterval(applySky, 30000);
setInterval(refreshWeather, 10 * 60000);

// ---------- controls ----------
$('#rot-left').addEventListener('click', () => rotate(-1));
$('#rot-right').addEventListener('click', () => rotate(1));
$('#zoom-in').addEventListener('click', () => map.zoomIn());
$('#zoom-out').addEventListener('click', () => map.zoomOut());
$('#layers-btn').addEventListener('click', () => { const p = $('#layers'); p.hidden = !p.hidden; $('#layers-btn').setAttribute('aria-expanded', String(!p.hidden)); if (!p.hidden) { $('#places-list').hidden = true; $('#places-btn').setAttribute('aria-expanded', 'false'); } });
document.querySelectorAll('input[name=time]').forEach(i => i.addEventListener('change', () => { state.timeMode = i.value; applySky(); saveHash(); }));
document.querySelectorAll('input[name=wx]').forEach(i => i.addEventListener('change', () => { state.weatherMode = i.value; applySky(); }));
// ---------- share a link to this view, save a picture of it ----------
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
$('#share-btn').addEventListener('click', async () => {
  saveHash();
  const how = await shareLink(location.href);
  track('view_shared', { how });
  if (how === 'copied') toast('Link to this view copied');
  else if (how === 'failed') toast('Copy the address from the bar above to share this view');
});
// the drawing's tiles on screen now, for the picture
function tilesOnScreen() {
  return [...document.querySelectorAll('.iso-tiles img')].filter(i => i.complete && i.naturalWidth > 1).map(i => {
    const r = i.getBoundingClientRect();
    return { src: i.src, x: r.left, y: r.top, w: r.width, h: r.height };
  }).filter(t => t.x < innerWidth && t.y < innerHeight && t.x + t.w > 0 && t.y + t.h > 0);
}
let snapping = false;
async function takeSnapshot() {
  if (snapping) return null;
  snapping = true; $('#snap-btn').setAttribute('aria-busy', 'true');
  try {
    const night = +getComputedStyle(document.documentElement).getPropertyValue('--night') || 0;
    const { blob, drawn } = await snapshot({
      width: innerWidth, height: innerHeight, night, caption: 'isoburlington.com',
      tiles: tilesOnScreen(), tileUrl: src => (TILE_BASE && src.startsWith(TILE_BASE) ? 'tiles' + src.slice(TILE_BASE.length) : src),
      layers: [
        { canvas: $('#lights'), blend: 'screen', alpha: +$('#lights').style.opacity || 0 },
        { canvas: $('#labels') }, { canvas: $('#cars') }, { canvas: $('#buses') }, { canvas: $('#planes') }, { canvas: $('#fx') },
      ],
    });
    if (!blob) throw new Error('no picture');
    const how = await deliver(blob, `isometric-burlington-${new Date().toISOString().slice(0, 10)}.jpg`);
    track('snapshot_saved', { how, tiles: drawn });
    if (how === 'saved') toast('Picture saved');
    return { how, drawn, bytes: blob.size };
  } catch {
    toast('Could not make a picture this time');
    return null;
  } finally { snapping = false; $('#snap-btn').removeAttribute('aria-busy'); }
}
$('#snap-btn').addEventListener('click', takeSnapshot);

// ---------- tip jar: shown only once a Venmo username is set ----------
const VENMO = 'morgan-holland';   // Venmo username without the @
if (VENMO) {
  const url = `https://venmo.com/${encodeURIComponent(VENMO)}?txn=pay&note=${encodeURIComponent('Isometric Burlington ☕')}`;
  $('#tip-link').href = url; $('#tip').hidden = false;
  const inline = document.querySelector('.tip-inline'); inline.href = url; inline.hidden = false;
  document.querySelector('.tip-sep').hidden = false;
  // auxclick counts a middle-click open too
  for (const ev of ['click', 'auxclick']) {
    $('#tip-link').addEventListener(ev, e => { if (ev === 'click' || e.button === 1) track('tip_clicked', { placement: 'about' }); });
    inline.addEventListener(ev, e => { if (ev === 'click' || e.button === 1) track('tip_clicked', { placement: 'footer' }); });
  }
}

// ---------- how to use: a one-time hint, and the ? panel ----------
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
function showAbout(open) {
  $('#about').hidden = !open;
  $('#about-btn').setAttribute('aria-expanded', String(open));
  if (open) { hideHint(); $('#about-close').focus(); track('about_opened'); }
}
function hideHint() { if (!$('#hint').hidden) { $('#hint').hidden = true; store.set('iso-hint-seen', '1'); } }
if (!store.get('iso-hint-seen')) {
  $('#hint').hidden = false;
  // once someone has dragged or zoomed a few times, they've got it
  let moves = 0;
  map.on('dragend', () => { if (++moves >= 2) hideHint(); });
}
$('#hint-ok').addEventListener('click', hideHint);
$('#hint-more').addEventListener('click', () => showAbout(true));
$('#about-btn').addEventListener('click', () => showAbout($('#about').hidden));
$('#about-close').addEventListener('click', () => { showAbout(false); $('#about-btn').focus(); });

addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#about').hidden) { showAbout(false); $('#about-btn').focus(); return; }
  if (e.key === 'Escape' && !$('#place').hidden) { closePlace(); return; }
  if (e.key === 'Escape' && !$('#places-list').hidden) { closePlacesList(); $('#places-btn').focus(); return; }
  if (e.target.matches('input[type=search], input[type=text], textarea')) return;
  if (e.key === '?') { showAbout($('#about').hidden); return; }
  if (e.key === 'r' || e.key === ']') rotate(1);
  if (e.key === 'R' || e.key === '[') rotate(-1);
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
});

// ---------- boot ----------
async function loadManifest() {
  if (!TILE_BASE) return null;
  // the site ships a copy of the tile bucket's manifest (the bucket's public address sends no CORS headers)
  try { const r = await fetch('manifest.json', { cache: 'no-cache' }); return r.ok ? r.json() : null; } catch { return null; }
}

(async function boot() {
  state.manifest = await loadManifest();
  const any = state.manifest && state.manifest.angles && state.manifest.angles.some(Boolean);
  $('#drawing').hidden = !!any;
  const h = readHash();
  if (h && h.t !== 'live') { state.timeMode = h.t; document.querySelector(`input[name=time][value=${h.t}]`).checked = true; }
  if (h) showAngle(h.a, [h.x, h.y], h.z);
  else {
    showAngle(0, null);
    // open on downtown and the waterfront
    if (any) {
      const [x, y] = latLonToPx(0, 44.4759, -73.2160, 32);
      map.setView(toLL(x, y), -2.5, { animate: false });
    } else {
      map.fitBounds(L.latLngBounds(grid.angles[0].region.map(([x, y]) => toLL(x, y))), { padding: [40, 40], animate: false });
    }
  }
  setPaper();
  refreshWeather();
  const st = sunTimes();
  $('#sun').textContent = `Sunset ${st.sunset.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })}`;
  window.__iso = { map, state, rotate, goTo, toPx, buses, planes, cars, lights, labels, places, openPlace, showAbout, takeSnapshot };
})();
