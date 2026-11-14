# Plan: cars, a real night, share and snapshot

## Status (2026-11-14)
Done and live on isoburlington.com. Ideas taken from Isometric Toronto (iso.sloptoronto.ca and
iso3d.sloptoronto.ca); Morgan picked these three. Nothing here costs money: OpenStreetMap data and browser code only.
Not covered by an automated test (checked by eye): giving way at side streets, headlights at night, the blinking
breakwater lights, and the phone share sheet (it needs a real phone).

## Requirements
Cars
1. Small cars drive the real streets once you are zoomed in far enough to see one (zoom >= -3.25).
2. There are more at rush hour and almost none at 3 am, by Burlington's clock (weekdays and weekends differ).
3. A car keeps to its lane, never overlaps the car ahead, stops at a red light and gives way at a side street.
4. A car behind a building in the current view is not drawn on the roof.
5. "Cars (simulated)" in the layers panel switches them off; they start off for people who ask for reduced motion.
6. The About panel says plainly that the cars are simulated, not tracked.

Night
7. After dark street lamps and their pools of light show along the streets, windows are lit, BTV's runway and
   taxiway lights show, and the breakwater lights blink.
8. Fewer windows are lit in the small hours than in the evening. "Always night" shows an evening.
9. Nothing glows by day, and the night data is only downloaded once it is dark.
10. Cars have headlights and tail lights at night.

Share and snapshot
11. Share copies a link to exactly this view (the phone's share sheet on a phone). A forced day or night travels
    with the link.
12. Snapshot saves a picture of the map as it looks now, without the buttons, with a small isoburlington.com caption.
13. An old link (no time of day) and a mangled link still open somewhere sensible.

## Where things live
- `pipeline/streetlife.py` -> `viewer/streets.json`, `viewer/lights.json` (rerun after `pipeline/labels.py` changes heights).
- `viewer/traffic.js` (simulation + drawing), `viewer/lights.js`, `viewer/share.js`; wired up in `viewer/app.js`.
- `vercel.json` serves the tiles a second time under `/tiles/` on our own address: the tile bucket sends no CORS
  headers, and a canvas holding another site's image cannot be saved as a picture.
- Tests: `tests/traffic.test.mjs` (1-3, 4, 8, 11, 13), `tests/viewer.test.mjs` (1, 5, 7, 9, 11, 12).

## Not done / honest limits
- Cars do not see buses or each other across a junction; they can pass through one another there.
- Lamps and windows are placed to suit each street and building, not surveyed. Building heights are guessed
  where OpenStreetMap has none, so some windows float or sink.
- Bridges and I-89 overpasses sit at ground height.
