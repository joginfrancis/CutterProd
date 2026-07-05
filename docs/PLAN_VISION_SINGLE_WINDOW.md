# Plan: Vision capture as ONE window, 3 navigable pages

Date: 2026-07-05
Status: PLANNED

## Goal
One window (the existing Vision modal). Inside it, **3 pages** the user can move
between (back/forward) — a stepper/tab header, NOT separate popups. Each page can
**zoom / pan** its result. Insert happens on page 3.

```
[ 1 · Connect ] — [ 2 · Detect ] — [ 3 · Vectorize ]      (header stepper, click to go back)
```
Page 1 morphs → page 2 → page 3; a Back arrow returns. Forward only after the prior
page has produced what the next needs (photo → detection → vectors).

---

## Page 1 — Connect
- QR code (phone capture) **and** "Upload image from PC" — as today (State A).
- On photo received/uploaded → auto-advance to Page 2.
- Content: QR, upload button, status. (No canvas/zoom needed here.)

## Page 2 — Detect (crop + detection details)
- **Crop**: the 4-corner cropper on the photo (zoom / drag-pan / corner loupe) — as today.
- Paper size select (A4/A3/custom).
- **Detection details panel** (right side or below the crop):
  - **Background colour** — detected substrate swatch + hex (editable / eyedropper).
  - **Pen colours** — list of detected inks: swatch · hex · name · stroke count.
    - **Verify / merge** — a "merge ↑" on look-alike colours (stroke-weighted fuse);
      user can also drop a colour (ignore).
  - Runs the detect stage when the user lands here (or on "Detect").
- Zoom/pan applies to the crop canvas.
- **Next → Vectorize** (enabled once ≥1 pen colour is confirmed).

## Page 3 — Vectorize (validate + tune + insert)
- **Live preview canvas**: normalized/flattened page faint in back, coloured vector
  paths on top. Full **zoom / pan**.
- **Per-colour operation**: each detected colour → dropdown Cut / Crease / Draw /
  Off-base / Ignore (colour list carried from page 2).
- **Sliders (live)**:
  - **Detail** — Accurate ⟷ Smooth (RDP epsilon + smoothing tension/handle-cap).
  - **Simplify** — Fine ⟷ Coarse (speck drop / point decimation).
  - (optional) **Extend ends** toggle — push skeleton tips to the ink boundary so
    lines don't come up short.
- As slider values change → **live preview re-renders** (light stage only, instant).
- **Insert to Canvas** button (page 3 only) → places bézier `path` layers + aligned
  faint reference image, closes modal.

---

## Shared: zoom / pan on every page
- One reusable **view controller** (zoom via scroll, pan via drag) shared by the page-2
  crop canvas and the page-3 preview canvas. Page 1 has no canvas.
- Reuse the existing crop view transform (`cropView` z/ox/oy) generalised into a small
  helper so both canvases use identical zoom/pan behaviour.

## Performance model (keeps page 3 sliders instant)
- **Heavy stage** (mask → cluster → skeleton): runs when entering Page 3 the first time,
  or after a Page-2 change (background edit / colour merge). ~0.3–1s, show spinner.
- **Light stage** (RDP + smooth + endpoint-extend): runs on every slider move, instant,
  off the cached skeleton polylines.
- `analyzeDrawing()` refactor: return **raw per-colour skeleton polylines**;
  new `refinePaths(raw, {detail, simplify, extendEnds})` drives preview + final SVG.

## Why line ends bend / are short (fixed here)
1. Skeleton erodes ~½ stroke width from tips → **Extend ends** pushes them back out.
2. RDP/smoothing rounds tips → **pin first/last points**, don't smooth end tangents.
3. Junction bend (T/cross) is real topology → optional split-at-junction later.

---

## Implementation steps
1. **Modal shell**: add the 3-page stepper header inside the Vision modal; page container
   with show/hide + Back/Next; state = { page, photo, detection, refineParams }.
2. **Page 1**: move current QR + upload into page 1; on photo → go to page 2.
3. **View helper**: extract zoom/pan from `cropView` into a reusable controller; attach to
   page-2 crop canvas and page-3 preview canvas.
4. **Page 2**: crop canvas + paper select + detection panel (background + pen colours +
   merge/verify). Wire detect stage; store detection in state.
5. **DrawingVectorizer refactor**: `analyzeDrawing` → raw skeletons; add `refinePaths`
   (+ endpoint extension); `buildSVG` consumes refined paths.
6. **Page 3**: preview canvas (image + vectors), per-colour op dropdowns, Detail/Simplify
   sliders (+ Extend ends), live re-render, **Insert to Canvas**.
7. Verify on the cat+grid photo: pan/zoom on pages 2 & 3, sliders live, ends reach tips,
   sharp corners, insert aligns with reference.

## Acceptance
- Single window; 3 pages with Back/Next; never a second popup.
- Zoom + pan work on pages 2 and 3.
- Page 2 shows background + pen colours with verify/merge.
- Page 3 sliders update the preview live; Insert to Canvas is the final action.
- Default (no slider changes) still gives a good one-pass result.
