# Plan: Vision extract — clean, modern, single-screen UI

Date: 2026-07-05
Status: PLANNED

## UX assessment of the current flow (what's cluttered / wrong)
1. **Tabs mislead.** "1. Detect / 2. Vectorize" imply a stepper you jump around. The flow
   is actually linear (crop → review → insert). Tabs = visual noise + wrong mental model.
2. **Colours listed twice.** Detect page lists colours; Vectorize page lists the *same*
   colours again with dropdowns. Redundant, and the operation is what actually matters.
3. **Too many boxed rows.** Background box, "Detected pen colours…" caption box, colour
   cards, "Assign each colour…" caption, colour cards again, two labelled sliders — every
   element is a bordered card, so the eye has no hierarchy. It reads as a wall of boxes.
4. **Sliders always in your face.** Detail/Simplify are refinements most users never touch,
   yet they occupy prime space and push the colour list into a scroll.
5. **Background gets a full row** for something that's usually just "yes, that's the paper".
6. **Redundant chrome** already fixed (nested window) — keep going: fewer captions, fewer
   borders, more whitespace.

Plus a correctness bug seen in the screenshots: a false **"white · 30 strokes"** colour —
the substrate leaks past the ink threshold and forms its own cluster. Fix alongside the UI.

---

## Target: ONE review screen, linear, back-only

Flow: **Connect → Crop → Review → (inserted)**. A single **Back** arrow (top-left of the
body) steps to the previous stage. No tab bar, no forward jumping.

```
┌───────────────────────────────────────────────┐
│ 📷 Vision Capture                            ✕ │  ← the one window header
├───────────────────────────────────────────────┤
│ ‹ Back                        paper: A4 ▾       │  ← slim context bar (back + paper)
│                                                 │
│         ┌───────────────────────────┐           │
│         │      LIVE  PREVIEW         │           │  ← dominant, rounded, zoom/pan
│         │   (image faint + vectors) │           │
│         └───────────────────────────┘           │
│                                                 │
│  Colours                                        │  ← one section, one list
│   ● red      → [ Cut    ▾ ]                      │
│   ● blue     → [ Draw   ▾ ]                      │
│   ● green    → [ Crease ▾ ]   ⤺ merge (if alike) │
│                                                 │
│  Background ⬜ #FFFFFF · change                   │  ← one subtle line, not a card
│  ⚙ Fine-tune  ▾   (Detail · Simplify)           │  ← collapsed by default
│                                                 │
│              [  Add to Canvas  ]                │  ← single primary CTA
└───────────────────────────────────────────────┘
```

### What each part becomes
- **Colours = the single source of truth.** One row per colour: a round swatch, the
  human name (hex on hover / small), and the **operation dropdown** inline. Merge shows as a
  small ghost affordance only when two colours are perceptually close. No separate
  "detected colours" vs "assign" lists.
- **Background** is one quiet line (swatch + hex + "change" that arms the eyedropper), not a
  boxed row. Re-detects on change.
- **Fine-tune** (Detail + Simplify sliders) lives in a collapsed disclosure — hidden by
  default, one click to reveal. Live preview still updates when open.
- **Preview** is the hero: bigger, rounded, subtle 1px border + soft inner shadow, faint
  normalized image behind crisp vector strokes. Zoom/pan retained.
- **Context bar**: Back (‹) on the left; paper size moved here as a compact select (it
  belongs with crop context, not the footer).

---

## Visual system (modern, calm)
- **Fewer borders, more space.** Drop per-row card borders; separate colour rows by
  whitespace + a hairline divider only. One container, not many cards.
- **Type hierarchy.** Section labels: 0.7rem uppercase, muted, letter-spaced. Colour name:
  0.85rem medium. Hex: 0.68rem mono muted. Consistent 8px/12px spacing rhythm.
- **Swatches** are 20px rounded chips with a subtle ring, not squares with heavy borders.
- **Dropdowns** restyled: borderless until hover/focus, accent ring on focus.
- **One primary action** (gradient "Add to Canvas"); Back is a quiet ghost/text button.
- **Motion**: 150ms ease on hover/disclosure; preview cross-fades on refine.
- Reuse existing tokens (`--accent`, `--border`, `--text-muted`, `--accent-glow`).

---

## Behaviour / performance (unchanged engine)
- Heavy analyse runs once entering Review, and on background/merge change.
- Slider (fine-tune) changes run the light `refinePaths` only → instant preview.
- Everything already exists (`analyzeSkeletons`, `refinePaths`, `buildSVG`); this is a
  **presentation refactor** of the wizard, not an engine change.

## Detection fix (bundle in)
- Kill the false "white/near-substrate" cluster: after clustering, drop any colour whose
  Lab is within a larger ΔE of the substrate **or** whose lightness is high + chroma low
  (near-paper). Raise the near-substrate reject from ΔE 22 → ~28 and add a low-chroma+high-L
  guard so pale grey paper-leak never becomes a "colour".

---

## Implementation steps
1. **Strip the tab stepper**; replace `#wizDots` with a slim context bar (Back ‹ + paper).
2. **Single Review body**: preview (hero) → Colours list (swatch + name/hex + op dropdown +
   inline merge) → Background line → Fine-tune disclosure → Add to Canvas.
3. **Restyle** per the visual system (new `.vex-*` classes; retire the boxy `.vep-*` cards).
4. **Merge the two render functions** (`renderWizDetect` + `renderWizVectorize`) into one
   `renderReview()`; keep zoom/pan + eyedropper + sliders (now in the disclosure).
5. **Back**: Review → Crop → Connect (single arrow, context-aware label).
6. **Detection guard** for substrate-leak clusters.
7. Verify on the cat+grid photo: one screen, 3 real colours (no "white"), sliders hidden
   until expanded, insert works, Back returns to crop.

## Acceptance
- No tabs; one linear Review screen with a Back arrow.
- Colours appear once, each with its operation inline.
- Sliders hidden by default (Fine-tune disclosure); preview still live when open.
- Background is a single quiet line; false "white" colour gone.
- Visibly calmer: whitespace + hairlines instead of stacked cards.
