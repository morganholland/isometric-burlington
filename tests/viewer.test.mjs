// End-to-end checks of the built site in a real browser (desktop + phone).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { latLonToPx, GROUND_U } from '../viewer/geo.js';
import { encodeList } from '../viewer/lists.js';

const PORT = 4817, URL0 = `http://127.0.0.1:${PORT}/`;
let server, browser;
const SHOTS = process.env.SHOTS_DIR;

before(async () => {
  server = spawn('python3', ['-m', 'http.server', String(PORT), '-d', 'site'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.kill(); });

async function open(opts) {
  const { snowDepth, hash, ...ctxOpts } = opts;
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // a failed load is judged by its URL (the console message has none): only outside services and the
  // manifest (absent until a view is tiled) may fail
  page.on('console', m => { if (m.type() === 'error' && !/api\.weather\.gov|open-meteo|nominatim|manifest|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400 && !/api\.weather\.gov|open-meteo|nominatim|manifest\.json|\.webp$/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  // live flights come from a serverless function the static test server does not have: answer for it
  await page.route('**/api/flights', r => r.fulfill({ json: { now: Date.now(), ac: [
    { id: 'a1b2c3', flight: 'JBU1234', type: 'A320', lat: 44.4759, lon: -73.2121, altFt: 3000, ground: false, gs: 160, track: 15, vr: -700, age: 1 },
  ] } }));
  // snow lying at BTV (Open-Meteo): none unless a test says otherwise
  await page.route('**/api.open-meteo.com/**', r => r.fulfill({ json: { current: { snow_depth: snowDepth ?? 0 } } }));
  await page.goto(URL0 + (hash || ''));
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

test('the Amtrak train parks at Union Station overnight and says so', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  await page.waitForFunction(() => window.__iso.buses.data);
  // 11 pm on a Tuesday, looking at the waterfront by the station
  await page.evaluate(() => {
    window.__iso.buses.offsetMs = Date.parse('2026-11-25T04:00:00Z') - Date.now();   // inside the feed's dates
    window.__iso.goTo(44.4757, -73.2195, 'Union Station');
  });
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.__iso.map.setZoom(-0.5, { animate: false }));
  await page.waitForFunction(() => window.__iso.buses.drawn.filter(d => d.b.train).length === 6, null, { timeout: 5000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-train.png` });
  const p = await page.evaluate(() => { const d = window.__iso.buses.drawn.find(d => d.b.train && document.elementFromPoint(d.x, d.y)?.closest('#map')); return d && [d.x, d.y]; });
  assert.ok(p, 'a car of the train in the open map');
  await page.mouse.move(p[0], p[1]);
  await page.waitForSelector('#bus-tip:not([hidden])', { timeout: 3000 });
  assert.equal(await page.textContent('#bus-tip b'), 'Amtrak Ethan Allen Express');
  assert.match(await page.textContent('#bus-tip .long'), /Parked at Union Station/);
  assert.match(await page.textContent('#bus-tip .until'), /leaves for New York at 9:25 am/);
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

test('About page: drag to compare, and a change-log link opens its spot', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1200, height: 860 } });
  await page.goto(URL0 + 'how.html');
  const frame = page.locator('.compare .frame');
  await frame.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll('.compare img')].every(i => i.complete && i.naturalWidth === 1600));
  const cut = () => frame.evaluate(f => parseFloat(f.style.getPropertyValue('--cut')));
  assert.equal(await cut(), 50, 'starts half and half');
  // the "before" picture is cut where the slider is: drag from the middle towards the left
  const box = await frame.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const dragged = await cut();
  assert.ok(dragged > 12 && dragged < 28, `dragged to about a fifth (${dragged})`);
  // what is drawn follows: the "before" picture is cut at the same place, and the knob sits there
  const clip = await page.locator('.compare .before').evaluate(i => getComputedStyle(i).clipPath);
  assert.match(clip, new RegExp(`inset\\(0(px)? calc\\(100% - ${dragged}%\\)|inset\\(0(px)? ${100 - dragged}%`), `clipped at ${dragged}% (${clip})`);
  const knob = await page.locator('.compare .knob').boundingBox();
  assert.ok(Math.abs(knob.x + knob.width / 2 - (box.x + box.width * dragged / 100)) < 3, 'the knob is on the cut');
  assert.match(await page.getAttribute('.compare input', 'aria-valuetext'), new RegExp(`^${dragged}% Google`));
  // and from the keyboard
  await page.focus('.compare input');
  await page.keyboard.press('ArrowRight');
  assert.equal(await cut(), dragged + 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/how-compare.png` });
  // the numbers row and change log fit a phone
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'fits a phone');
  // "Look for Champ" opens the map with Champ asked for
  await page.click('.log a[href="./#m=champ"]');
  await page.waitForFunction(() => window.__iso && window.__iso.state.moment === 'champ');
  assert.equal(await page.evaluate(() => window.__iso.moments.on), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('About page on a phone: a sideways swipe moves the cut, an up-and-down swipe scrolls the page', async () => {
  const { ctx, page, errors } = await open({ ...devices['iPhone 13'] });
  await page.goto(URL0 + 'how.html');
  await page.locator('.compare .frame').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll('.compare img')].every(i => i.complete && i.naturalWidth === 1600));
  const cdp = await ctx.newCDPSession(page);
  const swipe = async (from, to) => {
    const pt = ([x, y]) => [{ x, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from) });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt([from[0] + (to[0] - from[0]) * i / 8, from[1] + (to[1] - from[1]) * i / 8]) });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
  };
  const cut = () => page.locator('.compare .frame').evaluate(f => parseFloat(f.style.getPropertyValue('--cut')));
  let box = await page.locator('.compare .frame').boundingBox();
  const cy = box.y + box.height / 2;
  await swipe([box.x + box.width * 0.7, cy], [box.x + box.width * 0.2, cy]);
  const c = await cut();
  assert.ok(c > 12 && c < 30, `a sideways swipe moves the cut (${c})`);
  const y0 = await page.evaluate(() => scrollY);
  box = await page.locator('.compare .frame').boundingBox();
  await swipe([box.x + box.width * 0.8, box.y + box.height * 0.8], [box.x + box.width * 0.8, box.y + 10]);
  assert.ok(await page.evaluate(() => scrollY) > y0 + 40, 'the page scrolls');
  assert.equal(await cut(), c, 'scrolling past the picture leaves the cut alone');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('corrections: "Something wrong here?" sends a note with the spot in the middle of the map', async () => {
  // the map centred on the Flynn (Main Street), seen from the second side
  const [fx, fy] = latLonToPx(1, 44.47600, -73.21300, GROUND_U);
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 820 }, hash: `#a=1&x=${Math.round(fx)}&y=${Math.round(fy)}&z=0` });
  await page.click('#about-btn');
  await page.click('#fix-open');
  assert.ok(await page.isHidden('#about'), 'the guide steps aside');
  assert.ok(await page.isVisible('#fix'));
  assert.ok(await page.isVisible('#fix-aim'), 'a crosshair marks the spot being reported');
  const aim = await page.locator('#fix-aim').boundingBox();
  assert.ok(Math.abs(aim.x + aim.width / 2 - 640) < 2 && Math.abs(aim.y + aim.height / 2 - 410) < 2, 'the crosshair is the middle of the map');
  assert.ok(await page.isDisabled('#fix-send'), 'nothing to send yet');
  await page.fill('#fix-note', 'The church steeple is missing.');
  await page.click('#fix-send');
  const ev = await page.evaluate(() => window.__isoEvents.filter(e => e.event === 'correction_sent').map(e => e.props));
  assert.equal(ev.length, 1);
  const st = await page.evaluate(() => { const [x, y] = window.__iso.toPx(window.__iso.map.getCenter()); return { a: window.__iso.state.angle, x: Math.round(x), y: Math.round(y), z: window.__iso.map.getZoom() }; });
  assert.deepEqual([ev[0].note, ev[0].angle, ev[0].x, ev[0].y, ev[0].zoom], ['The church steeple is missing.', st.a, st.x, st.y, st.z]);
  assert.ok(Math.abs(ev[0].lat - 44.476) < 1e-4 && Math.abs(ev[0].lon + 73.213) < 1e-4, `the spot is the Flynn (${ev[0].lat}, ${ev[0].lon})`);
  assert.ok(await page.isHidden('#fix') && await page.isHidden('#fix-aim'));
  assert.match(await page.textContent('#toast'), /Thanks/);
  // Escape closes it without sending
  await page.click('#about-btn'); await page.click('#fix-open');
  await page.fill('#fix-note', 'never mind');
  await page.keyboard.press('Escape');
  assert.ok(await page.isHidden('#fix'));
  assert.equal(await page.evaluate(() => window.__isoEvents.filter(e => e.event === 'correction_sent').length), 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('corrections: one card at a time, and on a phone the note stays clear of the crosshair', async () => {
  const { ctx, page, errors } = await open({ ...devices['iPhone 13'] });
  const openFix = async () => { await page.click('#about-btn'); await page.click('#fix-open'); await page.waitForSelector('#fix', { state: 'visible' }); };
  await openFix();
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'fix-note', 'no keyboard before the map is moved');
  // the guide, the layers panel and the places list each close the note
  await page.click('#about-btn');
  assert.ok(await page.isVisible('#about') && await page.isHidden('#fix') && await page.isHidden('#fix-aim'), 'the guide replaces the note');
  await page.click('#fix-open');
  await page.click('#layers-btn');
  assert.ok(await page.isVisible('#layers') && await page.isHidden('#fix'), 'the layers panel replaces the note');
  await openFix();
  assert.ok(await page.isHidden('#layers'), 'the note replaces the layers panel');
  // with the keyboard up the screen is short: the note must not cover the spot being reported
  await page.setViewportSize({ width: 390, height: 500 });
  const card = await page.locator('#fix').boundingBox(), aim = await page.locator('#fix-aim').boundingBox();
  assert.ok(card.y > aim.y + aim.height || card.y + card.height < aim.y, `note ${Math.round(card.y)}-${Math.round(card.y + card.height)} clear of crosshair ${Math.round(aim.y)}-${Math.round(aim.y + aim.height)}`);
  assert.ok(await page.locator('#fix-note').evaluate(t => parseFloat(getComputedStyle(t).fontSize) >= 16), 'no zoom-on-focus on iPhone');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('corrections: the About page sends people to the map with the note open', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 820 } });
  await page.goto(URL0 + 'how.html');
  await page.click('a[href="./#fix"]');
  await page.waitForFunction(() => window.__iso);
  await page.waitForSelector('#fix', { state: 'visible' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fix-note');
  assert.doesNotMatch(await page.evaluate(() => location.hash), /fix/, 'the link is not kept in the address');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('visitor lists: a link shows the list, apart from the map\'s own places', async () => {
  const list = encodeList({ title: 'Lunch <img src=x onerror="window.__pwned=1">', by: 'Dana', items: [
    { name: 'Church Street', note: 'Start at the top of the street.', lat: 44.4780, lon: -73.2128 },
    { name: 'Waterfront Park', note: 'Eat by the lake.', lat: 44.4790, lon: -73.2230 },
  ] });
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 820 }, hash: `#l=${list}` });
  await page.waitForSelector('#vlist', { state: 'visible' });
  assert.match(await page.textContent('#vlist .eyebrow'), /A list by a visitor/);
  assert.equal(await page.textContent('#vlist-title'), 'Lunch <img src=x onerror="window.__pwned=1">', 'shown as text, never as markup');
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.match(await page.textContent('#vlist .vlist-by'), /by Dana/);
  assert.equal(await page.locator('.vpin').count(), 2, 'a numbered pin for each spot');
  assert.equal(await page.locator('.vpin.place-pin, .place-pin .vpin').count(), 0, "visitors' pins are not the map's own");
  // both spots are on screen: the map opened to fit the list
  const card = await page.locator('#vlist').boundingBox();
  for (const b of await page.locator('.vpin').all()) {
    const r = await b.boundingBox();
    assert.ok(r.x > card.x + card.width && r.x + r.width < 1280 && r.y > 0 && r.y + r.height < 820, `pin ${JSON.stringify(r)} clear of the card`);
  }
  await page.click('#vlist ol li:nth-child(2) button');
  assert.ok(await page.isVisible('#vlist ol li:nth-child(2) .vnote'));
  assert.equal(await page.textContent('#vlist ol li:nth-child(2) .vnote'), 'Eat by the lake.');
  assert.equal(await page.locator('.vpin.on').count(), 1);
  // the list stays in the address as the map moves, and goes when closed
  await page.evaluate(() => window.__iso.map.panBy([120, 0], { animate: false }));
  await page.waitForFunction(() => /&l=/.test(location.hash) && /x=/.test(location.hash));
  await page.click('#vlist-close');
  assert.ok(await page.isHidden('#vlist'));
  assert.equal(await page.locator('.vpin').count(), 0);
  await page.waitForFunction(() => !/l=/.test(location.hash));
  const ev = await page.evaluate(() => window.__isoEvents.filter(e => e.event === 'list_opened').map(e => e.props));
  assert.deepEqual(ev, [{ items: 2 }], 'only the size of a list is counted, never its words');
  // a link that has been cut short is not a list, and does not break the map
  await page.goto(URL0 + '#l=eyJ0Ijoi');
  await page.reload(); await page.waitForFunction(() => window.__iso);
  assert.ok(await page.isHidden('#vlist'));
  assert.match(await page.textContent('#toast'), /cut short/, 'and says so');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('visitor lists: make one from the ★ panel, and its link opens the same list', async () => {
  const [x, y] = latLonToPx(0, 44.4780, -73.2128, GROUND_U);
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 820 }, hash: `#a=0&x=${Math.round(x)}&y=${Math.round(y)}&z=-1` });
  await page.waitForFunction(() => window.__iso.places.list.length);
  await page.click('#places-btn');
  await page.click('#mk-open');
  assert.ok(await page.isVisible('#mklist') && await page.isVisible('#fix-aim'), 'the builder and a crosshair');
  assert.ok(await page.isDisabled('#mk-link'), 'nothing to share yet');
  // typed for real, key by key: r, R, [, ], / and ? are map shortcuts everywhere else
  await page.click('#mk-title');
  await page.keyboard.type('A short walk / bar crawl? R[]');
  assert.equal(await page.inputValue('#mk-title'), 'A short walk / bar crawl? R[]');
  assert.equal(await page.evaluate(() => window.__iso.state.angle), 0, 'typing does not turn the map');
  assert.ok(await page.isVisible('#mklist') && await page.isHidden('#about'), 'or open About');
  await page.fill('#mk-title', 'A short walk');
  await page.fill('#mk-by', 'Sam');
  await page.fill('#mk-spot', 'First stop');
  await page.click('#mk-add');
  await page.evaluate(() => window.__iso.map.panBy([300, 120], { animate: false }));
  await page.fill('#mk-spot', 'Second stop');
  await page.press('#mk-spot', 'Enter');
  assert.equal(await page.locator('#mk-items li').count(), 2);
  await page.fill('#mk-items li:nth-child(2) textarea', 'Worth the climb.');
  await page.click('#mk-items li:nth-child(1) .mk-remove');
  await page.fill('#mk-spot', 'Third stop');
  await page.click('#mk-add');
  await page.click('#mk-link');
  const url = await page.inputValue('#mk-url');
  // on a phone the maker sits below the crosshair, so the spot being added stays in view
  await page.setViewportSize({ width: 390, height: 664 });
  const card = await page.locator('#mklist').boundingBox(), aim = await page.locator('#fix-aim').boundingBox();
  assert.ok(card.y > aim.y + aim.height, `maker ${Math.round(card.y)} below crosshair ${Math.round(aim.y + aim.height)}`);
  assert.match(url, /^http.*#a=0&l=[A-Za-z0-9_-]+$/, 'no view in the link, so it opens fitted to the list');
  const ev = await page.evaluate(() => window.__isoEvents.filter(e => e.event === 'list_shared').map(e => e.props));
  assert.deepEqual(ev, [{ items: 2 }]);
  // opened on a phone: every pin on screen and clear of the list's sheet
  const p2 = await ctx.newPage();
  await p2.setViewportSize({ width: 390, height: 664 });
  await p2.goto(url); await p2.waitForSelector('#vlist', { state: 'visible' });
  await p2.waitForFunction(() => document.querySelectorAll('.vpin').length === 2);
  const sheet = await p2.locator('#vlist').boundingBox();
  const search = await p2.locator('#q').boundingBox();
  for (const b of await p2.locator('.vpin').all()) {
    const r = await b.boundingBox();
    assert.ok(r.x >= 0 && r.x + r.width <= 390 && r.y >= search.y + search.height && r.y + r.height <= sheet.y, `pin ${JSON.stringify(r)} clear of sheet at ${sheet.y}`);
  }
  assert.equal(await p2.textContent('#vlist-title'), 'A short walk');
  assert.deepEqual(await p2.locator('#vlist ol li button .vname').allTextContents(), ['Second stop', 'Third stop']);
  await p2.click('#vlist ol li:nth-child(1) button');
  assert.equal(await p2.textContent('#vlist ol li:nth-child(1) .vnote'), 'Worth the climb.');
  // a focused pin keeps focus as the map turns; Escape closes the list
  await p2.focus('.vpin[data-i="1"]');
  await p2.evaluate(() => window.__iso.rotate(1));
  assert.equal(await p2.evaluate(() => document.activeElement?.dataset.i), '1');
  await p2.keyboard.press('Escape');
  assert.ok(await p2.isHidden('#vlist'));
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

test('people who ask for less motion start without cars or moments; a fireworks link shows them held still', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 }, reducedMotion: 'reduce' });
  assert.equal(await page.isChecked('#show-cars'), false);
  assert.equal(await page.evaluate(() => window.__iso.cars.on), false);
  assert.equal(await page.isChecked('#show-moments'), false);
  assert.equal(await page.evaluate(() => window.__iso.moments.on), false);
  await page.goto(URL0 + '#m=fireworks'); await page.reload(); await page.waitForFunction(() => window.__iso);
  await page.waitForFunction(() => window.__iso.moments.drawn.fireworks > 0, null, { timeout: 8000 });
  const where = () => page.evaluate(() => window.__iso.moments.sparks.slice(0, 20).map(p => [p.e, p.n, p.u, p.life]));
  const a = await where(); await page.waitForTimeout(800); const b = await where();
  assert.deepEqual(a, b, 'nothing moves or fades');
  assert.equal(await page.evaluate(() => window.__iso.moments.shells.length), 0, 'nothing launches');
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

const snowVar = page => page.evaluate(() => +getComputedStyle(document.documentElement).getPropertyValue('--snow'));

test('snow lying at BTV turns the map white; bare ground leaves it be; the Weather choice wins', async () => {
  {
    const { ctx, page, errors } = await open({ viewport: { width: 1200, height: 800 }, snowDepth: 0.2 });
    // the weather is applied once both BTV's observation and the snow depth are in (or have failed)
    await page.waitForFunction(() => +getComputedStyle(document.documentElement).getPropertyValue('--snow') === 1, null, { timeout: 15000 });
    assert.match(await page.textContent('#status'), /8″ of snow on the ground/);
    await page.waitForFunction(() => +getComputedStyle(document.querySelector('#snowcover')).opacity > 0.28, null, { timeout: 3000 });   // the white wash is up
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/snow-on-ground.png` });
    await page.click('#layers-btn');
    await page.check('input[name=wx][value=clear]');
    assert.equal(await snowVar(page), 0, 'choosing Clear clears the ground');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open({ viewport: { width: 1200, height: 800 }, snowDepth: 0 });
    await page.waitForFunction(() => window.__iso.state.snowDepth === 0 && getComputedStyle(document.documentElement).getPropertyValue('--snow') !== '');
    await page.waitForTimeout(300);
    assert.equal(await snowVar(page), 0);
    assert.doesNotMatch(await page.textContent('#status'), /snow on the ground/);
    await page.click('#layers-btn');
    await page.check('input[name=wx][value=snow]');
    assert.equal(await snowVar(page), 1, 'choosing Snow whitens it');
    assert.match(await page.textContent('#about'), /Open-Meteo/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test('a fireworks link opens at night with fireworks over the waterfront, and keeps the moment when shared', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 }, hash: '#m=fireworks' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--night').trim()), '1.000');
  await page.waitForFunction(() => window.__iso.moments.drawn.fireworks > 20, null, { timeout: 8000 });
  if (SHOTS) { await page.waitForTimeout(1500); await page.screenshot({ path: `${SHOTS}/fireworks.png` }); }
  await page.evaluate(() => window.__iso.map.panBy([10, 0], { animate: false }));
  await page.waitForTimeout(300);
  assert.match(page.url(), /&m=fireworks/);
  // choosing day puts them out and the moment no longer travels with the link
  await page.click('#layers-btn');
  await page.check('input[name=time][value=day]');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__iso.moments.drawn.fireworks), 0);
  assert.doesNotMatch(page.url(), /&m=/);
  await page.check('input[name=time][value=night]');
  await page.click('#layers-btn');
  // switched off, nothing is drawn
  await page.click('#layers-btn');
  await page.uncheck('#show-moments');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__iso.moments.drawn.fireworks), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('no fireworks on an ordinary evening; holiday lights on Church Street in season', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  await page.waitForFunction(() => window.__iso.moments.bulbs);
  await page.evaluate(() => {
    const m = window.__iso.moments; m.offsetMs = Date.parse('2026-11-10T23:30:00Z') - Date.now();   // 6:30 pm, before the season
    window.__iso.state.timeMode = 'night'; window.__iso.applySky();
    window.__iso.map.stop(); window.__iso.goTo(44.4785, -73.2127, 'Church Street');
  });
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.__iso.map.setZoom(-1, { animate: false }));
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__iso.moments.drawn.fireworks), 0);
  assert.equal(await page.evaluate(() => window.__iso.moments.drawn.holiday), 0, 'no lights before the season');
  await page.evaluate(() => { window.__iso.moments.offsetMs = Date.parse('2026-12-12T23:30:00Z') - Date.now(); });
  await page.waitForFunction(() => window.__iso.moments.drawn.holiday > 30, null, { timeout: 4000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/holiday-lights.png` });
  // by day the season's lights are off
  await page.evaluate(() => { window.__iso.state.timeMode = 'day'; window.__iso.applySky(); });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__iso.moments.drawn.holiday), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Champ surfaces in the lake and says it is a legend when tapped', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 }, hash: '#m=champ' });
  await page.waitForFunction(() => window.__iso.moments.champBox, null, { timeout: 8000 });
  if (await page.isVisible('#hint')) await page.click('#hint-ok');
  // bring it to the middle of the screen, clear of the cards
  await page.evaluate(() => {
    const b = window.__iso.moments.champBox, m = window.__iso.map;
    m.panBy([(b.x0 + b.x1) / 2 - innerWidth / 2, (b.y0 + b.y1) / 2 - innerHeight / 2], { animate: false });
  });
  await page.waitForTimeout(300);
  const b = await page.evaluate(() => window.__iso.moments.champBox);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/champ.png`, clip: { x: b.x0 - 150, y: b.y0 - 100, width: b.x1 - b.x0 + 300, height: b.y1 - b.y0 + 200 } });
  await page.mouse.click((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
  await page.waitForSelector('#bus-tip:not([hidden])');
  assert.match(await page.textContent('#bus-tip'), /Champ/);
  assert.match(await page.textContent('#bus-tip'), /legend/);
  // with the buses switched off too, the tip still goes once Champ has dived
  await page.evaluate(() => { window.__iso.buses.on = false; window.__iso.moments.forced = null; window.__iso.moments.offsetMs = 0; });
  await page.evaluate(() => { const m = window.__iso.moments; m.active = () => ({ fireworks: false, holiday: false, champ: null }); });
  await page.waitForSelector('#bus-tip', { state: 'hidden', timeout: 3000 });
  await page.evaluate(() => { delete window.__iso.moments.active; window.__iso.moments.forced = 'champ'; window.__iso.buses.on = true; });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/champ-tip.png` });
  // it turns with the map and is still in the lake
  await page.click('#rot-right');
  await page.waitForFunction(() => window.__iso.moments.champBox, null, { timeout: 4000 });
  assert.deepEqual(errors, []);
  await ctx.close();
});
