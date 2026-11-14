# Getting OpenStreetMap data from the cloud container

- Of the public Overpass servers only `maps.mail.ru/osm/tools/overpass` answers from the container
  (overpass-api.de resets the connection, the others are blocked). It is often overloaded: most requests come
  back `504` within a second, and about one in five gets through. Keep asking every few seconds for 10 to 20
  minutes; do not give up after a handful of tries. Ask for buildings in four quarters.
- Everything fetched is kept in `runs/labels-cache/` (not in git), shared by `pipeline/labels.py` and
  `pipeline/streetlife.py`, so a rerun needs no network.
- OpenStreetMap has almost no street lamps mapped here and few building heights. Lamps are placed along streets
  by street class; heights are guessed from the footprint (`building_height` in `pipeline/labels.py`).
- Heights in the pipeline's `enu()` are a flat approximation good for hiding tests only. Files for the viewer
  carry latitude, longitude and height, and the viewer converts them exactly (`llaToEnu`).
