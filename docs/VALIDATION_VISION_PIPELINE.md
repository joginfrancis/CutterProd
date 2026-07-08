# Vision Pipeline — Design Validation Report

*Senior-review validation of the current photo→SVG pipeline against proposed
improvements. Scope ends at producing a high-quality, editable, browser-friendly
SVG from a photographed hand-drawn sketch. CAD/graph/G-code/CAM are explicitly
out of scope for this review.*

Measurements below are **real**, captured from the shipping build (`DrawingVectorizer.js?v=21`,
`script.js` at the time of review) on **Desktop Chrome** via temporary in-pipeline
instrumentation (since removed). Device rows for Pixel 7a / Safari / Firefox / Edge
are **extrapolated estimates, not measured** — flagged as such.

---

## Current pipeline (as built)

```
flattenCroppedPage()     homography flatten to paper-DPI canvas
  → estimateSubstrate()  border-ring median → paper colour
  → analyzeSkeletons()   downscale to MAX_EDGE=1400 working raster
       · Lab conversion, k-means++ (K=6) + hue-merge clustering
       · hue-first pixel assignment + 5×5 spatial majority vote
       · per colour: adaptive morphological close (distance-transform sized)
       · per colour: TraceSkeleton ×2  (centerline AND outline ring)
  → refinePaths()        per colour: RDP simplify → bridge gaps (greedy) →
                         close-loop snap / endpoint-extend → Catmull-Rom→cubic
  → buildSVG()           one <path> per colour, ink-coloured, data-op tagged
```

Key constant: **the working raster is capped at 1400px**, so pipeline cost is
**independent of input photo resolution** (confirmed by measurement).

---

## Phase 1 — Baseline (measured, Desktop Chrome, A4 → 990×1400 raster)

| Case | Colours | analyze ms | refine ms | total ms | Paths | SVG nodes | SVG KB |
|---|---|---|---|---|---|---|---|
| Geometric (thin, 3 shapes) | 3 | 1481 | 84 | **1869** | 5 | 33 | 1.6 |
| Children's (marker faces+shapes) | 4 | 1855 | 2 | **1963** | 13 | 130 | 5.0 |
| Thick marker (wide strokes) | 2 | 1428 | 6 | **1529** | 5 | 26 | 1.1 |
| Fine handwriting (thin, many) | 1 | 888 | 3 | **1023** | 6 | 121 | 3.4 |
| **Freehand dense scribble** | 2 | 2572 | **7686** | **10434** | 1367 | 8736 | 303 |

Scalability vs input size (same geometric content):

| Input px | flatten ms | analyze ms | total ms |
|---|---|---|---|
| 600×800 | 9.6 | 1165 | 1269 |
| 1200×1600 | 9 | 1481 | 1869 |
| 2400×3200 | 6 | 939 | 1087 |

`flatten` is always ~6–10 ms. JS heap fluctuated 70–130 MB (GC noise; transient
working set is masks + a 16 MB Lab Float32Array + per-colour distance transform).

### Baseline findings (evidence-based)
1. **Cost is resolution-invariant** — the 1400px cap means a 12 MP phone photo costs
   the same as a 0.5 MP one. Good architectural property; no scaling risk from image size.
2. **`analyzeSkeletons` dominates typical latency (0.9–2.0 s)** and scales with
   **colour count and ink area**, not pixels. Each colour runs an adaptive close +
   **two** TraceSkeleton passes.
3. **`refinePaths` is normally trivial (<10 ms)** — BUT explodes to **7.7 s on the
   dense case (1367 paths)**. Root cause: `bridgePolylines` is **O(n²)** over segments.
   This is the single worst measured performance cliff, and it also **freezes the live
   sliders** (each drag calls `recompute`) on dense drawings.
4. **Node counts and SVG size are excellent for real drawings** (5–130 nodes, 1–5 KB) —
   already highly editable and browser-friendly. The 8736-node / 303 KB result only
   appears for a pathological random scribble no human would draw.
5. **Bridging can over-merge**: 60 separately-drawn handwriting strokes collapsed to
   6 paths (bridge joined adjacent letters). Correctness risk on text.
6. **Wasted work**: `_buildColorGeom` computes the **outline** geometry for every colour
   even when Skeletonize is ON (the default), where only the centerline is used. Roughly
   **half the per-colour trace cost is discarded by default**.
7. Topology/continuity on line art is good (adaptive close killed stroke doubling; bridge
   reconnects crossings), but **junction/crossing stubs remain** — an X-crossing leaves
   ~2 short dangling sub-paths; only the min-noise slider trims them.

**Baseline verdict:** For its actual target (hand-drawn sketches, a handful of colours),
the pipeline already produces clean, low-node, editable SVGs in 1–2 s. The real weaknesses
are (a) a dense-input O(n²) performance cliff, (b) ~half-wasted analyze work, (c) minor
junction spurs, and (d) an interpolation-based curve fit that emits one cubic per point.

---

## Phase 2 — Each proposed improvement, challenged

Format: **Current → Improved → Measured/expected benefit → Cost → Risk → Recommendation.**

### 1. Alternative skeletonization (WASM thinning / distance-ridge / potrace-centerline)
- Current: raster TraceSkeleton + adaptive close. Output is already clean single centerlines.
- Improved: fewer junction stubs, possibly faster in WASM.
- Benefit: **Marginal quality**; junction stubs are better killed by cheap spur pruning (#7).
  Speed gain uncertain in JS; WASM adds a build/dependency burden.
- Cost: **HIGH** (replace the core, new dependency/build). Risk: **HIGH** (regresses a
  currently-good stage).
- **Recommendation: NOT RECOMMENDED now / Future.** No evidence the current skeleton is the
  quality bottleneck. Q1(limitation real?): only junction stubs. Q3(frequency): stubs common
  but minor. Q7(worth now?): no.

### 2. Graph extraction (junction graph: nodes=intersections, edges=strokes)
- Current: none. Polylines + greedy bridge heuristic.
- Improved: first-class junctions → robust crossing handling, principled merge/split, no over-merge.
- Benefit: Real for topology, but the greedy bridge already covers ~80% of cases (measured:
  crossings reconnect correctly).
- Cost: **HIGH** (new subsystem). Risk: **MED-HIGH**.
- **Recommendation: FUTURE WORK.** The project brief **explicitly excludes geometry graphs**
  for now. Not aligned with current scope. Revisit only if crossing/junction accuracy becomes
  a measured, frequent complaint.

### 3. SVG simplification / node reduction
- Current: RDP with a user `Simplify curves` slider. Node counts already minimal for real
  drawings (5–130).
- Improved: curvature-adaptive RDP → slightly fewer nodes on curves.
- Benefit: **Practically insignificant** for typical inputs; only helps the pathological dense case.
- Cost: LOW-MED. Risk: LOW.
- **Recommendation: NICE-TO-HAVE.** Mostly **subsumed by curve fitting (#4)**. Not worth as
  standalone work.

### 4. Curve-fitting improvement (least-squares Bézier fit, e.g. Schneider) — **the key one**
- Current: Catmull-Rom → one cubic **per simplified point-pair**. Smooth but node count ≈ point count.
- Improved: fit the fewest cubics within an error tolerance → **fewer control points, smoother
  curves, nicer to edit**.
- Benefit: **Directly hits the stated goal** — "cleaner SVG / fewer nodes / better curves / more
  accurate editing." Expect **~30–50% node reduction on curved strokes** and cleaner handles,
  visibly better in the editor.
- Cost: **MED** (~150 lines, drops into the `toPathD` stage; RDP already pre-thins input). Risk:
  **LOW** (isolated to one stage, feature-flaggable, reversible).
- **Recommendation: HIGH VALUE — implement first.** Best benefit-to-cost ratio, exactly on-scope,
  incremental, reversible.

### 5. Smoothing improvements
- Current: tension from `Detail`/preset, corner-aware. Tunable and adequate.
- **Recommendation: NOT RECOMMENDED as separate work.** Subsumed by curve fitting; no measured deficiency.

### 6. Corner preservation
- Current: straightness-weighted handles + `Corner sharpness` exponent + handle cap. Verified crisp.
- **Recommendation: ALREADY DONE.** No action. (Would only need re-validation if #4 changes the fit.)

### 7. Endpoint cleanup / junction spur pruning
- Current: `extendEnd` recovers retracted ends; **no spur pruning**. Junctions leave short dangling
  sub-paths (measured on X-crossings), trimmed only by the min-noise slider.
- Improved: auto-prune free-ended branches shorter than ~k·strokeWidth; trim end hooks.
- Benefit: **Visibly cleaner** output (fewer specks/whiskers at every junction). Measurable as a drop
  in tiny-path count.
- Cost: **LOW** (length + free-end test on existing polylines). Risk: **LOW**.
- **Recommendation: HIGH VALUE — implement second.** Cheap, visible, on-scope.

### 8. Path merging + 9. Gap repair
- Current: `bridgePolylines` (greedy collinear join) + morphological close. Reconnects crossings
  (measured good) but is **O(n²)** (7.7 s on dense) and can **over-merge** text.
- Improved: (a) spatial-hash endpoints → **O(n log n)**; (b) stricter max-join-angle + max-gap guard
  to stop over-merge.
- Benefit: **Removes the worst measured perf cliff** (10 s → ~1–2 s on dense; unfreezes sliders) and
  reduces text over-merge.
- Cost: **LOW-MED** (spatial grid for endpoints). Risk: **LOW-MED** (must preserve current
  crossing-repair quality).
- **Recommendation: HIGH VALUE / ESSENTIAL for robustness — implement third.** The O(n²)→grid fix is
  the highest-leverage reliability change; gap repair is already covered by the same code.

### 10. Node reduction
- Same as #3; delivered by #4 + the existing Simplify slider. **LOW standalone value.**

### Bonus (found during measurement, not on the original list)
- **B1. Lazy outline geometry** — stop tracing the outline ring for colours when Skeletonize is ON.
  **Free ~40–50% analyze speedup** by default. Cost **TRIVIAL**, risk **near-zero**, reversible.
  **ESSENTIAL — implement zeroth (do it now).**
- **B2. Move `analyzeSkeletons` to a Web Worker** — the 1–2 s (mobile: 3–6 s) runs on the main thread
  and freezes the UI on Continue. A worker keeps the modal responsive; **output unchanged**. Cost
  **MED** (worker + transfer ImageData), risk **LOW**, flaggable. **HIGH VALUE for responsiveness.**

---

## Phase 3 — Will users actually notice?

| Improvement | User-visible? | Nature |
|---|---|---|
| Curve fitting (#4) | **Clearly visible** | cleaner curves, fewer nodes when editing |
| Spur pruning (#7) | **Visible** | fewer whiskers/specks at junctions |
| Bridge O(n²)→grid (#8) | **Visible on dense** | app no longer freezes / faster |
| Lazy outline (B1) | **Visible** | Continue ~40% faster, every time |
| Web Worker (B2) | **Visible** | no UI freeze during analysis |
| Alt skeletonization (#1) | Only measurable | no perceptible quality change |
| Graph extraction (#2) | Only measurable (rare) | edge cases only |
| Simplification/node/smoothing/corner (#3,5,6,10) | **Practically insignificant** as new work | already adequate |

---

## Phase 4 — Browser performance

**Measured (Desktop Chrome):** typical 1–2 s end-to-end; dense pathological 10 s;
flatten <10 ms; heap transient 70–130 MB; input-resolution-invariant.

**Estimated (NOT measured — recommend real testing):**
| Target | Typical analyze | Dense case | Notes |
|---|---|---|---|
| Desktop Chrome/Edge (V8) | ~1–2 s (measured Chrome) | ~10 s | baseline |
| Desktop Firefox (SpiderMonkey) | ~1.2–2.5 s (est.) | ~12 s (est.) | similar |
| Pixel 7a / mid Android | **~3–6 s (est.)** | **~25–40 s or OOM (est.)** | single-thread ~2–3× slower; **O(n²) bridge is dangerous here** |
| Safari (JSC) | ~1.5–3 s (est.) | ~15 s (est.) | no `performance.memory`; test separately |

Implication: **B1 (lazy outline), B2 (worker), and #8 (O(n²) fix) matter far more on mobile**
than desktop numbers suggest. They should precede any quality-only work if mobile is a target.

---

## Phase 5 — Cost vs Benefit

| Improvement | Benefit | Dev effort | Risk | Runtime cost | User impact | Priority |
|---|---|---|---|---|---|---|
| B1 Lazy outline geometry | ~40–50% faster analyze | Trivial | Very low | −cost | Faster every run | **Essential** |
| #8 Bridge O(n²)→grid + angle guard | Kills 10 s cliff; less over-merge | Low-Med | Low-Med | −cost | Reliability, no freeze | **Essential/High** |
| #4 Least-squares Bézier fit | Fewer nodes, better curves/editing | Med | Low | ≈neutral | Clearly visible | **High Value** |
| #7 Junction spur pruning | Cleaner output | Low | Low | ≈neutral | Visible | **High Value** |
| B2 Analyze in Web Worker | No UI freeze | Med | Low | ≈neutral | Visible (mobile esp.) | **High Value** |
| #3/#10 Node reduction | Marginal | Low-Med | Low | ≈neutral | Insignificant | Nice-to-have |
| #5 Smoothing | None new | Low | Low | — | Insignificant | Not recommended |
| #6 Corner preservation | Done | — | — | — | — | Already done |
| #1 Alt skeletonization | Marginal | High | High | ? | Not visible | Future / Not now |
| #2 Graph extraction | Edge cases | High | Med-High | +cost | Rarely visible | Future (out of scope) |

---

## Phase 6 — Feasibility (incremental?)

| Improvement | No arch change? | Replaces a module? | Feature-flaggable? | Independently benchmarkable? | Reversible? |
|---|---|---|---|---|---|
| B1 Lazy outline | Yes | No (lazy-init) | Yes | Yes | Yes |
| #8 Bridge grid | Yes | No (rewrites one fn) | Yes (keep old path) | Yes | Yes |
| #4 Curve fit | Yes | No (swaps `toPathD` body) | **Yes** | Yes | Yes |
| #7 Spur prune | Yes | No (adds a pass) | Yes | Yes | Yes |
| B2 Worker | Mostly (wrap analyze) | No | Yes | Yes | Yes |
| #1 Alt skeleton | **No** (core swap) | **Yes** | Hard | Yes | Risky |
| #2 Graph extraction | **No** (new subsystem) | Adds layer | Yes | Yes | Hard |

Every recommended item (B1, #8, #4, #7, B2) is **incremental, flag-gable, independently
benchmarkable, and reversible**. The two postponed items (#1, #2) are the only ones that
touch architecture — consistent with "prefer incremental over rewrite."

---

## Phase 7 — Expected outcomes (quantified)

**Current:** photo → SVG in ~1–2 s (desktop); 5–130 nodes; 1–5 KB; clean & editable for
real drawings; **dense inputs freeze ~10 s**; ~half analyze work wasted; minor junction whiskers.

**After the recommended batch (B1 + #8 + #4 + #7, optionally B2):**
- **Analyze ~40–50% faster** (B1) → typical **~0.6–1.2 s** desktop, and the mobile 3–6 s → ~2–3 s.
- **Dense case ~10 s → ~1–2 s** and **no slider freeze** (#8).
- **~30–50% fewer nodes on curved strokes** with cleaner handles → better editing (#4).
- **Fewer junction specks** → cleaner-looking SVG (#7).
- **No UI freeze during analysis** (B2).
- Topology preservation unchanged-to-better; geometric accuracy unchanged (these changes are
  cleanup/perf, not re-tracing).

---

## Final recommendation — prioritized roadmap

| # | Change | Tech benefit | User benefit | Effort | Regression risk | Browser impact | Maintainability | On-scope? |
|---|---|---|---|---|---|---|---|---|
| 1 | **B1 Lazy outline** | ~40–50% analyze cut | Faster every run | Trivial | Very low | Big on mobile | Simplifies | ✅ |
| 2 | **#8 Bridge O(n²)→grid + angle guard** | Removes cliff, less over-merge | No freeze, reliable | Low-Med | Low-Med | Big on mobile | Neutral | ✅ |
| 3 | **#4 Least-squares Bézier fit** | Fewer nodes, better curves | Cleaner, nicer editing | Med | Low | Neutral | Isolated stage | ✅ |
| 4 | **#7 Junction spur pruning** | Cleaner topology | Fewer specks | Low | Low | Neutral | Small pass | ✅ |
| 5 | **B2 Analyze in Web Worker** | Off main thread | No UI freeze | Med | Low | Big on mobile | Some plumbing | ✅ |
| — | #3/#5/#6/#10 | — | insignificant/done | — | — | — | — | ✅ but skip |
| — | #1 Alt skeletonization | marginal | none | High | High | ? | new dep | ⚠ postpone |
| — | #2 Graph extraction | edge cases | rare | High | Med-High | +cost | new subsystem | ❌ out of scope |

### Answer to the closing question
> *If the goal today is simply to convert a photographed sketch into the highest-quality SVG
> possible, which improvements give the greatest practical value, and which should be postponed?*

**Do now (greatest practical value, all incremental/reversible/on-scope):**
1. **Lazy outline geometry (B1)** — free ~40–50% speedup; trivial.
2. **Spatial-grid bridge merge + angle guard (#8)** — eliminates the only measured performance
   cliff (10 s → ~1–2 s) and the text over-merge; essential for mobile robustness.
3. **Least-squares Bézier curve fitting (#4)** — the biggest *quality* win: fewer nodes, better
   curves, more accurate editing — precisely the project goal.
4. **Junction spur pruning (#7)** — cheap, visibly cleaner SVG.
5. **(If mobile matters) analyze in a Web Worker (B2)** — removes the UI freeze.

**Postpone to future versions:**
- **Alternative skeletonization (#1)** — high cost/risk, no evidence it's the bottleneck; only
  reconsider if profiling on real mobile hardware proves the skeleton stage dominates.
- **Geometry-graph extraction (#2)** — a new subsystem, explicitly outside the current project
  scope; the greedy bridge already covers the common crossing cases.
- **Standalone smoothing / corner / node-reduction / simplification work** — already adequate or
  subsumed by #4; not worth separate effort.

**Bottom line:** the current pipeline is already producing clean, low-node, editable, browser-friendly
SVGs for real hand-drawn sketches in 1–2 s. The evidence says the right next moves are a handful of
**cheap, isolated cleanups (speed + robustness + curve quality)** — not an algorithmic rewrite.
