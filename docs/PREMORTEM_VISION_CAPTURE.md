# Pre-mortem — Vision Capture (photo → toolpath)

*Framing: it's 6 months out. Vision Capture shipped and users are frustrated /
abandon it. Working backwards, here is everything that could have caused that —
across capture, algorithms, and UI/UX — with likelihood and mitigations.*

Legend — Likelihood: 🔴 high · 🟠 medium · 🟢 low. Each item: **failure → why → fix/possibilities.**
✅ = addressed (commit noted where fixed).

**Primary use case (user-confirmed):** pen line-drawings and handwritten text in
multiple colours, executed by **dragging a knife or a creasing wheel over the
lines**. Filled/printed content (the book-cover test) is out of scope. This makes
path geometry *mechanically* critical, not just visual — see section 0.

---

## 0. Machine context — knife drag & crease wheel (the paths get *cut*, not drawn)
- 🔴 **Open "closed" shapes leave an uncut tab / unfinished crease.** A circle whose
  skeleton has a tiny seam gap cuts 359° and the piece doesn't release. → ✅ *Loop
  snapping:* endpoints within ~a stroke-width are welded and emitted as one closed
  `Z` contour (`refinePaths` + `toPathD closed`), with a **Close loop shapes** toggle.
- 🔴 **Rounded corners where the drawing has sharp ones.** A crease wheel/knife
  following an over-smoothed corner produces a visibly wrong fold/cut; overshoot
  also digs into the piece. → ✅ **Corner sharpness** slider (0–100%): raises the
  straightness-weighting exponent in the Bézier fit so corners stay crisp; default 40%.
- 🟠 **Drag-knife swivel:** the blade trails its pivot, so very short segments and
  sharp direction reversals cut wrong until the blade realigns. → CAM-side: corner
  overcut/loop strategies; on the vision side keep corners as *single* sharp vertices
  (done) rather than point clusters.
- 🟠 **Path direction & continuity:** many tiny fragments = lots of lift/plunge
  cycles → slow jobs + entry marks. → Merge collinear/continuable fragments; order
  paths for travel; report fragment count in Review.
- 🟠 **Duplicate/parallel ghost paths cut twice** (weakens material, tears crease
  lines). → ✅ Stroke doubling fixed (morphological close) and fringe ghost outlines
  fixed (hue-first assignment + 5×5 majority vote). Watch for regressions on very
  thin pens.
- 🟢 **Crease vs cut tolerance differ:** a crease line can tolerate smoothing a cut
  can't. → Per-operation refine settings later (crease = smoother, cut = accurate).

---

## 1. Capture & input quality
- 🔴 **QR path ships a ~2 MP video frame** (no `ImageCapture` on iOS Safari / some Android) → thin ink, blur, poor detection. → Fallback to the native camera picker when `ImageCapture` is absent; label upload as the recommended path. (See `project_vision_capture_paths`.)
- 🟠 **Shadows / uneven lighting / glare** bias the substrate estimate and split one ink into several clusters. → Local (adaptive) background estimation instead of one global substrate; flat-field / illumination normalization before clustering; in-capture lighting guidance.
- 🟠 **Ruled / grid / faint printed lines** on the paper get picked up as an extra "colour" or noise. → Detect and subtract low-contrast periodic lines; raise ink threshold adaptively; let the user reject a detected colour.
- 🟢 **Phone JPEG over-compression** (blocky ink edges). → Prefer PNG/high-Q; cap only above a large edge.

## 2. Page detection & crop
- 🔴 **Auto-detect places a skewed/partial quad** and the user doesn't notice → clipped drawing. *(We already fixed "corner edit ignored"; the detector accuracy itself remains.)* → Show a confidence badge; snap-to-edge refinement; ML document segmentation; auto-expand quad to page bounds; warn when the quad touches the frame edge.
- 🟠 **Wrong page-size assumption** distorts aspect (square drawing stretched into A4). → Derive aspect from the detected quad; warn on large aspect mismatch; "match detected aspect" option.
- 🟢 **Corner handles hard to grab on mobile** (small hit target). → Larger touch targets, magnifier loupe (present), edge-drag not just corners.

## 3. Flatten / perspective
- 🟠 **Homography error at page edges** (lens distortion, non-planar/curled paper) → bowed lines. → Lens-undistort; mesh/TPS warp for curl; sub-pixel corner estimation.
- 🟢 **Resolution mismatch** between flatten DPI and skeleton raster changes stroke thickness unpredictably. → Normalize to a target stroke-width band before skeletonizing.

## 4. Colour detection & clustering  ← *green/teal merged lives here*
- 🔴 ✅ **Distinct inks merged into one** (observed: **green + teal → one colour**). → *Root cause:* hue-based merge with a fixed 32° tolerance; green (~150°) and teal (~172°) sit only ~22° apart, inside the window.
  **Fixed (this commit):**
  - Default tolerance lowered to **18°** and exposed as an Advanced **Colour separation** slider (8–60°): low = keep close hues apart, high = merge shades of one marker. Changing it re-clusters on release.
  - **Hue-first pixel assignment:** full-ΔE assignment handed a stroke's antialias fringe to the *neighbouring* ink (fringe shifts L/chroma toward paper, landing nearer teal), skeletonizing **ghost dashes/rings** in the wrong colour. Chromatic pixels now assign by hue distance (ΔE as tie-break; neutral pens still ΔE-matched with a chroma-mismatch penalty).
  - **5×5 spatial majority vote** reassigns any residual 1–2 px misassigned fringe band to the locally dominant ink — verified: no ghost outlines left on a green-circle + teal-zigzag + red-square test; exactly 3 colours.
  **Still open:**
  - **Split** action (we have Merge but no Split) and a "number of pen colours" override.
  - **Palette-first mode:** eyedrop each real pen once → nearest-declared-colour assignment (removes guesswork).
  - Separation/confidence score + "keep separate?" prompt for borderline centroid pairs.
  - Note: ΔE-only merge was tried and **rejected** — it splits an ink's core from its antialias fringe (they're far in ΔE, same hue); hue is the correct merge axis for pen strokes.
- 🟠 **Over-segmentation** on dim photos (one pen → many shades). → The current hue-merge helps; complement with spatial regularization.
- 🟠 **Substrate leak** (paper tint read as a pale pen). *(Mitigated with ΔE + low-chroma/high-L guard; still fragile on coloured card.)* → Per-region background; user "this is background" eyedropper (present).
- 🟠 **Speckle / salt-and-pepper** pixel assignment along edges → noisy masks. → Spatial smoothing / MRF on the label map; connected-component size filter before skeleton.

## 5. Vectorization / skeletonization
- 🔴 **Wrong transform for the content.** Centerline skeleton is right for single-stroke line art but wrong for **filled text/logos** → loops & spurs (seen on the printed book cover). → Offer an **Outline (contour) mode**; auto-pick centerline vs outline per region by stroke-width statistics.
- 🟠 **Thick-stroke doubling.** *(Fixed via morphological close.)* Residual risk: fixed close radius is wrong for fine detail (fills counters, welds letters). → **Distance-transform-adaptive** close radius (≈ fraction of measured stroke width); skip on thin strokes.
- 🟠 **Junction / crossing artifacts** (X and T intersections spawn spurious branches or gaps). → Junction-aware skeleton pruning; reconnect across small gaps; preserve crossings as separate strokes.
- 🟠 **Short-stroke loss.** Noise filter (`Ignore strokes shorter than`) also deletes real dots (i-dots, eyes). → Distinguish intentional dots from speckle by roundness/density, not length alone.
- 🟢 ✅ **Closed-loop handling** (circles skeletonize to a loop with a seam). → Fixed: endpoints within ~a stroke-width snap shut; the Bézier fit wraps tangents around the joint and emits `Z` (one continuous contour for the knife). "Close loop shapes" toggle in Advanced.

## 6. Path refinement / smoothing
- 🟠 ✅ **Corner overshoot / rounding** (serifs, sharp joins lost). → Corner-aware smoothing + new **Corner sharpness** slider (straightness exponent 1→5, default 40%). Still possible: per-colour/per-operation smoothing.
- 🟢 **Endpoint hooks / retraction** from thinning. *(Endpoint extension present.)* → Validate against ink mask (done); cap extension.

## 7. Operation assignment & CAM output
- 🟠 **Colour→operation mapping is manual and easy to get wrong** at scale (many colours). → Remember mapping per hex (present via `_lastOpForColor`); presets/profiles; visual legend on the canvas.
- 🟠 **Scale/registration error**: mm mapping depends on correct page size + crop; a wrong paper size silently produces a mis-scaled cut. → Show real-world dimensions of the result; require confirmation; fiducial/ruler option.
- 🟠 **Bezier → GCode linearization tolerance** mismatch (over-faceted or over-smoothed toolpath). → Surface the CAM tolerance; preview the linearized path.
- 🟢 **Hidden/ignored colours** semantics unclear (preview-hide vs exclude-from-output). → Make "hide in preview" and "Ignore operation" visually distinct (currently separate; keep them so).

## 8. UI / UX
- 🟠 **No manual touch-up** in Review — if vectorization is 90% right, the user can't fix the 10% and must redo. → In-review erase/join/add-stroke tools; delete a stray path.
- 🟠 **No Split / rename for colours** (only Merge). → Add Split; editable colour names; the perceptual name is sometimes wrong ("brown" for blue-ish).
- 🟠 **Silent failure / dead-ends** ("No distinct ink detected") without guidance. → Actionable empty states (adjust background, re-crop, lighting tips).
- 🟠 **Trust gap**: user can't tell what changed after a slider move. → Before/after diff; per-colour path counts; overlay opacity control.
- 🟢 **Reversibility**: no undo across phases; Back re-runs work. → Cache analysis by crop hash; undo stack in Review.
- 🟢 **Discoverability** of Advanced settings (now collapsed). → Fine for default; ensure the collapse is obvious.
- 🟢 **Multi-page / batch** not supported. → Queue several photos → one canvas.

## 9. Performance & robustness
- 🟠 **Heavy re-analysis on every crop tweak** could feel sluggish on large photos / low-end devices. → Debounced (present); downscale for the live colours preview, full-res only on Continue; Web Worker for skeletonization.
- 🟠 **Memory**: full-res flatten + per-colour masks on mobile Safari → crashes. → Cap working raster; free intermediates.
- 🟢 **Library dependency**: `TraceSkeleton` / OpenCV worker fails to load → whole feature dead. → Feature-detect + graceful fallback + clear error.

## 10. Scope / expectation mismatch
- 🔴 **Users feed content the pipeline isn't for** (dense printed text, photos, shaded fills) and judge it broken. → Set expectations in-product ("best for hand line-drawings"); detect content type and warn; offer outline mode for text/logos.

---

## Highest-leverage next actions (ranked, after this commit)
~~1. Green/teal fix~~ ✅ done — Colour separation slider (18° default), hue-first
assignment, majority-vote cleanup. (ΔE-merge idea tested and rejected; see §4.)
~~+ Corner sharpness & closed-loop controls~~ ✅ done (§0, §5, §6).
1. **Split** control + "number of pen colours" override (Merge exists; Split doesn't).
2. **Adaptive morphological close** (distance-transform) so the doubling fix can't blob fine handwriting.
3. **In-review touch-up** (erase / join / delete stray path) so near-misses are salvageable.
4. **QR capture full-res fallback** (native picker when `ImageCapture` missing).
5. **Fragment merging + path ordering** for knife continuity (fewer lift/plunge cycles).
6. **Scale confirmation** (show mm dimensions) before Add to Canvas.
7. **Per-operation refine profiles** (cut = accurate/crisp, crease = smoother).
