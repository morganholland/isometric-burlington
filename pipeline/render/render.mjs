// Drive the renderer page in headless Chromium.
// node pipeline/render/render.mjs --angle 0 --frames list.json --out renders/a0 [--size 2048]
// list.json: [[x,y],...] top-left map-pixel corners; each shot is size x size.
// Needs CESIUM_ION_TOKEN in the environment.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

export async function openRenderer({ token, gpu = process.env.RENDER_GPU === '1', errorTarget } = {}) {
  const args = gpu
    ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({ args: [...args, '--disable-web-security'] });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error' || process.env.DEBUG) console.error('[page]', m.text()); });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.route('http://render.local/**', route => {
    const p = new URL(route.request().url()).pathname;
    const file = p === '/' ? null : path.join(HERE, 'dist', path.basename(p));
    if (!file) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0"><script type="module" src="/page.js"></script>' });
    route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(file) });
  });
  await page.goto('http://render.local/');
  await page.waitForFunction(() => typeof window.setup === 'function');
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/grid.json')));
  delete cfg.angles; // the page only needs the camera constants
  await page.evaluate(([c, t, o]) => window.setup(c, t, o), [cfg, token, { errorTarget }]);
  return { browser, page };
}

export async function shot(page, args) {
  const r = await page.evaluate(a => window.renderShot(a), args);
  const dec = s => s ? Buffer.from(s.split(',')[1], 'base64') : null;
  return { rgb: dec(r.rgb), height: dec(r.height), settle: r.settle, attribution: r.attribution };
}

async function main() {
  const argv = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith('--') ? acc.concat([[v.slice(2), a[i + 1]]]) : acc), []));
  const token = process.env.CESIUM_ION_TOKEN;
  if (!token) throw new Error('CESIUM_ION_TOKEN is not set');
  const angle = Number(argv.angle ?? 0), size = Number(argv.size ?? 2048);
  const frames = JSON.parse(fs.readFileSync(argv.frames));
  const out = argv.out; fs.mkdirSync(out, { recursive: true });
  const { browser, page } = await openRenderer({ token, errorTarget: argv.errorTarget ? Number(argv.errorTarget) : undefined });
  for (const [x, y] of frames) {
    const name = `${x}_${y}`;
    if (fs.existsSync(path.join(out, `${name}.png`))) continue;
    const t = Date.now();
    const r = await shot(page, { angle, x, y, w: size, h: size });
    if (!r.settle.ok) { console.error(`incomplete ${name}`, r.settle.stats); continue; } // never keep a frame drawn on missing tiles
    fs.writeFileSync(path.join(out, `${name}.png`), r.rgb);
    fs.writeFileSync(path.join(out, `${name}.h.png`), r.height);
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ seconds: (Date.now() - t) / 1000, settle: r.settle, attribution: r.attribution }));
    console.log(`${name} ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  await browser.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
