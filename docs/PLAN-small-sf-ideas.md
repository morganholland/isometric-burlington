# Plan: ideas borrowed from Small SF

## Status (2026-11-23)
- Asked for by Morgan after reading smallsf.com/about: "do all of it" (seven ideas).
- Reading the code showed the map already has live weather (NWS at BTV, with snow, rain and fog), live planes
  (ADS-B), GMT buses on the timetable, a "How it was made" page and a tip jar. The list below is what is new.
- Morgan said yes to every recommended answer (2026-11-23).
- Slice 1 (snow on the ground, fireworks, Champ, holiday lights): live on isoburlington.com since 2026-11-23 (PR #4).
- Slice 2 (About page: numbers, change log, drag-to-compare): live since 2026-11-23 (PR #5).
- Slice 3 (corrections): live since 2026-11-23 (PR #6); notes collect in the PostHog insight "Map corrections from visitors".
- Slice 4 (visitor lists): live since 2026-11-23 (PR #7).
- Slice 5 (the train): live since 2026-11-23 (PR #8).
- Slice 6 (tap a building): built and tested in PR #9; reworked after review so taps find the building seen, not the lot behind it.
- Slice 7 (live buses) waits on a free Swiftly key only Morgan can request: see `OWED.md`.
- Rules: spend nothing, free feeds only, never cap zoom, say plainly on the site what is simulated or timetabled.

Each slice is its own small pull request, merged when its tests are green and it has been checked in a browser.

## Slice 1: local moments and snow on the ground
1. When BTV reports snow lying on the ground (Open-Meteo `snow_depth`, free, no key), the drawing gets a light
   white wash; with none it has no wash. The Weather choice "Snow" shows it too.
2. Fireworks rise over the waterfront on the evening of July 3 and at New Year's Eve, by Burlington's clock.
3. Champ surfaces in the lake now and then; tapping it opens a short note that says it is a legend.
4. Church Street carries holiday lights at night from late November to New Year's Day.
5. A link can ask for a moment (`#...&m=fireworks`) so it can be seen and shared on any day.
6. Moments obey "reduce motion", cost nothing while off screen, and the About text says they are for fun.

## Slice 2: About page
7. A row of honest numbers (blocks drawn, area, cm per pixel, streets, lamps, bus routes), a change log whose
   entries link to the spot they are about, and a drag-to-compare picture of Google's model against the drawing.
   Tests: `tests/about.test.mjs` recomputes every number from the data and checks every change-log link lands
   inside the drawn map; `tests/viewer.test.mjs` drags the compare slider and follows a change-log link.
   The compare pair is render block a0/0_0 and the same pixels of the drawn tiles, cropped to 2560×1600 and scaled to 1600×1000.

## Slice 3: corrections
8. "Tell me what's wrong here" on the map (in the ? guide) and on the About page (link `./#fix`) opens a note
   card with a crosshair on the middle of the map. Sending records one PostHog event `correction_sent` with the
   note (at most 600 characters), the view (angle, x, y, zoom), latitude and longitude, and a link to the spot.
   No name or email. Morgan chose PostHog over email (question 7). Only the live domain sends; tests read
   `window.__isoEvents`. The analytics hash-stripping keeps this one event's `link`, since the person chose to
   send the spot; the guide's privacy line says so. Tests: `tests/fix.test.mjs`, `tests/track.test.mjs`,
   `tests/viewer.test.mjs` ("corrections").

## Slice 4: shareable place lists
9. A visitor picks places (the hand-picked ones or anything found by search), adds a title, a "by" line and
   notes, and gets a link. The list lives in the link: no accounts, no database.
10. Opening such a link shows the list as "a list by a visitor", clearly apart from the map's own places.
    Built as: ★ panel → "Make your own list" (title, optional by-line, spots added from under a crosshair, a
    note each, up to 20). `viewer/lists.js` packs it as base64url JSON in the link's `l` parameter, cut to
    fixed sizes, spots outside the drawn area dropped, anything malformed is no list at all (fast-check in
    `tests/lists.test.mjs`). Shown in its own card with numbered round pins, all text set as text, never markup.
    Analytics counts only how many spots (`list_opened`, `list_shared`), never the words.

## Slice 5: the train
11. Amtrak's Ethan Allen Express arrives at and leaves Union Station on its published timetable, labelled
    "timetable" like the buses. No ferry runs inside the drawn area (the Port Kent crossing is suspended).
    - 11a. `pipeline/amtrak.py` writes `viewer/amtrak.json` in the bus file's shape; the viewer joins the two.
      Amtrak's feed has no distances along the track, so stations are projected onto the track; heights come
      from the map's own street heights.
    - 11b. The train is a locomotive and five coaches following the curve of the track (tests/amtrak.test.mjs).
    - 11c. Between the 9:26 pm arrival and the 9:25 am departure it stands at Union Station, and its tip says
      when it leaves. Its tip names the train number and direction.
    - 11d. One "Buses and the Amtrak train" switch covers both.

## Slice 6: click a building
12. Tapping a building shows its address, year built and use where public records have them (City of
    Burlington assessor data; OpenStreetMap elsewhere). Never owners' names or values.
    - 12a. `api/building.js` asks VCGI's statewide parcels for the lot (address, town, category, outline) and, in
      Burlington, the city's assessor layer for year built and building type. Only whitelisted fields are
      requested or returned (property-tested). Answers are cached a week at the CDN; a source that is down
      answers 503 (or marks a half answer `partial`) and is cached a minute, never shown as "nothing there".
    - 12b. A tap hits the building you see: `viewer/buildings.json` (`pipeline/buildings.py`: 20,700 OpenStreetMap
      footprints with heights, about 380 KB gzipped, fetched on the first tap) is walked down the line of sight
      from the tap, and the first footprint tall enough to reach it wins (property-tested, and checked on the
      Hilton, Decker Towers and a New North End house from all four sides). With no building in the way the
      tap is on the ground. A point inside the building and, as a fallback when that point is on no numbered
      lot, the middle of its footprint are sent to the lookup, to 5 decimals.
    - 12c. Condominiums are named as the building ("1 Main St"), never one unit; unnumbered lots are nothing.
    - 12d. Only zoomed in (zoom -1.5 or closer), and never when the tap hit a bus, plane, Champ or a pin, or while
      the corrections or list cards are open. A double-click zooms and looks nothing up. A tap while the place
      note, layers panel or places list is open only closes it. The building's roof (or, on open ground, the lot)
      is outlined and turns with the map; focus moves to the card; Escape closes. On a phone the card hides a
      visitor list while it is open.
    - 12e. Analytics: `building_tapped` with found, town, whether a year was known and whether a building was
      hit; never the address.
    - South Burlington and Winooski have no year built in any free record reachable here; they show address and use.

## Slice 7: live buses
13. With a free Swiftly key for GMT's live feed (only Morgan can request it), buses move by GPS and the label
    says "live"; without it, or when the feed fails, the timetable buses stay.

## Not doing
- Redrawing with a paid image model, live boats (needs a key and an always-on connection our hosting lacks),
  a departures board.
