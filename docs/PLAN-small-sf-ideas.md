# Plan: ideas borrowed from Small SF

## Status (2026-11-23)
- Asked for by Morgan after reading smallsf.com/about: "do all of it" (seven ideas).
- Reading the code showed the map already has live weather (NWS at BTV, with snow, rain and fog), live planes
  (ADS-B), GMT buses on the timetable, a "How it was made" page and a tip jar. The list below is what is new.
- Morgan said yes to every recommended answer (2026-11-23).
- Slice 1 (snow on the ground, fireworks, Champ, holiday lights): live on isoburlington.com since 2026-11-23 (PR #4).
- Slice 2 (About page: numbers, change log, drag-to-compare): built and tested, PR #5.
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
8. "Tell me what's wrong here" on the map and on the About page sends a short note with the map position.
   Where it lands is Morgan's choice (question 7).

## Slice 4: shareable place lists
9. A visitor picks places (the hand-picked ones or anything found by search), adds a title, a "by" line and
   notes, and gets a link. The list lives in the link: no accounts, no database.
10. Opening such a link shows the list as "a list by a visitor", clearly apart from the map's own places.

## Slice 5: the train
11. Amtrak's Ethan Allen Express arrives at and leaves Union Station on its published timetable, labelled
    "timetable" like the buses. No ferry runs inside the drawn area (the Port Kent crossing is suspended).

## Slice 6: click a building
12. Tapping a building shows its address, year built and use where public records have them (City of
    Burlington assessor data; OpenStreetMap elsewhere). Never owners' names or values.

## Slice 7: live buses
13. With a free Swiftly key for GMT's live feed (only Morgan can request it), buses move by GPS and the label
    says "live"; without it, or when the feed fails, the timetable buses stay.

## Not doing
- Redrawing with a paid image model, live boats (needs a key and an always-on connection our hosting lacks),
  a departures board.
