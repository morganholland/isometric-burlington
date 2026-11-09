// The renderer camera, the Python grid and the viewer must agree to a fraction of a pixel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { openRenderer } from '../pipeline/render/render.mjs';
import { llaToEnu, enuToPx, pxToEnu, enuToLla, GRID } from '../viewer/geo.js';
import fs from 'node:fs';

const PLACES = [
  ['Church St', 44.4759, -73.2121, 30],
  ['ECHO', 44.4741, -73.2203, 30],
  ['UVM Davis Center', 44.4690, -73.1960, 110],
  ['Winooski roundabout', 44.4914, -73.1857, 60],
  ['BTV terminal', 44.4716, -73.1533, 100],
  ['Red Rocks Park', 44.4428, -73.2245, 40],
];

test('python grid constants match viewer constants', () => {
  const g = JSON.parse(fs.readFileSync('data/grid.json'));
  assert.deepEqual(g.headings, GRID.headings);
  assert.equal(g.pixel_m, GRID.pixelM);
  assert.equal(g.elev_deg, GRID.elevDeg);
  assert.deepEqual(g.origin, GRID.origin);
});

test('python enu_to_px == viewer enuToPx', () => {
  const py = PLACES.map(([, lat, lon, h]) => [lat, lon, h]);
  const out = JSON.parse(execFileSync('python3', ['-W', 'ignore', '-c', `
import json,sys; sys.path.insert(0,'pipeline'); import geo
pts=json.loads(sys.argv[1]); res=[]
for a in range(4):
  for lat,lon,h in pts:
    e,n,u=geo.lla_to_enu(lat,lon,h); res.append(list(geo.enu_to_px(a,float(e),float(n),float(u))))
print(json.dumps(res))`, JSON.stringify(py)]).toString());
  let i = 0;
  for (let a = 0; a < 4; a++) for (const [, lat, lon, h] of PLACES) {
    const [e, n, u] = llaToEnu(lat, lon, h);
    const [x, y] = enuToPx(a, e, n, u);
    assert.ok(Math.abs(x - out[i][0]) < 0.01 && Math.abs(y - out[i][1]) < 0.01, `angle ${a}: ${x},${y} vs ${out[i]}`);
    i++;
  }
});

test('inverse transforms round-trip', () => {
  for (let a = 0; a < 4; a++) for (const [, lat, lon, h] of PLACES) {
    const [e, n, u] = llaToEnu(lat, lon, h);
    const [x, y] = enuToPx(a, e, n, u);
    const [e2, n2] = pxToEnu(a, x, y, u);
    assert.ok(Math.hypot(e - e2, n - n2) < 1e-6);
    const [lat2, lon2] = enuToLla(e, n, u);
    assert.ok(Math.abs(lat - lat2) < 1e-8 && Math.abs(lon - lon2) < 1e-8);
  }
});

test('renderer camera projects ENU points to the same map pixels', async () => {
  const { browser, page } = await openRenderer({ token: 'none', warmup: false });
  try {
    for (let a = 0; a < 4; a++) for (const [, lat, lon, h] of PLACES) {
      const [e, n, u] = llaToEnu(lat, lon, h);
      const [x, y] = enuToPx(a, e, n, u);
      // a 2048 shot whose corner is 300.0,700.0 px up-left of the point
      const fx = Math.floor(x) - 300, fy = Math.floor(y) - 700;
      const [rx, ry] = await page.evaluate(args => window.projectEnu(...args), [a, fx, fy, 2048, 2048, e, n, u]);
      assert.ok(Math.abs(rx - x) < 0.05 && Math.abs(ry - y) < 0.05, `angle ${a}: renderer ${rx},${ry} vs grid ${x},${y}`);
    }
  } finally { await browser.close(); }
});
