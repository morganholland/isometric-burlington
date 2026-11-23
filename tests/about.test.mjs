// The "How it was made" page: its numbers come from the map's own data, and every change-log link opens
// a real view of the drawn map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readViewHash, readMoment } from '../viewer/share.js';
import { latLonToPx } from '../viewer/geo.js';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const json = p => JSON.parse(read(p));
const html = read('viewer/how.html');
const lite = json('viewer/grid-lite.json');

function inRegion(a, x, y) {
  const poly = lite.angles[a].region; let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const shown = key => {
  const m = html.match(new RegExp(`data-n="${key}">([\\d,.]+)<`));
  assert.ok(m, `the page shows a "${key}" number`);
  return Number(m[1].replace(/,/g, ''));
};

test('the numbers row matches the data the map is built from', () => {
  const grid = json('data/grid.json');
  assert.equal(shown('blocks'), grid.angles.reduce((n, a) => n + a.blocks.length, 0));
  assert.equal(shown('cm'), Math.round(grid.pixel_m * 100));
  const labels = json('viewer/labels.json');
  assert.equal(shown('streets'), new Set(labels.streets.map(s => s[0])).size);
  assert.equal(shown('lamps'), json('viewer/lights.json').lamps.length);
  assert.equal(shown('routes'), Object.keys(json('viewer/transit.json').routes).length);
  const region = json('data/region_enu.geojson').geometry;
  const ring = r => Math.abs(r.slice(0, -1).reduce((s, p, i) => s + p[0] * r[i + 1][1] - r[i + 1][0] * p[1], 0)) / 2;
  const polys = region.type === 'MultiPolygon' ? region.coordinates : [region.coordinates];
  const km2 = polys.reduce((s, p) => s + ring(p[0]) - p.slice(1).reduce((h, r) => h + ring(r), 0), 0) / 1e6;
  assert.equal(shown('km2'), Math.round(km2));
});

test('every change-log link opens the map on a drawn spot or a named moment', () => {
  const log = html.slice(html.indexOf('<ol class="log">'), html.indexOf('</ol>', html.indexOf('<ol class="log">')));
  const links = [...log.matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
  assert.ok(links.length >= 4, 'the change log links to the spots it talks about');
  for (const href of links) {
    assert.match(href, /^\.\/(#.*)?$/, `${href} stays on the map`);
    const hash = href.slice(2);
    if (!hash) continue;
    const v = readViewHash(hash), m = readMoment(hash);
    assert.ok(v || m, `${href} names a view or a moment`);
    if (v) assert.ok(inRegion(v.a, v.x, v.y), `${href} is inside the drawn map`);
  }
});

test('the before-and-after pictures exist and line up', () => {
  for (const f of ['compare-google.jpg', 'compare-drawn.jpg']) {
    assert.ok(html.includes(`./press/${f}`), `${f} is on the page`);
    const b = fs.readFileSync(new URL(`../viewer/press/${f}`, import.meta.url));
    // JPEG size from the first frame header: both pictures are the same size, so the slider lines them up
    let i = 2; while (i < b.length && !(b[i] === 0xff && b[i + 1] >= 0xc0 && b[i + 1] <= 0xc2)) i += 2 + b.readUInt16BE(i + 2);
    assert.deepEqual([b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)], [1600, 1000], `${f} is 1600 × 1000`);
  }
});

test('each change-log link opens on the spot its words name', () => {
  // where each named view should be: Church Street Marketplace and the middle of downtown
  const want = { 'Church Street up close': [44.4780, -73.2128], 'Downtown at night': [44.4775, -73.2140] };
  for (const [text, [lat, lon]] of Object.entries(want)) {
    const m = html.match(new RegExp(`href="([^"]+)">${text}<`));
    assert.ok(m, `the change log has "${text}"`);
    const v = readViewHash(m[1].replace(/&amp;/g, '&').slice(2));
    const [x, y] = latLonToPx(v.a, lat, lon, 30);
    // within about 100 m of the spot (0.23 m a pixel)
    assert.ok(Math.hypot(v.x - x, v.y - y) < 450, `"${text}" opens ${Math.round(Math.hypot(v.x - x, v.y - y) * 0.23)} m from it`);
  }
});
