# Research Proposal

## Sketch-to-Fabrication: A Browser-Native, Calibration-Free Pipeline for Intent-Aware CNC Toolpath Generation from Hand-Drawn Color-Coded Diagrams

**Nikhil Nair**
June 2026

---

## Abstract

We propose a research program investigating a new class of human-machine interface for digital fabrication: one where the design medium is a hand-drawn diagram on paper, and the machine receives its instructions not through CAD software, but through a photograph. We present a working prototype — the **UrumiCutter** system — that realizes this vision end-to-end. A user draws cut lines, score lines, and fold lines in colored ink on a blank sheet, places it on the cutting bed, photographs it with a smartphone, and the machine cuts within seconds. No software installation. No CAD training. No calibration ritual.

The system achieves sub-millimeter dimensional accuracy through a novel hybrid calibration strategy combining ArUco fiducial homography with checkerboard-based sub-pixel lens distortion compensation, running entirely in a Python/Flask backend accessible over a local network. Toolpath intent — *what* the machine should do with each stroke — is communicated through ink color, decoded via a 3×3 HSL neighborhood sampling classifier with majority voting, and serialized as `data-method` attributes on SVG path elements. The resulting vector geometry is compiled by a dependency-free geometry engine that performs arc-length parameterized Bézier flattening, tangential knife kinematics, and 26-byte binary packet encoding, streamed directly to a Raspberry Pi Pico over the W3C WebSerial API — with no native app, no driver installation, and no OS-level privileges required.

This proposal argues that the system represents a meaningful step toward the broader research vision of **making fabrication machines as approachable as writing on paper**, and identifies the open scientific questions that a rigorous research program would address.

---

## 1. Motivation

### 1.1 The Literacy Gap in Digital Fabrication

The promise of the personal fabrication revolution — that any individual could design and manufacture complex physical objects — has been substantially realized at the hardware level. Laser cutters, vinyl cutters, drag-knife systems, and desktop CNC mills are now commercially accessible at a fraction of their 2005 cost. What has *not* democratized at the same pace is the **design software layer**.

The dominant workflow — designer opens Inkscape or Illustrator, constructs a precise vector drawing, exports an SVG or DXF, loads it into a CAM toolpath planner, configures axis parameters, and sends to the machine — requires a non-trivial literacy barrier. Each step is a potential failure point: coordinate system mismatches, incorrect scale, missing driver software, unsupported file format versions. For a first-time user, the gap between "I want this shape cut" and "the machine cuts this shape" can span days of troubleshooting.

More fundamentally, **the design medium has been decoupled from the designer's most fluent tool**: the hand. Humans have been drawing to communicate spatial intent for thousands of years. A packaging engineer sketching fold lines on graph paper, a tailor marking cut patterns on fabric, an architect drawing construction details on tracing paper — these are instances of the same cognitive act that CAD software attempts to formalize and systematize at enormous cost to fluency.

### 1.2 The Missing Primitive: Intent in the Drawing

Prior work in sketch-based fabrication (e.g., SketchChair, Constructable, Sketch2CAD) has focused primarily on **geometric reconstruction**: recovering 3D shape or 2D outline from sketch input. This is a valuable and hard problem, but it addresses only one half of the fabrication specification. The other half — which operation the machine performs on each stroke — is typically handled through a separate GUI layer (assigning cut vs. engrave in a drop-down, coloring by layer, etc.), preserving the fundamental disconnect between the natural drawing act and the machine configuration act.

Our observation is that **a drawing tool's color has always carried semantic weight**. Draftspeople use red for cuts, blue for annotations, yellow for highlighting. This is not a convention we invented — it is latent in decades of design practice. The research question is whether this latent semantic channel can be reliably formalized into a fabrication instruction set with sufficient accuracy to be practically useful.

---

## 2. The UrumiCutter System: A Technical Description

### 2.1 System Overview

The system consists of three loosely coupled subsystems:

```
[Smartphone Camera]
       │
       ▼
[UrumiCam Backend — Python/Flask]
  • ArUco homography (perspective rectification)
  • Sub-pixel checkerboard lens distortion compensation
  • Adaptive thresholding + binary mask generation
  • Topological skeletonization (TraceSkeleton, chunk=2)
  • 3×3 HSL neighborhood color classification
  • Majority-vote stroke labeling
  • SVG serialization with data-method attributes
       │
       ▼ (HTTP push / WebSocket)
[CutterProd Frontend — Vanilla JS, runs in browser]
  • svg-trajectory-converter (zero-dependency geometry engine)
  • Arc-length parameterized Bézier flattening
  • Tangential knife kinematics (Lift-Orient-Plunge on corners)
  • 26-byte MicroSegment binary packet encoding (CRC-8)
  • nope/ready flow-controlled WebSerial streaming
       │
       ▼
[Hardware — Raspberry Pi Pico / RS485 Motor Network]
  • 4-axis (X, Y, Z, A) stepper control
  • Tangential drag-knife end effector
```

The entire design-to-cut loop, from photograph upload to first motor movement, takes under 10 seconds on a commodity laptop.

### 2.2 Calibration Architecture

The calibration challenge is precise: a photograph taken at an arbitrary angle with an unknown smartphone lens must be rectified to sub-millimeter spatial accuracy at a physical cutting bed that may be up to 300mm × 200mm.

We address this with a two-stage approach:

**Stage 1 — Global Perspective Rectification (ArUco):**
Four ArUco markers (ID 0–3) are permanently mounted at the physical corners of the cutting bed at precisely measured positions in millimeters (stored in `config.json`). The backend detects the four marker centroids in the uploaded image, computes the best-fit 3×3 homography matrix H using OpenCV's `getPerspectiveTransform`, and applies it to the full image. This produces a top-down, orthogonal view of the bed, but with any global lens distortion preserved.

**Stage 2 — Sub-pixel Lens Distortion Compensation (Checkerboard):**
A black-and-white checkerboard pattern is printed along the perimeter of the physical bed frame. After the homography step, the backend detects the inner corners of these squares using `cv2.cornerSubPix` with sub-pixel refinement. The deviation of these detected corners from their ideal grid positions encodes the radial and tangential distortion coefficients (k₁, k₂, p₁, p₂) of the smartphone lens. A per-upload `cv2.undistort` pass corrects this distortion, completing the spatial calibration.

The combined output `dots_per_mm` scale factor is passed to the frontend, where it replaces all auto-fit scale logic with a direct 1:1 physical translation.

### 2.3 The Color Classification Pipeline

Topological skeletonization (Lingdong Huang's `TraceSkeleton`, chunk size 2) converts the binary mask into centerline polylines. These polylines are then classified into cutting methods by the following procedure:

1. **Uniform sampling:** N = min(20, polyline.length) points are drawn at even intervals along each polyline.

2. **3×3 Neighborhood darkest-pixel search:** For each sample point (x, y), a 3×3 kernel is scanned. The pixel with minimum HSL Lightness L within the kernel is selected as the representative sample. This counters boundary anti-aliasing, where edge pixels in the rectified color image are a blend of ink and paper, producing desaturated, low-hue readings that would be misclassified.

3. **RGB → HSL conversion:** The representative pixel is mapped to HSL cylindrical coordinates. Hue H is invariant to illumination angle; Saturation S differentiates ink from grey noise.

4. **Threshold classification:**
   - S < 0.12 → `neutral` (black/grey ink) → `thru_cut`
   - H ∈ [335°, 360°) ∪ [0°, 25°) → `red` → `thru_cut`
   - H ∈ [75°, 160°) → `green` → `crease`
   - H ∈ [170°, 265°) → `blue` → `off_base`

5. **Majority voting:** The modal class over all N samples determines the stroke's `data-method`.

### 2.4 The Geometry Engine (`svg-trajectory-converter`)

The SVG geometry engine is a dependency-free JavaScript module (~1,000 LOC) that runs identically in browser and Node.js environments. Its principal contributions:

**Arc-length parameterization:** Bézier curves are not uniformly sampled in the parameter domain t. Instead, a 50-point LUT mapping t → physical arc distance is constructed. For each desired output point at distance d_target, a binary search locates the enclosing LUT bracket and linearly interpolates to find the exact t that corresponds to that distance. This ensures every emitted trajectory point is within ±ε of the configured `segmentLength` mm from the previous, regardless of curvature — a necessary condition for constant-pressure tool contact in material cutting.

**Tangential knife kinematics:** At each trajectory point, the required knife heading is computed as `atan2(dy, dx)`. A shortest-path angular difference test determines whether a Lift-Orient-Plunge sequence must be injected. When `|diff| > angleThreshold`, the machine lifts the tool to `zUp` (clearing the material), rotates the A-axis to the new heading, and re-plunges to `targetZDown` before continuing the XY move. This prevents blade drag-scraping through material on acute corners.

**Binary packet protocol:** Each trajectory point is encoded as a 26-byte MicroSegment packet: a start byte (0xAB), four signed 32-bit relative step deltas (dX, dY, dZ, dA), a 32-bit timer interval at 150 MHz resolution, a flags byte, a sequence counter, two reserved bytes, and a CRC-8 checksum (polynomial 0x8C). The CRC is validated by the firmware on the Pico; corrupted packets are discarded without crashing the motion pipeline.

**WebSerial flow control:** The frontend maintains a `nope`/`ready` handshake with the firmware. After each packet, the browser waits for a `ready` response before sending the next. This prevents buffer overruns on the Pico's UART FIFO without requiring any OS-level serial port driver.

---

## 3. Research Questions

The working prototype establishes feasibility. A rigorous research program would address the following open questions:

### 3.1 Accuracy Characterization

**RQ1:** What is the distribution of spatial reconstruction error (measured at fiducial points not used in calibration) as a function of: (a) smartphone model / lens characteristics, (b) photograph angle of incidence from vertical, (c) ambient illumination conditions, (d) bed utilization (how much of the bed is used)?

**RQ2:** At what angle of incidence does the homography + distortion correction pipeline fail, and what is the degradation function?

**RQ3:** Can the sub-pixel checkerboard compensation be replaced by a one-time per-device calibration (saving the distortion coefficients) without meaningful accuracy loss?

### 3.2 Classifier Robustness

**RQ4:** What is the false-positive and false-negative rate of the 3×3 HSL neighborhood classifier across a realistic population of: (a) consumer pen brands, (b) lighting conditions (fluorescent, daylight, tungsten), (c) paper types (coated, uncoated, recycled)?

**RQ5:** What is the minimum distinguishable saturation differential between two ink colors that produces reliable classification? This bounds the maximum number of distinct toolpath intents that can be communicated via the color channel.

**RQ6:** Does the majority-vote threshold (mode over 20 samples) provide optimal accuracy, or is there a better aggregation strategy (e.g., confidence-weighted vote, CNN feature classifier)?

### 3.3 End-to-End Cut Accuracy

**RQ7:** What is the dimensional error of the cut output relative to the original drawing, measured across: (a) straight lines, (b) circular arcs, (c) sharp corners, (d) compound curves?

**RQ8:** How does `segmentLength` (the Bézier flattening resolution, currently configurable from 0.1–2.0 mm) trade off against cut quality (positional accuracy, corner sharpness) and streaming throughput?

### 3.4 User Study

**RQ9:** Without any training, can a naive user produce a drawing that the system interprets and executes correctly on the first attempt? What error modes dominate (wrong color choice, ink bleed, drawing size below resolution threshold)?

**RQ10:** What is the perceived effort difference between the color-coded sketch workflow and a canonical CAD-to-machine workflow for a simple multi-layer cut job (e.g., a packaging template with crease and cut lines)?

---

## 4. Proposed Contributions

A complete research program around this system would produce the following contributions:

1. **A characterization of the accuracy envelope of smartphone-calibrated, ArUco-anchored homographic rectification** for physical fabrication contexts — providing the community with principled bounds rather than anecdotal demonstrations.

2. **A formal framework for semantic color as a fabrication instruction channel** — establishing the HSL threshold conditions under which color reliably encodes discrete process intent, and the failure modes that violate those conditions.

3. **A runtime architecture for browser-native fabrication control** — demonstrating that the complete path from vector geometry to physical machine motion can be executed inside a W3C-compliant browser tab, without any OS-level dependencies, and characterizing the latency and throughput bounds of WebSerial flow-controlled packet streaming.

4. **An open, zero-dependency SVG trajectory compilation library** (`svg-trajectory-converter`, published on npm) that provides arc-length parameterized curve flattening and tangential knife kinematics as composable primitives for the broader personal fabrication software ecosystem.

5. **A user study establishing the learnability and error profile** of the sketch-to-fabrication interaction paradigm relative to existing CAD-based workflows.

---

## 5. Broader Significance

The fabrication machine has historically been a terminus — the last step in a long chain of digital mediation. This project proposes that it could instead be a *responder* to the most natural human design act: drawing. If the accuracy and robustness questions above can be answered affirmatively, the implications extend well beyond vinyl cutting:

- **Education:** A classroom full of students with colored markers and a single cutter could design and produce physical objects without any software literacy prerequisite.
- **Rapid prototyping in low-resource environments:** Where licensed CAD software and high-bandwidth internet are unavailable, a smartphone and a sketch could be sufficient to drive a fabrication machine.
- **Design-in-the-loop:** Physical mockups annotated by hand — "cut here," "fold here," "deepen this" — could be re-scanned and re-cut iteratively, making revision as natural as sketching.
- **Accessibility:** For users with limited fine-motor control for mouse-based vector drawing, a physical pen on paper may be a more accessible design medium.

The deeper scientific contribution is a demonstration that **semantic intent can survive the noisy, unconstrained physical-to-digital transition from ink-on-paper to machine command**, and a rigorous characterization of the conditions under which it can and cannot.

---

## 6. Current Status

The system described in this proposal is a complete, working prototype:

- The UrumiCam Python backend is operational with both Method 1 (gantry-mounted camera + ArUco mosaic stitching) and Method 2 (smartphone + perspective rectification).
- The CutterProd browser frontend is fully functional, including the drawing editor, trajectory preview, and WebSerial streaming with flow control.
- The `svg-trajectory-converter` library is published on npm and in active use.
- Physical hardware (4-axis gantry with RS485 motor network and Raspberry Pi Pico controller) is operational.
- End-to-end cuts from smartphone photographs have been demonstrated.

What is missing — and what constitutes the proposed research program — is **rigorous quantitative evaluation**: controlled accuracy experiments, classifier robustness testing across realistic variability, and a user study. The prototype answers the question "can this work?" The research program would answer "under what conditions does it work, how well, and for whom?"

---

## 7. Related Work

**Sketch-based fabrication interfaces:** Constructable (Mueller et al., 2012) demonstrated laser cutter control via physical sketch, but required a dedicated projector-camera system. Sketch2CAD and similar approaches recover 3D geometry from 2D sketches but do not address the toolpath intent problem. This work focuses on the semantic encoding of process intent, not geometric reconstruction.

**Fiducial-based spatial calibration:** ArUco markers (Garrido-Jurado et al., 2014) are well-established for augmented reality registration. Their application to physical fabrication calibration — where accuracy requirements are millimetric rather than perceptual — introduces constraints not explored in the AR literature.

**Browser-based machine control:** WebSerial (W3C, 2021) is an emerging API with limited adoption in fabrication contexts. Existing browser-based CNC interfaces (e.g., CNCjs) use Node.js backends as serial proxies. This work demonstrates direct browser-to-hardware streaming without any server intermediary.

**Color as a semantic channel:** Color-coded markup has been used in document annotation systems (e.g., Macula, Infix) and in physical computing prototyping tools (e.g., SketchPatch). Formalization of color as a fabrication instruction encoding, with robustness analysis under physical capture conditions, is novel.

---

## References

- Garrido-Jurado, S., Muñoz-Salinas, R., Madrid-Cuevas, F. J., & Marín-Jiménez, M. J. (2014). Automatic generation and detection of highly reliable fiducial markers under occlusion. *Pattern Recognition*, 47(6), 2280–2292.
- Huang, L. (2020). Lindong/Skeleton-Tracing. GitHub. https://github.com/LingDong-/skeleton-tracing
- Mueller, S., Lopes, P., & Baudisch, P. (2012). Constructable: Interactive construction of functional mechanical devices. *UIST 2012*.
- W3C Web Serial API. (2021). https://wicg.github.io/serial/
- Nair, N. (2026). svg-trajectory-converter. npm. https://www.npmjs.com/package/svg-trajectory-converter

---

## Appendix: Adjacent Research Directions

The following directions emerged from the same system and codebase. They are independent of the primary proposal and could be pursued as separate papers or as extensions.

### A. The MicroSegment Protocol as a Research Artifact

The 26-byte MicroSegment binary format — CRC-8 integrity, 150 MHz timer-tick interval encoding, 4-axis signed relative delta compression, sequence numbering — is a minimal real-time motion protocol designed for lossy serial links with no retransmission. Almost all consumer-grade CNC communication today uses ASCII G-code, which is verbose, stateless, and not designed for streaming. An open research question: what is the minimum viable binary protocol for stepper-motor fabrication over unreliable physical links, and how does it compare to G-code across dimensions of reliability, latency, implementation cost on constrained microcontrollers, and debuggability? This is a systems/embedded paper with a clear evaluation methodology.

### B. Arc-Length Parameterization as the Correct Default for Consumer CNC

Most hobbyist CAM toolchains (Inkscape's built-in path-to-gcode exporter, LaserWeb, Carbide Create) perform naïve equal-parameter (equal-t) Bézier sampling. This bunches trajectory points near inflection points and spreads them on gentle arcs, producing uneven tool pressure and variable cutting depth. The `svg-trajectory-converter` engine performs arc-length parameterized sampling: every emitted point is exactly `segmentLength` mm from the previous, regardless of local curvature. The research contribution is a controlled empirical study — using the same physical hardware — measuring how much this difference matters in practice for drag-knife and laser cutting contexts, across a range of curve geometries and material hardnesses. This would be a short, reproducible, practically impactful paper.

### C. The Browser as a Fabrication Runtime

The CutterProd frontend streams binary packets directly from a browser tab to a Raspberry Pi Pico over the W3C WebSerial API, using a `nope`/`ready` handshake for backpressure without any server intermediary. Most existing browser-based CNC interfaces (CNCjs, etc.) proxy serial communication through a local Node.js server, inheriting the latency and reliability characteristics of localhost TCP. True browser-to-hardware streaming introduces a different failure profile: main-thread scheduling jitter, garbage collection pauses, tab backgrounding throttling. A paper formally characterizing the latency distribution, inter-packet jitter, and failure modes of WebSerial for real-time machine control — with comparison to native serial and Node proxy architectures — would be of significant value to the emerging browser-native fabrication community.

### D. The Annotated Object: Iterative Fabrication via Physical Markup

The most ambitious direction. The current system encodes fabrication intent in the drawing (ink on paper placed on the bed). A generalization: what if the *object being fabricated* is the drawing surface? A workpiece with ArUco markers could be tracked across multiple sessions — cut, removed, annotated by hand with colored ink indicating next operations, re-placed on the bed, and re-scanned. The system would re-register the object using the markers, read the new annotations, and continue fabrication. This enables a design loop where physical modification and digital instruction are interleaved without any software interface — the machine reads the artifact's own surface as its next instruction set. This is a full research vision with implications for iterative physical prototyping, repair workflows, and human-robot collaboration in fabrication contexts.
