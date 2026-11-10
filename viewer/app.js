import L from 'leaflet';
import grid from './grid-lite.json';
import { latLonToPx, pxToEnu, enuToPx, enuToLla, GRID } from './geo.js';
import { nightFactor, fetchWeather, sunTimes } from './sky.js';
import { WeatherFX } from './fx.js';
import { BusLayer } from './transit.js';

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
  saveHash();
}

function rotate(dir) {
  const [x, y] = toPx(map.getCenter());
  const [e, n] = pxToEnu(state.angle, x, y, GROUND_U);
  const a = (state.angle + dir + 4) % 4;
  const [nx, ny] = enuToPx(a, e, n, GROUND_U);
  document.body.classList.add('turning');
  setTimeout(() => document.body.classList.remove('turning'), 260);
  showAngle(a, [nx, ny]);
}

// ---------- hash (shareable view) ----------
function saveHash() {
  if (!map._loaded) return;
  const [x, y] = toPx(map.getCenter());
  const h = `#a=${state.angle}&x=${Math.round(x)}&y=${Math.round(y)}&z=${map.getZoom()}`;
  history.replaceState(null, '', h);
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has('x')) return null;
  return { a: (+p.get('a') || 0) % 4, x: +p.get('x'), y: +p.get('y'), z: +p.get('z') };
}
map.on('moveend', saveHash);

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
    b.addEventListener('click', () => { ul.hidden = true; $('#q').blur(); goTo(+r.lat, +r.lon, name); });
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
$('#search').addEventListener('submit', e => { e.preventDefault(); const q = $('#q').value.trim(); if (q) search(q).then(l => l[0] ? goTo(+l[0].lat, +l[0].lon, l[0].display_name.split(', ')[0]) : renderResults([])); });
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
const buses = new BusLayer($('#buses'), map, toLL, () => state.angle, (x, y) => inRegion(state.angle, x, y));
buses.load('transit.json').catch(() => { buses.data = null; });
let tipAt = null, tipBus = null;
function showTip() {
  const tip = $('#bus-tip');
  const d = tipAt && buses.on && buses.data && buses.hit(tipAt.x, tipAt.y);
  if (!d) { tip.hidden = true; tipBus = null; return false; }
  if (d.b.trip !== tipBus) {                    // rewrite the text only when the bus changes
    tipBus = d.b.trip;
    const info = buses.describe(d);
    tip.querySelector('.sw').style.background = info.color;
    tip.querySelector('b').textContent = info.name;
    tip.querySelector('.long').textContent = info.long;
    tip.querySelector('.until').textContent = `On the timetable, in service until ${info.until}`;
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
$('#show-buses').addEventListener('change', e => { buses.on = e.target.checked; if (!buses.on) $('#bus-tip').hidden = true; });
function applySky() {
  const live = nightFactor();
  const night = state.timeMode === 'day' ? 0 : state.timeMode === 'night' ? 1 : live;
  document.documentElement.style.setProperty('--night', night.toFixed(3));
  document.body.classList.toggle('is-night', night > 0.5);
  buses.night = night;
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
$('#layers-btn').addEventListener('click', () => { const p = $('#layers'); p.hidden = !p.hidden; $('#layers-btn').setAttribute('aria-expanded', String(!p.hidden)); });
document.querySelectorAll('input[name=time]').forEach(i => i.addEventListener('change', () => { state.timeMode = i.value; applySky(); }));
document.querySelectorAll('input[name=wx]').forEach(i => i.addEventListener('change', () => { state.weatherMode = i.value; applySky(); }));
addEventListener('keydown', e => {
  if (e.target.matches('input[type=search], input[type=text], textarea')) return;
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
  refreshWeather();
  const st = sunTimes();
  $('#sun').textContent = `Sunset ${st.sunset.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })}`;
  window.__iso = { map, state, rotate, goTo, toPx, buses };
})();
