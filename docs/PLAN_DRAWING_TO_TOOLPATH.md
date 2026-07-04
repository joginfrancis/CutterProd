# Plan: Hand-drawing photo → color-grouped machine toolpath

Date: 2026-07-04
Status: PLANNED

## Goal
Photograph a hand drawing on the machine bed → flatten the A4 (DONE) → extract the
colored strokes → vectorize → skeletonize → simplify + smooth → build machine-drawable
paths, where **each ink color maps to a machine operation** (cut / crease / draw / off-base),
grouped into layers, then executed on the machine.

## What already exists (reuse, don't rebuild)
- **A4 flatten/deskew** — `addVisionToCanvas` in `script.js` (done).
- **TraceSkeleton** centerline tracer — `trace_skeleton.js`, already loaded globally.
- **Color→method classification + layered SVG emit** — in the archived UrumiCam bridge
  (`archive/UrumiController.js` / removed block). It did: HSL classify per stroke →
  `blue→thru_cut`, `red→off_base`, `green→crease`, `neutral→thru_cut` → skeleton trace →
  build `<path data-method=…>` layers. **This is ~70% of the algorithm.**
- **CanvasEditor** already supports `method` per shape (`thru_cut`/`crease`/`off_base`) with
  color-coded rendering, grouping, and **Create Path** → toolpath/GCode.
- **`skeletonize()`** in CanvasEditor (rasterize→trace→centerline polylines).

## Pipeline (new module: `src/DrawingVectorizer.js`)

Input: the flattened A4 raster (`ImageData`) + its mm dimensions.

### Stage 1 — Ink/paper separation
- Downscale-free on the flattened raster (use the higher-DPI flatten, see Prep).
- Per pixel: compute HSL. Paper = high L + low S → background. Ink = everything else.
- Produce an **ink mask** (binary).

### Stage 2 — Color segmentation
- For each ink pixel, classify hue into buckets: **red / green / blue / black(neutral)**
  (reuse `classifyHsl` from archive). Neighborhood ink-color sampling to fight anti-alias
  fringing (reuse `getNeighborhoodInkColor`).
- Emit one binary mask **per color class**.

### Stage 3 — Vectorization per color
- For each color mask → **skeletonize** (TraceSkeleton) → centerline polylines.
  (Centerline is right for pen strokes; filled regions would use contour instead — add later
  if needed via a fill-vs-stroke heuristic on stroke width.)

### Stage 4 — Simplify + smooth
- **RDP** (Ramer–Douglas–Peucker) simplification per polyline (reuse `simplifyTracePolyline`).
- **Smoothing**: Catmull-Rom → cubic Bézier fit, or Chaikin, to remove skeleton staircasing.
- Drop specks (polylines under a min length / min area).

### Stage 5 — Map color → operation + layer grouping
- **No baked-in color convention.** After segmentation, show the user the set of detected
  colors and let them **assign each color to an operation in the UI per job** (dropdown:
  Cut / Crease / Draw / Off-base / Ignore). Remember the last-used assignment as a
  convenience default, but never hard-code red=cut etc.
- Convert each polyline to a CanvasEditor shape tagged with the user-chosen `method`.
- **Group per operation** so the tree shows Cut / Crease / Draw layers.

### Stage 6 — Execute
- Existing **Create Path** consumes the method-tagged shapes → per-operation toolpaths →
  machine execution (cut / crease / draw ordering already handled downstream).

## UI
- New button in the Vision crop footer (or a post-flatten step): **"Extract Drawing"**.
- After extraction, show the color→operation mapping panel (chips per detected color +
  dropdown to reassign), a preview overlay, and **Add layers to canvas**.
- Reversible: user can re-run with different thresholds.

## Prep dependency (from prior discussion)
- Bump flatten to **~300 DPI** and raise the px cap; increase warp tessellation `N`.
  Higher-res flatten = cleaner masks = cleaner skeletons. Do this first.

## Phasing
1. **Prep**: 300 DPI flatten + finer tessellation. (small, enables the rest)
2. **Stage 1–3**: `DrawingVectorizer.js` — ink mask, color split, per-color skeleton →
   preview overlay (no canvas insert yet). Port archived logic.
3. **Stage 4**: simplify + smoothing pass; speck removal.
4. **Stage 5**: color→operation mapping UI + layer grouping; insert into CanvasEditor.
5. **Stage 6**: verify Create Path → toolpaths per operation end-to-end.

## Risks / decisions
- **Centerline vs outline**: pen lines → centerline (single cut/draw stroke). If the user
  draws a *filled* region meaning "cut out this shape", we'd want the contour. Start with
  centerline; add a stroke-width heuristic later.
- **Color robustness**: lighting/marker variance. HSL buckets + neighborhood sampling
  handle most; expose thresholds if needed.
- **Closed vs open paths**: crease/cut usually want closed loops; detect loop closure and
  snap endpoints within a tolerance.
