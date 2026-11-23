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

## Things that move in world units (fireworks, Champ, holiday lights)
- **Leaflet rounds screen points to whole pixels.** Working out the screen size of one metre from two points a
  metre apart gives 0 or 1. Measure each axis over a kilometre and divide (`basis()` in `viewer/moments.js`).
- **Real sizes vanish when zoomed out.** A 60 m firework burst is a few pixels at the opening zoom. Draw such
  things at a minimum screen size around their centre, and say in the code that it is deliberate.
- **Height pushes things over the land.** In this 30-degree view a point 200 m up is drawn well above the shore,
  so fireworks launched on the lake burst over Battery Park. That is correct for the camera, not a bug.
- **A canvas change applies after both feeds answer if they share one `await`.** Apply each weather feed as it
  arrives, or a slow NWS answer holds up the snow.
- **CSS transitions make computed opacity lag.** A test reading an element's opacity right after a change sees
  the start of the fade; wait for the value.
- **A layer near the bottom of the screen can sit under the first-visit hint card.** Tests that click on the
  map should dismiss the hint and pan the target to the middle first.

## Testing with the real drawing
- Building with `TILE_BASE=https://pub-9c551c98dab048f484c2c7e896e92cc0.r2.dev ./build_site.sh` puts the real
  tiles in local screenshots, which is the only way to judge how an overlay looks. Two existing tests (cars at
  rush hour, snapshot) fail in that mode on main too; CI builds without tiles, so run the suite that way.
- Open-Meteo's free API is limited per address per day and the cloud container's address is often over it.
  Tests answer for it with `page.route`.

## The About page's before-and-after picture
- The raw Google renders are public on the tile bucket at `renders/a<angle>/<bx>_<by>.png` (4096 px blocks),
  and level-0 tiles `map-v1/a<angle>/0/<tx>/<ty>.webp` are 512 px, so tile (bx/512 + i, by/512 + j) is the same
  pixels drawn. A pair lines up exactly with no warping: crop both the same, scale both the same.
- An invisible `<input type=range>` stretched over a picture is not a touch slider: iOS only moves a range by
  its thumb, and Chrome snaps the value to wherever a finger lands, so scrolling past moves the cut. Keep the
  range for keyboard and screen readers (`pointer-events:none`), drive dragging with Pointer Events on the frame,
  `touch-action: pan-y`, and start a touch drag only once sideways movement wins.
- Real touch in a Playwright test: `ctx.newCDPSession(page)` and `Input.dispatchTouchEvent` start/move/end in
  an iPhone device context; this produces both pointer events and native page scrolling.
- Test the cut by what is drawn (computed `clip-path`, knob position), not the CSS variable the script writes.
- Numbers on a page drift from the data: test them by recomputing from the same files the map uses.

## Turning a map pixel back into a place
- A map pixel is a ray, not a point: at 30° down, guessing the ground 40 m too low puts the spot ~70 m off
  (u·cot 30°). Use the one shared `GROUND_U` from `viewer/geo.js` everywhere a pixel becomes lat/lon (turning,
  search pins, corrections), and test against a known place at that height, not a round trip at u = 0.
- Analytics strips the map position from every URL; an event that is *about* a place (a correction) has to be
  let through on purpose (`stripHash` keeps only that event's `link`). `window.__isoEvents` records props before
  PostHog's `before_send`, so only the unit test in `tests/track.test.mjs` covers the stripping.
- Cards that float over the map should be one at a time; Escape order breaks as soon as two are open.
- On phones don't focus a text box when a card opens if the person first has to move the map: the keyboard
  comes up and covers it. Text boxes need 16px text or iOS zooms the page on focus.

## Links that carry data (visitor lists, 2026-11-23)
- Global keyboard shortcuts must skip every text-taking element, not just `input[type=text]`: an `<input>` with no type attribute slipped past and typing "r" turned the map. Test typing with `keyboard.type`, never `page.fill` (fill sends no keydown events).
- A link meant to show a set of things should not also carry a view (`x/y/z`); otherwise it opens wherever its maker was looking. Boot fits to the things only when the link names no view.
- When fitting the map around pins, pad on the side the card covers. Decide "phone sheet vs side column" with the same `matchMedia` width the CSS uses; guessing from the card's measured width failed because the phone sheet stops short of the controls column.
- Cap the encoded length of anything stored in a link (~8 KB) and say so when a link fails to decode: chat apps and texts truncate long links silently.

## The Amtrak train (2026-11-23)
- Amtrak's GTFS has no `shape_dist_traveled`: measure the shape yourself and project each station onto it.
  The shape is sparse (27 points inside the map) but its points sit on the curves, so it follows the track well.
- Amtrak's shape has a 2 km straight chord past Red Rocks that put the train 40-65 px off the drawn rails.
  Overpass (OSM) is blocked from the container, but the US DOT "North American Rail Network Lines" ArcGIS
  service is reachable: filter to Amtrak trackage rights, sample the shape every 10 m and snap it on.
  That data stops ~200 m short of Union Station's platform; Amtrak's own shape covers the last stretch.
- The map's street heights in `viewer/labels.json` are the same ellipsoid heights the bus shapes use, but
  take one only when the street is within ~40 m and interpolate between: the nearest street can be 300 m away.
- Park an overnight train where and how the morning train starts (on the departing shape, facing out), or it
  jumps and swaps ends at departure time.
- A train at the very start of its track would hang its coaches off the end: move the whole consist up the
  track until it fits, which also leaves it standing at the platform.
- Constant speed between stations puts the evening train on the map only from about 9:14 pm (Ferrisburgh is
  well south of the drawn area); tests pick times from that, not from the station times alone.

## Tapping a building (2026-11-23)
- A tap on a drawn roof is not over the building's lot: the lot under the tap's ground point is
  1.73 × (height) metres behind. Guessing a few fixed roof heights and taking the first lot that answers fails
  downtown, where lots touch: the Hilton's roof gave the parking garage behind it. What works is real footprints
  with heights, walked down the line of sight from the top, first footprint tall enough wins
  (`viewer/buildings.js` `hitBuilding`). Test it on known tall buildings from all four sides, not just on
  "the points fall under the pixel".
- Overpass is unreachable from the cloud VM, but the same OpenStreetMap buildings (with `height` and
  `building_levels`) are on ArcGIS Online as "OpenStreetMap Buildings for North America" (services6, owner
  smoore_osm), paged 2,000 at a time. Footprints delta-encoded in half-metres are 1.1 MB raw, 380 KB gzipped:
  fine to fetch on the first tap, not on page load. Official heights (VCGI HEIGHTFT, FEMA USA Structures) are
  mostly empty here.
- VCGI parcels stack one identical polygon per condo unit, so `features[0]` is one arbitrary person's unit:
  strip the unit and name the building.
- `.catch(() => null)` on each upstream turned an ArcGIS outage into "nothing here" cached for a week. Let a
  source failure throw its own error type and give it a one-minute cache.
- Leaflet fires `click` for each half of a double-click: delay the tap action ~300 ms and cancel it on
  `dblclick`/`zoomstart`. A tap that closes an open panel should only close it.
- A function keyed by exact coordinates can be called with endless near-duplicates that miss the CDN cache;
  refuse more than 5 decimals so the client's rounding is the only form.
