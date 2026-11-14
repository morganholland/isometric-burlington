// End-to-end checks of the built site in a real browser (desktop + phone).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 4817, URL0 = `http://127.0.0.1:${PORT}/`;
let server, browser;
const SHOTS = process.env.SHOTS_DIR;

before(async () => {
  server = spawn('python3', ['-m', 'http.server', String(PORT), '-d', 'site'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.kill(); });

async function open(ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // a failed load is judged by its URL (the console message has none): only outside services and the
  // manifest (absent until a view is tiled) may fail
  page.on('console', m => { if (m.type() === 'error' && !/api\.weather\.gov|nominatim|manifest|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400 && !/api\.weather\.gov|nominatim|manifest\.json|\.webp$/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  // live flights come from a serverless function the static test server does not have: answer for it
  await page.route('**/api/flights', r => r.fulfill({ json: { now: Date.now(), ac: [
    { id: 'a1b2c3', flight: 'JBU1234', type: 'A320', lat: 44.4759, lon: -73.2121, altFt: 3000, ground: false, gs: 160, track: 15, vr: -700, age: 1 },
  ] } }));
  await page.goto(URL0);
  await page.waitForFunction(() => window.__iso);
  return { ctx, page, errors };
}

test('desktop: loads, turns, zooms, sets time and weather', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  assert.equal(await page.isVisible('#layers'), false, 'layers panel starts closed');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-start.png` });
  const man = fs.existsSync('site/manifest.json') ? JSON.parse(fs.readFileSync('site/manifest.json', 'utf8')) : null;
  const ready = man && man.angles ? man.angles.map(Boolean) : [false, false, false, false];
  // while nothing is drawn the "being drawn" note is up; it goes once any view has tiles
  assert.equal(await page.isVisible('#drawing'), !ready.some(Boolean));
  if (!ready[0]) assert.ok(await page.locator('path.leaflet-interactive, .leaflet-overlay-pane path').count() >= 1, 'outline of the coming map');
  const firstReady = ready.indexOf(true);
  if (firstReady >= 0) {
    for (let i = 0; i < firstReady; i++) await page.click('#rot-right');
    await page.waitForFunction(() => [...document.querySelectorAll('.iso-tiles img')].some(i => i.complete && i.naturalWidth === 512), null, { timeout: 20000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-tiles.png` });
    for (let i = firstReady; i < 4; i++) await page.click('#rot-right');
  }
  // north arrow: angle 0 looks east, so north is to the left
  assert.match(await page.getAttribute('#compass', 'aria-label'), /left/);
  const c0 = await page.evaluate(() => window.__iso.toPx(window.__iso.map.getCenter()));
  await page.click('#rot-right');
  assert.match(await page.getAttribute('#compass', 'aria-label'), /down/);
  assert.equal(await page.evaluate(() => window.__iso.state.angle), 1);
  for (let i = 0; i < 3; i++) await page.click('#rot-right');
  assert.equal(await page.evaluate(() => window.__iso.state.angle), 0);
  const c1 = await page.evaluate(() => window.__iso.toPx(window.__iso.map.getCenter()));
  const tol = 1.5 * 2 ** -(await page.evaluate(() => window.__iso.map.getZoom()));
  assert.ok(Math.hypot(c0[0] - c1[0], c0[1] - c1[1]) <= tol, `a full turn returns to the same spot (${c0} vs ${c1})`);
  assert.match(page.url(), /#a=0&x=/);
  const z = await page.evaluate(() => window.__iso.map.getZoom());
  await page.click('#zoom-in'); await page.waitForTimeout(400);
  assert.ok(await page.evaluate(() => window.__iso.map.getZoom()) > z);
  await page.click('#layers-btn');
  await page.check('input[name=time][value=night]');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--night').trim()), '1.000');
  await page.check('input[name=wx][value=snow]');
  assert.equal(await page.evaluate(() => window.__iso && document.querySelector('#fx') && true), true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-night-snow.png` });
  await page.check('input[name=time][value=day]');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--night').trim()), '0.000');
  // keyboard
  await page.keyboard.press(']');
  assert.equal(await page.evaluate(() => window.__iso.state.angle), 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: search finds Church Street and drops a pin', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  await page.fill('#q', 'Church Street Marketplace');
  try { await page.waitForSelector('#results button', { timeout: 8000 }); }
  catch { console.warn('search service unreachable, skipping'); await ctx.close(); return; }
  await page.click('#results button >> nth=0');
  await page.waitForSelector('.pin-label');
  assert.match(await page.textContent('.pin-label'), /Church/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: nothing overflows and controls are reachable', async () => {
  const { ctx, page, errors } = await open({ ...devices['iPhone 13'] });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  for (const sel of ['#q', '#rot-right', '#zoom-in', '#layers-btn', '#share-btn', '#snap-btn', '#compass', '#about-btn']) {
    const b = await page.locator(sel).boundingBox();
    assert.ok(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= 390 && b.y + b.height <= 844, `${sel} on screen`);
  }
  // brand and search must not overlap
  const a = await page.locator('.brand').boundingBox(), s = await page.locator('#search').boundingBox();
  assert.ok(a.y + a.height <= s.y + 1, `brand above search (${JSON.stringify(a)} ${JSON.stringify(s)})`);
  await page.tap('#rot-left');
  assert.equal(await page.evaluate(() => window.__iso.state.angle), 3);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone.png` });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('buses run on the timetable and say which route they are', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  await page.waitForFunction(() => window.__iso.buses.data);
  // 8:30 am on a Tuesday in Burlington, looking at downtown
  await page.evaluate(() => {
    const target = Date.parse('2026-11-10T13:30:00Z');
    window.__iso.buses.offsetMs = target - Date.now();
    window.__iso.goTo(44.4759, -73.2121, 'Downtown');
  });
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.__iso.map.setZoom(-3, { animate: false }));
  await page.waitForFunction(() => window.__iso.buses.drawn.length > 0, null, { timeout: 5000 });
  const n = await page.evaluate(() => window.__iso.buses.drawn.length);
  assert.ok(n >= 2 && n < 80, `${n} buses on screen`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-buses.png` });
  // a bus that is not under one of the floating cards
  const p = await page.evaluate(() => { const d = window.__iso.buses.drawn.find(d => document.elementFromPoint(d.x, d.y)?.closest('#map')); return d && [d.x, d.y]; });
  assert.ok(p, 'a bus in the open map');
  await page.mouse.move(p[0], p[1]);
  await page.waitForSelector('#bus-tip:not([hidden])', { timeout: 3000 });
  assert.match(await page.textContent('#bus-tip b'), /^Route \w+/);
  await page.click('#layers-btn');
  await page.uncheck('#show-buses');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__iso.buses.drawn.length), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a live plane is drawn at its altitude and says what it is', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  await page.evaluate(() => window.__iso.goTo(44.4759, -73.2121, 'Downtown'));
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.__iso.map.setZoom(-3, { animate: false }));
  await page.waitForFunction(() => window.__iso.planes.drawn.length === 1, null, { timeout: 15000 });
  const p = await page.evaluate(() => { const d = window.__iso.planes.drawn[0]; return [d.x, d.y]; });
  // 3000 ft up, so drawn well above the downtown pin on screen
  const pin = await page.evaluate(() => { const r = document.querySelector('.pin-dot').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  assert.ok(pin[1] - p[1] > 100, `plane ${p} vs pin ${pin}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-plane.png` });
  await page.mouse.move(p[0], p[1]);
  await page.waitForSelector('#bus-tip:not([hidden])', { timeout: 3000 });
  assert.equal(await page.textContent('#bus-tip b'), 'JBU1234');
  assert.match(await page.textContent('#bus-tip .long'), /A320 · 2,9\d\d ft|A320 · 3,000 ft/);
  await page.click('#layers-btn');
  await page.uncheck('#show-planes');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__iso.planes.drawn.length), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('first visit shows a hint once; ? explains how to use the map', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.waitForSelector('#hint:not([hidden])');
  await page.click('#hint-more');
  await page.waitForSelector('#about:not([hidden])');
  assert.match(await page.textContent('#about'), /Turn the city/);
  assert.match(await page.textContent('#about'), /Isometric Toronto/);
  const box = await page.locator('#about').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, JSON.stringify(box));
  assert.ok(await page.isHidden('#hint'), 'opening the guide dismisses the hint');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-about.png` });
  await page.click('#about-close');
  assert.ok(await page.isHidden('#about'));
  await page.reload();
  await page.waitForFunction(() => window.__iso && window.__iso.map._loaded);
  await page.waitForTimeout(300);
  assert.ok(await page.isHidden('#hint'), 'the hint shows only once');
  await page.click('#about-btn');
  await page.waitForSelector('#about:not([hidden])');
  assert.ok(await page.isVisible('#tip-link'), 'the Venmo button shows in the guide');
  await page.keyboard.press('Escape');
  assert.ok(await page.isHidden('#about'));
  assert.match(await page.textContent('.status .credit-short'), /Google/);
  assert.equal(await page.getAttribute('#tip-link', 'href'), 'https://venmo.com/morgan-holland?txn=pay&note=Isometric%20Burlington%20%E2%98%95');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('analytics: records turns, guide opens and tips, and stays silent off the live domain', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  const posthogCalls = [];
  page.on('request', r => { if (/posthog\.com/.test(r.url())) posthogCalls.push(r.url()); });
  await page.waitForFunction(() => window.__iso.map._loaded);
  await page.click('#rot-right');
  await page.click('#about-btn');
  await page.waitForSelector('#about:not([hidden])');
  // the Venmo link opens a new tab; keep the click local
  await ctx.route('https://venmo.com/**', r => r.fulfill({ body: 'ok' }));
  await page.click('#tip-link');
  const events = await page.evaluate(() => window.__isoEvents);
  assert.deepEqual(events.map(e => e.event), ['map_rotated', 'about_opened', 'tip_clicked']);
  assert.deepEqual(events[0].props, { angle: 1, direction: 'right' });
  assert.deepEqual(events[2].props, { placement: 'about' });
  assert.equal(await page.evaluate(() => typeof window.posthog), 'undefined', 'PostHog is not loaded on localhost');
  assert.deepEqual(posthogCalls, []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('zoomed in: street names are drawn crisp, on the streets, and out of the way of buildings', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  await page.waitForFunction(() => window.__iso.labels.data);
  // downtown at the drawing's own size (zoom 0)
  await page.evaluate(() => { window.__iso.goTo(44.4766, -73.2125, 'Downtown'); });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__iso.map.setZoom(0, { animate: false }));
  await page.waitForFunction(() => window.__iso.labels.placed && window.__iso.labels.placed.length >= 3, null, { timeout: 5000 });
  const names = await page.evaluate(() => window.__iso.labels.shown);
  assert.ok(names.includes('Main Street'), `Main Street labelled (${names})`);
  // the canvas is drawn at the screen's real pixel density
  assert.equal(await page.evaluate(() => document.querySelector('#labels').width), 1400 * (await page.evaluate(() => Math.min(devicePixelRatio, 2))));
  // never on a stretch a building stands in front of
  const bad = await page.evaluate(() => window.__iso.labels.audit());
  assert.deepEqual(bad, []);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-labels.png` });
  // zoomed out to the whole city: neighbourhoods and the lake instead of side streets
  await page.evaluate(() => window.__iso.map.setZoom(-4.5, { animate: false }));
  await page.waitForTimeout(300);
  const far = await page.evaluate(() => window.__iso.labels.shown);
  assert.ok(far.includes('DOWNTOWN') && far.includes('Lake Champlain'), `overview names (${far})`);
  assert.ok(!far.includes('Orchard Terrace'), 'no side streets from far away');
  // the paper grain grows as you zoom past the drawing's resolution
  const paper = () => page.evaluate(() => +getComputedStyle(document.documentElement).getPropertyValue('--paper'));
  assert.equal(await paper(), 0);
  await page.evaluate(() => window.__iso.map.setZoom(2, { animate: false }));
  await page.waitForTimeout(100);
  assert.equal(await paper(), 1);
  // names can be switched off
  await page.click('#layers-btn');
  await page.uncheck('#show-labels');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__iso.labels.placed.length), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('places worth a look: pins and the ★ list open a note, and turn with the map', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  await page.waitForFunction(() => window.__iso.places.list.length >= 10);
  await page.click('#places-btn');
  await page.waitForSelector('#places-list:not([hidden])');
  const items = await page.locator('#places-list button').allTextContents();
  assert.ok(items.includes('Battery Park'), items.join(', '));
  await page.click('#places-list button:text("Battery Park")');
  await page.waitForSelector('#place:not([hidden])');
  assert.equal(await page.textContent('#place h2'), 'Battery Park');
  assert.match(await page.textContent('#place p'), /1812/);
  assert.ok(await page.isHidden('#places-list'), 'the list closes when a place opens');
  await page.waitForTimeout(1500);
  const pin = page.locator('.place-pin[aria-label^="Battery Park"]');
  const b = await pin.boundingBox();
  assert.ok(b && Math.abs(b.x - 700) < 120 && Math.abs(b.y - 440) < 120, `the map flies to the pin (${JSON.stringify(b)})`);
  await page.keyboard.press('Escape');
  assert.ok(await page.isHidden('#place'));
  // a pin itself opens its note
  await pin.click();
  await page.waitForSelector('#place:not([hidden])');
  assert.equal(await page.textContent('#place h2'), 'Battery Park');
  await page.click('#place-close');
  // turning the map moves the pins with it
  await page.click('#rot-right');
  assert.ok(await page.locator('.place-pin[aria-label^="Battery Park"]').count() === 1);
  const ev = await page.evaluate(() => window.__isoEvents.filter(e => e.event === 'place_opened').map(e => e.props.via));
  assert.deepEqual(ev, ['list', 'pin']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the How it was made page loads, links back, and is linked from the map', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  assert.equal(await page.locator('.status .credit a[href="./how.html"]').count(), 1);
  await page.click('#about-btn');
  await page.click('#about a[href="./how.html"]');
  await page.waitForURL(/how\.html$/);
  assert.match(await page.textContent('h1'), /How it was made/);
  assert.match(await page.textContent('main'), /melt/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'fits a phone');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/how-phone.png`, fullPage: true });
  await page.click('a.back');
  await page.waitForFunction(() => window.__iso);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('places: dragging the map from a pin does not open it; the note takes and returns focus', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  const reqs = [];
  page.on('request', r => { if (/labels\.json/.test(r.url())) reqs.push(r.url()); });
  await page.reload(); await page.waitForFunction(() => window.__iso && window.__iso.places.list.length);
  assert.equal(reqs.length, 1, 'labels.json is downloaded once');
  await page.evaluate(() => { const p = window.__iso.places.list.find(p => p.name === 'Battery Park'); window.__iso.goTo(p.lat, p.lon, 'x'); });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__iso.map.setZoom(-1, { animate: false }));
  await page.waitForTimeout(300);
  const pin = page.locator('.place-pin[aria-label^="Battery Park"] .place-mark');
  const b = await pin.boundingBox();
  await page.mouse.move(b.x + 6, b.y + 6); await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(b.x + 6 + k * 20, b.y + 6 + k * 8);
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.ok(await page.isHidden('#place'), 'a drag that starts on a pin only moves the map');
  // keyboard: Enter on a pin opens its note, focus goes to the note and comes back on Escape
  await page.focus('.place-pin[aria-label^="Battery Park"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#place:not([hidden])');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'place-close');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.place-pin')?.dataset.i != null), true);
  // street names keep clear of the pins
  const clash = await page.evaluate(() => {
    const L = window.__iso.labels, boxes = L.reserved();
    return L.placed.filter(p => boxes.some(b => p.x0 < b.x1 && p.x1 > b.x0 && p.y0 < b.y1 && p.y1 > b.y0)).length;
  });
  assert.equal(clash, 0);
  const ev = await page.evaluate(() => window.__isoEvents.filter(e => e.event === 'place_opened').map(e => e.props.via));
  assert.deepEqual(ev, ['pin']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('cars drive the streets when you are close, more at rush hour, and can be switched off', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  const reqs = [];
  page.on('request', r => { if (/streets\.json/.test(r.url())) reqs.push(r.url()); });
  // from far away there is nothing to see, so the streets are not even downloaded
  await page.evaluate(() => window.__iso.map.setZoom(-5, { animate: false }));
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__iso.cars.shown), 0);
  // 5 pm on a Tuesday, downtown, at the drawing's own size
  await page.evaluate(() => {
    window.__iso.cars.offsetMs = Date.parse('2026-11-10T22:00:00Z') - Date.now();
    window.__iso.goTo(44.4766, -73.2125, 'Downtown');
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__iso.map.setZoom(-1, { animate: false }));
  await page.waitForFunction(() => window.__iso.cars.shown > 0, null, { timeout: 8000 });
  await page.waitForTimeout(1500);
  const rush = await page.evaluate(() => window.__iso.cars.shown);
  assert.ok(rush >= 8 && rush <= 1500, `${rush} cars on screen at rush hour`);
  // they move
  const where = () => page.evaluate(() => window.__iso.cars.sim.cars.slice(0, 40).map(c => [c.lane.id, c.s]));
  const p0 = await where(); await page.waitForTimeout(1200); const p1 = await where();
  assert.ok(p0.some((p, i) => p1[i] && (p[0] !== p1[i][0] || Math.abs(p[1] - p1[i][1]) > 2)), 'cars are moving');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-cars.png` });
  // 3 am: the same streets are nearly empty
  await page.evaluate(() => {
    const c = window.__iso.cars; c.offsetMs = Date.parse('2026-11-10T08:00:00Z') - Date.now();
    c.sim.setArea(null); c.aim();
  });
  await page.waitForTimeout(600);
  const small = await page.evaluate(() => window.__iso.cars.shown);
  assert.ok(small < rush / 4, `3 am (${small}) is far quieter than 5 pm (${rush})`);
  await page.click('#layers-btn');
  await page.uncheck('#show-cars');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__iso.cars.shown), 0);
  assert.equal(await page.evaluate(() => window.__iso.cars.sim.cars.length), 0);
  assert.equal(reqs.length, 1, 'streets.json is downloaded once');
  assert.match(await page.textContent('#about'), /cars are simulated, not tracked/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('people who ask for less motion start without cars', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 }, reducedMotion: 'reduce' });
  assert.equal(await page.isChecked('#show-cars'), false);
  assert.equal(await page.evaluate(() => window.__iso.cars.on), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('night: lamps, windows and the airfield light up; by day nothing glows or downloads', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 880 } });
  const page = await ctx.newPage();
  const errors = [], reqs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/lights\.json/.test(r.url())) reqs.push(r.url()); });
  await page.route('**/api/flights', r => r.fulfill({ json: { now: Date.now(), ac: [] } }));
  await page.clock.setFixedTime(new Date('2026-06-15T16:00:00Z'));       // noon in Burlington
  await page.goto(URL0);
  await page.waitForFunction(() => window.__iso);
  // the clock is stopped, so jump instead of flying
  const jump = (lat, lon, z) => page.evaluate(([lat, lon, z]) => { const I = window.__iso; I.goTo(lat, lon, 'x'); I.map.stop(); I.map.setView(I.state.marker.layer.getLatLng(), z, { animate: false }); }, [lat, lon, z]);
  await jump(44.4766, -73.2125, -1);
  await page.waitForTimeout(500);
  assert.equal(reqs.length, 0, 'no night data by day');
  assert.equal(await page.evaluate(() => +document.querySelector('#lights').style.opacity), 0);
  await page.click('#layers-btn');
  await page.check('input[name=time][value=night]');
  await page.waitForFunction(() => window.__iso.lights.count.lamps > 0, null, { timeout: 8000 });
  const n = await page.evaluate(() => window.__iso.lights.count);
  assert.ok(n.lamps >= 20, `${n.lamps} street lamps downtown`);
  assert.ok(n.windows >= 50, `${n.windows} lit windows downtown`);
  assert.equal(await page.evaluate(() => +document.querySelector('#lights').style.opacity), 1);
  // light really lands on the canvas
  const lit = await page.evaluate(() => { const c = document.querySelector('#lights'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) k++; return k; });
  assert.ok(lit > 500, `${lit} lit pixels`);
  assert.match(page.url(), /&t=night$/, 'a forced night travels with the link');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-night-lights.png` });
  // the airport: runway and taxiway lights
  await jump(44.4719, -73.1533, -2);
  await page.waitForFunction(() => window.__iso.lights.count.field > 10, null, { timeout: 5000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-night-airport.png` });
  await page.check('input[name=time][value=day]');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => +document.querySelector('#lights').style.opacity), 0);
  assert.equal(reqs.length, 1, 'lights.json is downloaded once');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('share copies a link that opens the same view, night included; snapshot saves a picture', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  await page.evaluate(() => window.__iso.goTo(44.4766, -73.2125, 'Downtown'));
  await page.waitForTimeout(1500);
  await page.click('#rot-right');
  await page.click('#layers-btn');
  await page.check('input[name=time][value=night]');
  await page.click('#layers-btn');
  await page.click('#share-btn');
  await page.waitForSelector('#toast:not([hidden])');
  assert.match(await page.textContent('#toast'), /Link to this view copied/);
  const link = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(link, page.url());
  assert.match(link, /#a=1&x=-?\d+&y=-?\d+&z=-?[\d.]+&t=night$/);
  const view = () => page.evaluate(() => ({ a: window.__iso.state.angle, c: window.__iso.toPx(window.__iso.map.getCenter()).map(Math.round), z: window.__iso.map.getZoom(), t: window.__iso.state.timeMode }));
  const v0 = await view();
  const page2 = await ctx.newPage();
  await page2.route('**/api/flights', r => r.fulfill({ json: { now: Date.now(), ac: [] } }));
  await page2.goto(link);
  await page2.waitForFunction(() => window.__iso && window.__iso.map._loaded);
  const v1 = await page2.evaluate(() => ({ a: window.__iso.state.angle, c: window.__iso.toPx(window.__iso.map.getCenter()).map(Math.round), z: window.__iso.map.getZoom(), t: window.__iso.state.timeMode }));
  assert.deepEqual(v1, v0);
  assert.equal(await page2.isChecked('input[name=time][value=night]'), true);
  assert.equal(await page2.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--night').trim()), '1.000');
  await page2.close();
  // the picture
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#snap-btn')]);
  assert.match(dl.suggestedFilename(), /^isometric-burlington-\d{4}-\d\d-\d\d\.jpg$/);
  const buf = fs.readFileSync(await dl.path());
  assert.ok(buf[0] === 0xFF && buf[1] === 0xD8, 'a JPEG');
  assert.ok(buf.length > 8000, `picture of ${buf.length} bytes`);
  const ev = await page.evaluate(() => window.__isoEvents.map(e => e.event));
  assert.ok(ev.includes('view_shared') && ev.includes('snapshot_saved'), ev.join(','));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the map still works when the street and lights files cannot be had; a picture with no map in it is not saved', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 880 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/flights', r => r.fulfill({ json: { now: Date.now(), ac: [] } }));
  await page.route(/(streets|lights)\.json/, r => r.fulfill({ status: 404, body: 'gone' }));
  await page.goto(URL0);
  await page.waitForFunction(() => window.__iso && window.__iso.map._loaded);
  await page.evaluate(() => window.__iso.goTo(44.4766, -73.2125, 'Downtown'));
  await page.click('#layers-btn');
  await page.check('input[name=time][value=night]');
  await page.click('#layers-btn');
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--night').trim()), '1.000');
  await page.click('#rot-right');
  await page.waitForFunction(() => window.__iso.state.angle === 1);
  // a tile that cannot be fetched: no picture rather than an empty one
  const r = await page.evaluate(async () => {
    const { snapshot } = window.__iso;
    const s = await snapshot({ width: 300, height: 200, night: 0, caption: 'x', layers: [], tileUrl: u => u, tiles: [{ src: 'nope/1.webp', x: 0, y: 0, w: 300, h: 200 }] });
    return { drawn: s.drawn, asked: s.asked };
  });
  assert.deepEqual(r, { drawn: 0, asked: 1 });
  assert.deepEqual(errors, []);
  await ctx.close();
});
