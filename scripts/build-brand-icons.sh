#!/usr/bin/env bash
# Rasterises the Kerdial PWA icon set from the vendored SVG marks.
#
# The marks in web/public/brand/ are the design system's own *placeholder*
# artwork. Regenerating the PNGs from them is a one-command job so that
# swapping in real artwork stays a swap rather than a rework.
#
# Two variants per size, as the manifest declares:
#   - `any`      — the mark on its own rounded square.
#   - `maskable` — full-bleed brand ground with the bars inside the safe zone,
#                  so a launcher's circular or squircle mask cannot clip them.
#
# Usage: bash scripts/build-brand-icons.sh
set -euo pipefail
cd "$(dirname "$0")/.."

brand="web/public/brand"
icons="web/public/icons"
mkdir -p "$icons"

for size in 192 512; do
  inkscape "$brand/logo-mark.svg"      -w "$size" -h "$size" -o "$icons/icon-$size.png"
  inkscape "$brand/logo-maskable.svg"  -w "$size" -h "$size" -o "$icons/icon-$size-maskable.png"
done

# The tab icon. SVG is served first by every browser that matters; the 32px
# PNG is the fallback for those that do not take one.
inkscape "$brand/logo-mark.svg" -w 32 -h 32 -o "web/public/favicon.png"
cp "$brand/logo-mark.svg" "web/public/favicon.svg"

echo "brand icons rebuilt from $brand"
