// The About page (how.html): its numbers come from the map's own data, every picture is sharp and
// served at 1x/2x under 500 KB, every change-log entry has a clickable picture opening a drawn spot,
// and the support card and footer match the agreed copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readViewHash, readMoment } from '../viewer/share.js';
import { latLonToPx } from '../viewer/geo.js';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const json = p => JSON.parse(read(p));
const html = read('viewer/how.html');
const indexHtml = read('viewer/index.html');
const lite = json('viewer/grid-lite.json');

const EXPECTED_VENMO = 'https://venmo.com/morgan-holland?txn=pay&note=Isometric%20Burlington%20%E2%98%95';

function inRegion(a, x, y) {
  const poly = lite.angles[a].region; let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function imageSize(filePath) {
  const b = fs.readFileSync(filePath);
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') {
    const chunk = b.slice(12, 16).toString('ascii');
    if (chunk === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
    }
    if (chunk === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length && !(b[i] === 0xff && b[i + 1] >= 0xc0 && b[i + 1] <= 0xc2)) i += 2 + b.readUInt16BE(i + 2);
    return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
  }
  throw new Error(`unrecognised image format: ${filePath}`);
}

const stripTags = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

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

test('the page is titled and headed "About", with top jump links and map links updated to "About"', () => {
  assert.match(html, /<title>About\b[^<]*<\/title>/);
  assert.match(html, /<h1>About<\/h1>/);
  const nav = html.match(/<nav\b[^>]*class="jump"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(nav, 'top jump nav exists');
  const jumpLinks = [...nav[1].matchAll(/<a\s+href="(#[^"]+)">([^<]+)<\/a>/g)].map(m => [m[1], m[2].trim()]);
  assert.deepEqual(jumpLinks, [
    ['#story', 'Story'],
    ['#changes', 'Changes'],
    ['#thanks', 'Thanks'],
    ['#support', 'Support'],
  ]);
  for (const [href] of jumpLinks) {
    assert.ok(new RegExp(`id="${href.slice(1)}"`).test(html), `section ${href} exists on the page`);
  }
  // map's ? guide and status bar both link to ./how.html with the text "About"
  const aboutCard = indexHtml.slice(indexHtml.indexOf('id="about"'), indexHtml.indexOf('</section>', indexHtml.indexOf('id="about"')));
  assert.match(aboutCard, /<a\b[^>]*href="\.\/how\.html"[^>]*>About<\/a>/, 'the ? guide links to About');
  const statusFooter = indexHtml.slice(indexHtml.indexOf('<footer class="status'));
  assert.match(statusFooter, /<a\b[^>]*href="\.\/how\.html"[^>]*>About<\/a>/, 'the status bar links to About');
});

test('every picture has width, height, alt text, 1x/2x srcset under 500 KB, and the five landmarks appear', () => {
  const imgs = [...html.matchAll(/<img\b[^>]+>/g)].map(m => m[0]);
  assert.ok(imgs.length >= 10, `expected hero, compare, landmarks, and change-log thumbnails (got ${imgs.length})`);
  const alts = [];
  for (const tag of imgs) {
    const attr = name => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    const src = attr('src');
    const srcset = attr('srcset');
    const alt = attr('alt');
    const w = Number(attr('width'));
    const h = Number(attr('height'));
    assert.ok(src && src.startsWith('./press/'), `src points into ./press/: ${tag}`);
    assert.ok(alt && alt.trim().length >= 12, `real alt text on ${src}`);
    assert.ok(w > 0 && h > 0, `numeric width/height on ${src}`);
    assert.ok(srcset, `srcset present on ${src}`);
    alts.push(alt);

    const entries = srcset.split(',').map(s => s.trim().split(/\s+/));
    const oneX = entries.find(([, d]) => d === '1x')?.[0];
    const twoX = entries.find(([, d]) => d === '2x')?.[0];
    assert.ok(oneX && twoX, `1x and 2x candidates in srcset for ${src}: ${srcset}`);
    assert.equal(src, oneX, `src matches 1x candidate for ${src}`);

    for (const rel of [oneX, twoX]) {
      const url = new URL(`../viewer/${rel.replace(/^\.\//, '')}`, import.meta.url);
      assert.ok(fs.existsSync(url), `${rel} exists`);
      const bytes = fs.statSync(url).size;
      assert.ok(bytes <= 500 * 1024, `${rel} is ${Math.round(bytes / 1024)} KB (must be <= 500 KB)`);
    }
    const [w1, h1] = imageSize(new URL(`../viewer/${oneX.replace(/^\.\//, '')}`, import.meta.url));
    const [w2, h2] = imageSize(new URL(`../viewer/${twoX.replace(/^\.\//, '')}`, import.meta.url));
    assert.deepEqual([w1, h1], [w, h], `${oneX} matches width/height attributes`);
    assert.deepEqual([w2, h2], [w * 2, h * 2], `${twoX} is exactly 2x ${oneX}`);
  }
  const allText = (alts.join(' ') + ' ' + html).toLowerCase();
  for (const spot of ['church street', 'waterfront', 'city hall park', 'uvm', 'winooski']) {
    assert.ok(allText.includes(spot), `page features ${spot}`);
  }
});

test('the before-and-after pictures exist and line up pixel-for-pixel at both 1x and 2x', () => {
  for (const suffix of ['-1x.webp', '.webp']) {
    const g = `compare-google${suffix}`, d = `compare-drawn${suffix}`;
    assert.ok(html.includes(`./press/${g}`), `${g} is on the page`);
    assert.ok(html.includes(`./press/${d}`), `${d} is on the page`);
    const gs = imageSize(new URL(`../viewer/press/${g}`, import.meta.url));
    const ds = imageSize(new URL(`../viewer/press/${d}`, import.meta.url));
    assert.deepEqual(gs, ds, `${g} and ${d} have identical dimensions`);
  }
  const [w2, h2] = imageSize(new URL('../viewer/press/compare-drawn.webp', import.meta.url));
  assert.ok(w2 >= 1200 && h2 >= 750, `compare 2x is sharp (${w2}x${h2})`);
});

test('every change-log entry has a clickable picture and every link opens a drawn spot or moment', () => {
  const start = html.indexOf('<ol class="log">');
  const log = html.slice(start, html.indexOf('</ol>', start));
  const items = [...log.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(m => m[1]);
  assert.ok(items.length >= 5, 'the change log lists the milestones');
  for (const item of items) {
    const thumb = item.match(/<a\b[^>]*class="log-thumb"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<img\b[^>]+>[\s\S]*?<\/a>/);
    assert.ok(thumb, `every change-log entry has a clickable thumbnail: ${stripTags(item).slice(0, 60)}`);
  }
  const links = [...log.matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
  assert.ok(links.length >= items.length, 'the change log links to the spots it talks about');
  for (const href of links) {
    assert.match(href, /^\.\/(#.*)?$/, `${href} stays on the map`);
    const hash = href.slice(2);
    if (!hash) continue;
    const v = readViewHash(hash), m = readMoment(hash);
    assert.ok(v || m, `${href} names a view or a moment`);
    if (v) assert.ok(inRegion(v.a, v.x, v.y), `${href} is inside the drawn map`);
  }
});

test('each named change-log link opens on the spot its words name', () => {
  const want = {
    'Church Street up close': [44.4780, -73.2128],
    'Downtown at night': [44.4775, -73.2140],
    'Union Station': [44.47578, -73.21951],
  };
  for (const [text, [lat, lon]] of Object.entries(want)) {
    const m = html.match(new RegExp(`href="([^"]+)">${text}<`));
    assert.ok(m, `the change log has "${text}"`);
    const v = readViewHash(m[1].replace(/&amp;/g, '&').slice(2));
    const [x, y] = latLonToPx(v.a, lat, lon, 30);
    // within about 100 m of the spot (0.23 m a pixel)
    assert.ok(Math.hypot(v.x - x, v.y - y) < 450, `"${text}" opens ${Math.round(Math.hypot(v.x - x, v.y - y) * 0.23)} m from it`);
  }
});

test('the support card has the exact copy, Venmo and Suggest buttons, no email address, and the agreed footer', () => {
  const sIdx = html.indexOf('id="support"');
  assert.ok(sIdx !== -1, 'support section exists');
  const support = html.slice(sIdx, html.indexOf('</section>', sIdx));
  assert.match(support, /<h2\b[^>]*>Help draw more of Vermont<\/h2>/);
  assert.ok(
    stripTags(support).includes("The map is one person's side project. Tips help keep it online and pay for drawing the next towns. Any amount helps, and I'll move your neighborhood up the list."),
    'support copy matches Morgan\'s approved text word for word',
  );
  const venmoLink = support.match(/<a\b[^>]*href="([^"]+)"[^>]*>Venmo @morgan-holland<\/a>/);
  assert.ok(venmoLink, 'Venmo @morgan-holland button exists');
  assert.equal(venmoLink[1].replace(/&amp;/g, '&'), EXPECTED_VENMO);
  assert.match(support, /<a\b[^>]*href="\.\/#fix"[^>]*>Suggest the next neighborhood<\/a>/);

  // no email address anywhere on the page
  assert.doesNotMatch(html, /mailto:/i, 'no mailto links on the page');
  assert.doesNotMatch(html, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, 'no email address on the page');

  // footer line
  const foot = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/);
  assert.ok(foot, 'footer exists');
  assert.ok(
    stripTags(foot[1]).includes("What's new is under Changes, and the data and people behind it under Thanks."),
    `footer line matches exact copy (got: ${stripTags(foot[1])})`,
  );
});
