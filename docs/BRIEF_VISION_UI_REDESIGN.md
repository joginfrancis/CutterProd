# Design brief: redesign the "Vision Capture" modal UI

*Hand this to a UI/design agent. It is self-contained.*

## Project context (1 paragraph)
UrumiCutter is a browser-based control app for a CNC cutting/creasing/plotting machine
(think desktop plotter/cutter). One feature, **Vision Capture**, lets a user photograph a
hand drawing (e.g. a child's cat + a grid, drawn in coloured marker on white A4), and turn
it into machine tool-paths. The app flattens the photographed page, detects each pen colour,
vectorises the strokes, and lets the user map **each colour → a machine operation**
(Cut / Crease / Draw / Off-base / Ignore) before inserting the result onto the design canvas.
It's a light-themed, modern web UI (Inter font, blue accent `#3b82f6`, rounded cards,
subtle shadows).

## Where this UI lives
A single centered **modal** ("Vision Capture") ~600 px wide, max ~90vh tall, on a dimmed
backdrop. It has one header (camera icon + "Vision Capture" + ✕) and moves through 3 phases
inside that one window (no nested pop-ups, no second window):

1. **Connect** — QR code to open a phone capture app, or "Upload from PC".
2. **Crop** — a 4-corner cropper over the photo (zoom/pan) + paper-size select.
3. **Review** — the screen we want redesigned (below).

## The screen to redesign: "Review"
Purpose: confirm the extracted result and assign an operation to each detected colour, then
insert. It currently contains, top→bottom:
- a **live preview** (faint flattened photo behind crisp coloured vector strokes; zoom/pan),
- a **Colours** list — one row per detected pen colour: colour swatch, name, hex, and a
  dropdown to pick the machine operation; a "merge" affordance appears when two colours look
  alike (e.g. anti-aliased duplicates),
- a **Background** line — the paper colour being ignored (with an eyedropper "change"),
- a collapsible **Fine-tune** section — two sliders: *Detail* (Smooth↔Accurate) and
  *Simplify* (Detailed↔Simplified) that re-render the preview live,
- a **Back** link (to Crop) and a primary **Add to Canvas** button.

## The problem (what to fix)
The current version reads as **cluttered and boxy**: too many bordered cards stacked
(background box, caption boxes, colour cards, slider rows), weak visual hierarchy, and the
sliders/lists compete for attention. We already removed a tab bar and a nested "window",
but it still feels busy. We want a **calm, modern, obviously-linear** screen.

## Goals / requirements for the redesign
1. **Single, calm screen.** Whitespace and hairline dividers over stacked cards. Clear
   hierarchy: preview is the hero; colours are the primary control; background + fine-tune
   are secondary/quiet.
2. **Linear, back-only.** No tabs or step-jumping. One quiet "Back", one primary CTA.
3. **Colours = the main interaction.** Each row must make the swatch, a human colour name,
   the hex, and the operation dropdown scannable at a glance. Merge is a subtle inline hint,
   not a loud button.
4. **Advanced controls stay out of the way.** Detail/Simplify sliders live behind a
   disclosure, collapsed by default.
5. **Modern visual language.** Light theme, Inter, blue accent, 8–12 px spacing rhythm,
   rounded (10–12 px) surfaces, soft shadows, 150 ms hover transitions, rounded colour
   chips, focus rings on inputs. Feel: Linear / Notion / modern SaaS settings panel.
6. **Constraints.** Must fit ~600 px wide modal; content may scroll but the CTA stays
   reachable; touch-friendly hit targets; works with 2–6 detected colours.

## Deliverables requested
- A redesigned layout for the **Review** screen (and, if useful, matching treatments for the
  Connect and Crop phases so the 3 phases feel like one product).
- Component specs: colour row, background line, fine-tune disclosure, preview frame,
  context/nav bar, primary button.
- A few **reference mockup images** (see prompts below) to anchor the direction.

## Prompts to generate reference mockup images
Use these to produce reference visuals (e.g. with an image model), 4:5 or 3:4 portrait,
"clean product UI mockup, light theme, Inter font, blue accent #3b82f6, high fidelity":

1. *"A clean modern web modal titled 'Vision Capture'. A slim top bar with a small back
   chevron on the left and '210 × 297 mm' on the right. Below, a large rounded preview panel
   showing a child's cat drawing and a coloured grid as thin vector strokes on a faint
   background. Under it, a section labelled 'COLOURS' with three minimal rows — each a round
   colour dot, a colour name, a small grey hex code, and a compact dropdown reading 'Draw' /
   'Cut' / 'Crease' — separated by hairlines, no boxes. A quiet single line 'Background
   #FFFFFF · change'. A big blue rounded 'Add to Canvas' button pinned at the bottom. Calm,
   lots of whitespace, Linear/Notion aesthetic."*
2. *"Same modal, the 'Fine-tune' disclosure expanded, revealing two slim labelled sliders
   'Detail (Smooth↔Accurate)' and 'Simplify (Detailed↔Simplified)' with an accent-coloured
   track. Everything else minimal and calm."*
3. *"Same modal in the Crop phase: a photographed A4 sheet on a wood table with four round
   draggable corner handles and a magnifier loupe near one corner, a small paper-size
   dropdown, one primary 'Continue' button. Consistent light modern styling."*
4. *"A colour row component sheet: the same row in default, hover, and focused-dropdown
   states, plus a variant showing a subtle inline 'merge' hint when two colours look alike.
   Pixel-clean, light theme, blue accent."*

## Do NOT change
The underlying pipeline/behaviour (flatten → detect colours → vectorise → assign → insert)
and the modal-in-one-window model are fixed. This is a **visual/UX redesign of the Review
screen**, not an engine change.
