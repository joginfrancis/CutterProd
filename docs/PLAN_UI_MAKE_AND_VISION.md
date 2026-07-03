# Plan: Vision modal single-page redesign + Make screen improvements

Date: 2026-07-03
Status: PLANNED (not yet implemented)

---

## Part 1 — Vision Capture modal: no-scroll, single-page, modern

### Problem
The modal stacks all content vertically (subtitle, QR, "or" divider, upload button,
crop canvas, status, paper-size controls, hint, CTA). With a portrait photo the crop
canvas is ~50vh tall, pushing the CTA button below the fold — the user must scroll
inside the modal to reach "Crop, Flatten & Add to Canvas".

### Root insight
The modal has **two mutually exclusive states** that are currently rendered together:

- **State A — Connect** (no photo yet): subtitle, QR code, upload button.
- **State B — Crop** (photo received/uploaded): crop canvas, status, paper size, hint, CTA.

They never need to coexist. Showing only the active state removes ~40% of the height.

### Changes

**index.html** (bump `script.js?v=29`, `styles.css?v=17`)
1. Wrap State A content in `<div id="visionStateConnect">` (subtitle + QR + upload row).
2. Wrap State B content in `<div id="visionStateCrop" class="hidden">` (crop area,
   status, controls, CTA).
3. State B layout — sticky footer bar:
   - `.vision-crop-area` becomes the flex-grow region (`flex:1; min-height:0`).
   - Bottom action bar `.vision-footer` pinned inside the modal (not scrolled):
     left = compact paper-size select (+ inline custom W×H when chosen),
     right = gradient CTA button. One row.
   - Status line merges into a small pill overlaid on the top-left of the crop
     canvas (e.g. "✓ Page auto-detected") instead of a paragraph below it.
   - Hint text moves into a low-opacity overlay at the bottom of the canvas
     (fades out after 4 s) — no layout height cost.

**styles.css**
4. `.vision-modal { display:flex; flex-direction:column; max-height:92vh; }`
   `.vision-body { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }`
   → the canvas absorbs all spare height; nothing scrolls.
5. `#visionCropCanvas` sized by its flex container (JS already handles resize via
   `_cropDrawRetries` loop — verify it reacts to container size, add a
   ResizeObserver if needed).
6. Modern touches: soft shadow + 16px radius already exist; add subtle
   backdrop blur on overlay, status pill styling, footer divider line.

**script.js**
7. On photo received (WebRTC) or file uploaded: hide `#visionStateConnect`,
   show `#visionStateCrop`, then run existing `showVisionPreview`.
8. On modal close/reopen (fresh connection): reset to State A.
9. Add small "← New photo" text-button in State B header area to return to
   State A without closing the modal.

### Acceptance
- Modal never shows an internal scrollbar at ≥ 720 px viewport height.
- CTA always visible while cropping.
- QR state also fits without scroll.

---

## Part 2 — Make (Run) screen improvements

Reference: `index.html` lines ~250–408 (`#runWorkspace`).

### Pass A — state clarity & guidance (high value)
1. **Status banner** at top of right sidebar: single dominant color-coded strip
   (red = Disconnected, amber = Idle/Not ready, green = Ready/Running).
   The Conn/Motors/File dots become detail rows under it.
2. **Start-button reason**: when `#btnStart` is disabled, show the blocking
   reason under it ("Connect the machine to enable", "Load a toolpath", etc.).
3. **Canvas empty state**: replace bare "No paths found" with icon +
   "No toolpath loaded" + button linking to Design/Prepare.

### Pass B — cosmetic polish
4. **DRO restyle**: dark instrument-style readout panel, larger monospace digits.
5. **Jog alignment**: vertically center Z/A columns against the D-pad; clearer
   active state on step pills.
6. **Legend chip**: move gantry/knife legend text off the bed into a corner chip.
7. **Terminal cleanup**: move inline styles into CSS classes.

### Order of implementation
1. Vision modal (Part 1) — most user-facing pain right now.
2. Make Pass A.
3. Make Pass B.

Each step: bump cache-busting versions, verify in preview, then offer commit
(no git actions without explicit approval).
