# Drawing on top of the map

- **Each view looks straight down a compass direction** (headings 90/180/270/0, 30 degrees down), and Burlington's
  streets run close to the compass. So a wall either faces the camera flat-on or is edge-on: a lit window can be
  a plain upright rectangle, and a car on a street is seen from the side or from above its nose or tail.
- **The projection is linear.** screen = origin + scale * (E*e + N*n + U*u), with E, N, U from `enuToPx` of the
  unit vectors. Work those out once a frame instead of calling Leaflet per point.
- **`inRegion` is expensive** (the drawn region's outline has ~800 corners). Ask once per static point and keep
  the answer (see `Points.inRegion` in `viewer/lights.js`). Asking for 12,000 windows a frame cost 10 ms.
- **Stacking.** Leaflet's map pane is one stacking context at z-index 400. A canvas that must sit under the street
  names goes in its own pane inside the map (tint 250, glow 300, ink 450) and is pinned to the screen in `pin()`.
  Canvases fixed at z-index 401 (cars, buses, planes) sit above every pane, names included.
- **Match the drawing's cars.** Plain boxes looked wrong next to the painted cars. A rounded outline, a dark ink
  line and a darker cabin made the moving cars read as part of the drawing.
- **Hide what is behind a building.** The pipeline works out, per street piece and view, the stretches a building
  stands in front of; check the car's nose and tail, not its middle, or half a van shows on a roof.
- **A canvas with another site's image cannot be saved.** The tile bucket sends no CORS headers, so the snapshot
  fetches tiles again through `/tiles/` on our own address (a Vercel rewrite). The local test server has no such
  path: there a snapshot has no drawing in it, only the layers.
- **Sorted points stored as differences compress to half the size** (lights.json: 756 KB -> 367 KB gzipped).

## Tests
- Playwright's `page.clock.setFixedTime` stops `Date`, and Leaflet's `flyTo` never finishes with a stopped clock.
  Jump with `map.stop(); map.setView(..., { animate: false })` in such a test.
- Simulated things take the hour from `offsetMs` (cars and buses), so a test can pick rush hour or 3 am.
- A seeded random source in the test (see `tests/traffic.test.mjs`) found two real spacing bugs in the cars that
  hand-picked cases would not have.
- The local environment needs `ln -s /opt/node-tools/node_modules/playwright node_modules/playwright` and
  `pip install shapely pyproj` before `npm test`.
