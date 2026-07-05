# Plan: vectorization controls + endpoint fix

Date: 2026-07-04
Status: PLANNED

## A. Endpoint artifact fix (do regardless of the UI scope)
Symptoms: vectorized strokes end ~½ stroke-width short of the ink, and curl/hook at tips.
Cause: medial-axis retraction at rounded caps + skeleton end-spurs + end-tangent skew.

Fixes (in DrawingVectorizer, per polyline):
1. **Extend endpoints** — for each open end, extrapolate along the end tangent until it
   reaches the ink-mask boundary (recovers the lost half-stroke-width). Cap the extension
   at ~1× stroke width so it can't overshoot.
2. **Prune end-spurs** — drop skeleton branches shorter than ~1× stroke width that dangle
   off a longer path (removes the little hooks).
3. **End tangent** — stop duplicating p3=p2 in the smoother; mirror the penultimate segment
   so the final curve doesn't bend.

## B. Controls (proposed wizard — build the high-value subset first)
When a photo is uploaded, guide through:
1. **Background approve** (LOW value; substrate estimate is reliable) — show the detected
   paper colour as a chip, "looks right?" with an eyedropper override. Optional.
2. **Pen colours approve / merge** (MEDIUM) — the existing hex list; add per-row approve and
   the merge (already built). Add an eyedropper to pick a missed colour.
3. **Accurate ↔ Smooth** (HIGH) — single slider driving RDP epsilon + smoothing strength.
   Accurate = follow the skeleton closely (more points, less rounding); Smooth = fewer
   points, gentle curves. Live re-vectorize on change.
4. **Curve simplification** (HIGH) — either folded into the same slider, or a second slider
   for max deviation tolerance (mm). Keep to ONE slider if possible to avoid over-choice.
5. **Preview with normalized image behind** (HIGH) — render the candidate vectors over the
   faint flattened photo inside the crop canvas, live, before Insert to Canvas.

### Recommended phasing
- **Phase 1 (lean, recommended):** A (endpoint fix) + step 3/4 as ONE "Accuracy" slider +
  step 5 live preview, added to the existing light colour panel. ~80% of the value.
- **Phase 2:** step 2 approve + eyedropper for missed colours.
- **Phase 3:** step 1 background approve/override.

### Parameters exposed by the slider (accuracy 0..1)
- RDP epsilon: lerp(high‑detail 0.6px → coarse 4px) inversely with accuracy.
- smoothing strength (tension/handle cap): more accurate → shorter handles (less rounding).
- speck length threshold, endpoint-extension amount: fixed.

## Open decision
How much UI to build now: (1) lean slider+preview+endpoint fix, (2) full 5-step wizard,
or (3) endpoint fix only. See chat.
