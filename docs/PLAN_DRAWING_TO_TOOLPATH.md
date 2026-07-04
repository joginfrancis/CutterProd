# Plan: Hand-drawing photo → color-grouped machine toolpath

Date: 2026-07-04
Status: IMPLEMENTED (v1) — `src/DrawingVectorizer.js` + Vision modal "Extract Drawing"
  flow. Verified end-to-end on a real drawing (blue cat + red rect + green cross):
  flatten → Lab ink separation → adaptive color clustering → per-color skeleton →
  RDP simplify + Catmull-Rom smoothing → color→operation mapping UI → method-tagged
  paths on the Design canvas, ready for Create Path.
  Also fixed a latent importSVG bug (`vb` out-of-scope) that broke all viewBox SVG imports.

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

### Stage 1 — Ink/substrate separation (substrate-agnostic)
**Constraint:** the substrate can be any size (A4/A3/custom — already user-selected in the
crop UI) AND any material/color: white paper, colored paper, cardboard, etc. So we CANNOT
assume "paper = white / bright". Ink is separated *relative to the estimated substrate color*,
not against white.

- **Estimate the substrate color** from the flattened page itself (drawing occupies the
  center; the substrate dominates by area and rings the border):
  - Sample a border frame (outer ~8% ring) + take the **statistical mode / median** of the
    whole page in Lab space → `bgLab`. Border sampling is robust because drawings rarely run
    to the paper edge; the mode is robust even if they do.
- **Ink mask** = pixels whose color distance from `bgLab` exceeds a threshold
  (**CIE Lab ΔE**, perceptually uniform — handles colored substrates far better than HSL-L).
  - Adaptive threshold: derive from the spread (std-dev) of background samples so a textured
    cardboard doesn't get over-segmented.
- Optional **white-balance normalize** using `bgLab` as the neutral reference to reduce hue
  cast from colored paper / warm lighting before color classification (Stage 2). Apply
  cautiously — skip if it distorts genuine ink hues.

### Stage 1b — Substrate/ink contrast guard
- If a drawing color is too close to the substrate (e.g. red marker on red paper), that color
  will have weak/empty separation. Detect low-contrast color classes and **warn the user**
  ("green strokes low contrast on this substrate") rather than emitting garbage paths.

### Stage 2 — Color segmentation (data-driven, arbitrary palette, unknown count)
**Constraint:** pens can be any of many colors — red, green, orange, blue, pink, yellow,
purple, brown, black … and only *some* are used in any given drawing. We must NOT assume a
fixed set or a fixed count. The number and identity of colors is discovered from the image.

- **Cluster the ink pixels in Lab space with an ADAPTIVE cluster count** — do not fix `k`:
  1. Over-cluster (k-means with a generous k, e.g. 8–12) OR build a Lab histogram of ink
     pixels and find peaks.
  2. **Agglomeratively merge** clusters whose centroids are within a perceptual threshold
     (**ΔE ≈ 10–15**) — near-identical shades collapse into one real pen color.
  3. **Drop tiny clusters** (below a min pixel-count / stroke-length) as noise/fringing.
  → Result: exactly the colors actually present, whether that's 2 or 8. Pink vs red vs
     orange stay separate because their centroids are > ΔE apart; two shades of the same blue
     marker merge.
- **Light/low-chroma inks (yellow, orange) are the hard case**: they sit close to a white
  substrate, so Stage-1 ΔE separation is weak → they may be under-detected on white paper.
  Mitigations: (a) lower the ink threshold adaptively for high-hue-chroma-but-low-lightness-
  delta pixels; (b) surface them via the Stage 1b low-contrast warning; (c) they separate
  cleanly on colored/dark substrate.
- **Display naming (cosmetic only):** snap each detected cluster centroid to the nearest name
  in a reference palette (red/orange/yellow/green/blue/pink/purple/brown/black/…) purely for
  the UI swatch label. Masking always uses the *measured* centroid color, never the snapped
  name — so an unusual teal or magenta still works, just labeled "nearest = blue/pink".
- Emit one binary mask **per discovered color cluster**.

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
- After extraction, show the color→operation mapping panel — a **dynamic list of only the
  colors actually detected** (each shown as a real-color swatch + its nearest-name label +
  stroke count), each with a dropdown to assign an operation (Cut / Crease / Draw / Off-base /
  Ignore). No fixed palette rows; the list length equals the number of discovered colors.
- Preview overlay tints each color's strokes by its assigned operation; **Add layers to canvas**.
- Reversible: user can re-run with different sensitivity (merge-ΔE / min-stroke thresholds)
  if two markers merged or a faint color was missed.

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
- **Substrate size**: A4/A3/custom is already user-selected in the crop UI and drives the mm
  scale of the flatten — no change needed for the vectorizer; it works in the flattened
  page's own pixel/mm space.
- **Substrate detection vs bed**: a colored sheet on a similar-colored bed can defeat
  auto corner-detection (GrabCut). The existing **manual 4-corner cropper is the fallback**;
  keep it prominent. Optionally calibrate the known bed color to improve auto-detect.
- **Ink==substrate color**: unavoidable physical limitation; handle via the Stage 1b
  low-contrast warning, not by trying to invent strokes that aren't separable.
