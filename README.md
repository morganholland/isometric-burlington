# Isometric Burlington

Burlington, South Burlington and Winooski, Vermont, drawn as an isometric city map you can turn,
with the real sunset and live weather. Method from Isometric Toronto (iso.sloptoronto.ca/how) and
Tiny London; imagery Google Photorealistic 3D Tiles via Cesium ion; drawn with Qwen-Image-2.1-Turbo.

## Pipeline
1. `pipeline/geo.py` – camera grid: one ENU frame at Church St, ortho camera 30° down, 0.23 m/px,
   headings 90/180/270/0 (angle 0 looks east, lake at the bottom). 458 blocks of 4096 px over 4 angles.
2. `pipeline/render/` – headless Chromium + three.js + 3d-tiles-renderer renders pixel-registered
   colour + height frames. A frame is dropped if any tile failed to load.
3. Teacher set (GPT Image) with automatic checks → ~400 pairs.
4. LoRA on Qwen-Image-2.1-Turbo (edit mode) with ostris' turbo training adapter, one H100.
5. Joint sampling per angle with pinned blocks on rented H100s (Vast.ai, prepaid cap).
6. `pipeline/tiles.py` – WebP pyramid (absolute tile indices) → R2 bucket `iso-burlington`.
7. `viewer/` – Leaflet CRS.Simple viewer, 4-angle rotate, search, night + NWS weather.

## Tests
`npm test` – grid/renderer/viewer registration + desktop and phone browser checks.

Licences: Google 3D Tiles and Qwen-Image-2.1 (research licence) – non-commercial hobby project.
