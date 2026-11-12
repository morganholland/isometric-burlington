#!/usr/bin/env bash
# Build the static site into site/. TILE_BASE = public URL of the tile bucket.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf site && mkdir -p site
npx esbuild viewer/app.js --bundle --format=esm --minify --loader:.json=json --outfile=site/app.js
cp viewer/style.css viewer/transit.json viewer/labels.json viewer/how.html viewer/how.css site/ && cp node_modules/leaflet/dist/leaflet.css site/ && cp -r viewer/press site/
sed "s#__TILE_BASE__#${TILE_BASE:-}#" viewer/index.html > site/index.html
if [ -n "${TILE_BASE:-}" ]; then curl -sf "$TILE_BASE/manifest.json" -o site/manifest.json || echo "no manifest at $TILE_BASE yet"; fi
echo "built site/ (tiles: ${TILE_BASE:-none})"
