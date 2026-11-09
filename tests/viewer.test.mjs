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
  page.on('console', m => { if (m.type() === 'error' && !/api\.weather\.gov|nominatim|manifest/.test(m.text())) errors.push(m.text()); });
  await page.goto(URL0);
  await page.waitForFunction(() => window.__iso);
  return { ctx, page, errors };
}

test('desktop: loads, turns, zooms, sets time and weather', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1400, height: 880 } });
  assert.equal(await page.isVisible('#layers'), false, 'layers panel starts closed');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-start.png` });
  // outline of the coming map is shown while no tiles exist
  assert.equal(await page.isVisible('#drawing'), true);
  assert.ok(await page.locator('path.leaflet-interactive, .leaflet-overlay-pane path').count() >= 1);
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
  for (const sel of ['#q', '#rot-right', '#zoom-in', '#layers-btn']) {
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
