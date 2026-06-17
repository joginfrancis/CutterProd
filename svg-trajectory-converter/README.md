# svg-trajectory-converter

A custom-built geometry and motion planning engine that translates **SVG vector drawings** into **binary MicroSegment packets** for real-time CNC/stepper motor control.

Built for the [CutterProd](https://github.com/nikhilvb2/CutterProd) tangential knife cutting system. Works in both **browsers** and **Node.js** with no external dependencies.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Usage](#usage)
  - [Node.js (CommonJS)](#nodejs-commonjs)
  - [ES Modules / Browser](#es-modules--browser)
  - [Working with the Output](#working-with-the-output)
- [Configuration Reference](#configuration-reference)
- [SVG Authoring Guide](#svg-authoring-guide)
- [Output Format: The MicroSegment Packet](#output-format-the-microsegment-packet)
- [Architecture Deep-Dive](#architecture-deep-dive)
- [API Reference](#api-reference)

---

## Installation

```bash
npm install svg-trajectory-converter
```

---

## Quick Start

```javascript
import SvgConverter from 'svg-trajectory-converter';

const converter = new SvgConverter({
  scale: 3.7795,       // px → mm (96 DPI standard)
  flipY: true,         // screen Y-down → machine Y-up
  segmentLength: 1.0,  // 1mm segments
  stepsPerMM_X: 26.5,
  stepsPerMM_Y: 26.5,
  stepsPerMM_Z: 80.0,
  stepsPerDeg_A: 8.88,
  feedRate: 300,
  zUp: 5,
  zDown: 0,
});

const svgString = `<svg width="100" height="100">
  <path d="M10,10 L90,10 L90,90 L10,90 Z" />
</svg>`;

const { preamble, packets } = converter.convert(svgString);

console.log('Preamble commands:', preamble);
console.log('Number of binary packets:', packets.length);
```

---

## Usage

### Node.js (CommonJS)

```javascript
const SvgConverter = require('svg-trajectory-converter');
const fs = require('fs');

const svg = fs.readFileSync('my-design.svg', 'utf-8');

const converter = new SvgConverter({
  scale: 3.7795,    // 96dpi SVG px to mm
  flipY: true,
  feedRate: 300,
  segmentLength: 0.5,
  stepsPerMM_X: 26.5,
  stepsPerMM_Y: 26.5,
  zUp: 5,
  zDown: -1,
  angleThreshold: 15,
});

const { preamble, packets } = converter.convert(svg);

// Print the preamble (text commands)
preamble.forEach(line => console.log(line));

// Inspect each binary packet
packets.forEach((pkt, i) => {
  const view = new DataView(pkt.buffer);
  console.log(`Packet ${i}: dX=${view.getInt32(1, true)} dY=${view.getInt32(5, true)}`);
});
```

### ES Modules / Browser

```javascript
import SvgConverter, { Vector2, CubicBezier } from 'svg-trajectory-converter';

// Load SVG from file input or fetch
const response = await fetch('/my-design.svg');
const svgText = await response.text();

const converter = new SvgConverter({
  scale: 3.7795,
  flipY: true,
  feedRate: 300,
  segmentLength: 1.0,
  stepsPerMM_X: 26.5,
  stepsPerMM_Y: 26.5,
  stepsPerMM_Z: 80.0,
  stepsPerDeg_A: 8.88,
  bedW: 300,    // max cutting bed width (mm)
  bedH: 200,    // max cutting bed height (mm)
});

const { preamble, packets } = converter.convert(svgText);

// Stream packets over WebSerial
const port = await navigator.serial.requestPort();
await port.open({ baudRate: 115200 });
const writer = port.writable.getWriter();

for (const pkt of packets) {
  await writer.write(pkt); // Each pkt is a Uint8Array (26 bytes)
}

writer.releaseLock();
```

### Working with the Output

`converter.convert(svgString)` returns an object with two fields:

```javascript
const { preamble, packets } = converter.convert(svgString);
```

| Field | Type | Description |
|---|---|---|
| `preamble` | `string[]` | Human-readable text commands (enable motors, shape markers, tool change pauses) |
| `packets` | `Uint8Array[]` | Array of 26-byte binary MicroSegment packets ready to write to serial |

**Iterating the preamble:**
```javascript
preamble.forEach(line => {
  if (line === 'PAUSE_FOR_TOOL_CHANGE') {
    // Pause the machine, show UI prompt to user
    triggerToolChangeDialog();
  } else if (line.startsWith('; SHAPE_START')) {
    // e.g. "; SHAPE_START id=shape_0 method=thru_cut"
    const method = line.match(/method=(\S+)/)?.[1];
    console.log('Starting shape with method:', method);
  }
});
```

**Sending packets over WebSerial:**
```javascript
async function streamToMachine(packets, writer) {
  let seq = 0;
  for (const pkt of packets) {
    await writer.write(pkt);
    seq++;
    // Optional: yield to UI thread
    if (seq % 50 === 0) await new Promise(r => setTimeout(r, 0));
  }
}
```

---

## Configuration Reference

All options are passed to the `SvgConverter` constructor. Every field is optional — defaults are shown below.

### Coordinate & Scale

| Option | Type | Default | Description |
|---|---|---|---|
| `scale` | `number` | `1.0` | Multiplier to convert SVG units to millimeters. For a 96 DPI SVG, use `3.7795`. |
| `offsetX` | `number` | `0` | Translates the entire drawing on the X axis (mm) — use to center on the bed. |
| `offsetY` | `number` | `0` | Translates the entire drawing on the Y axis (mm). |
| `flipY` | `boolean` | `false` | Inverts the Y axis. **Set to `true`** for machines where Y=0 is at the bottom-left (CNC standard) but the SVG has Y=0 at the top-left (screen standard). |
| `bedW` | `number` | `Infinity` | Physical cutting bed width (mm). Coordinates are clamped to this boundary. |
| `bedH` | `number` | `Infinity` | Physical cutting bed height (mm). |

### Segmentation & Motion

| Option | Type | Default | Description |
|---|---|---|---|
| `feedRate` | `number` | `300` | Target movement speed in mm/s. Used to calculate the step frequency (`interval`) in each packet. |
| `segmentLength` | `number` | `1.0` | Maximum length (mm) of each linear segment. Curves and long lines are subdivided until every segment is ≤ this value. Decrease for smoother cuts; increase for faster processing. |

### Axis Step Rates

| Option | Type | Default | Description |
|---|---|---|---|
| `stepsPerMM_X` | `number` | `1.0` | Motor steps per physical mm on the X axis. Match to your hardware (e.g. `26.5` for a GT2 belt with 200-step motor). |
| `stepsPerMM_Y` | `number` | `1.0` | Motor steps per mm on the Y axis. |
| `stepsPerMM_Z` | `number` | `80.0` | Motor steps per mm on the Z axis (tool lift/plunge). |
| `stepsPerDeg_A` | `number` | `8.88` | Motor steps per degree of rotation on the A axis (tangential knife). |
| `stepsPerMM` | `number` | `1.0` | Legacy global fallback. Used for X and Y if per-axis values are not set. |

### Tool / Z Axis

| Option | Type | Default | Description |
|---|---|---|---|
| `zUp` | `number` | `5` | Safe Z height (mm) for travel moves between shapes. The tool lifts to this position before repositioning. |
| `zDown` | `number` | `0` | Cutting Z depth (mm). The tool plunges to this position at the start of each cut. Individual methods offset this value (see `data-method`). |

### Tangential Knife

| Option | Type | Default | Description |
|---|---|---|---|
| `angleThreshold` | `number` | `10` | If the knife's required heading changes by more than this many degrees between two trajectory points, a **Lift → Orient → Plunge** safety sequence is automatically inserted. Increase this to reduce interruptions on gentle curves; decrease it for tighter corner handling. |

### Axis IDs

| Option | Type | Default | Description |
|---|---|---|---|
| `idX` | `number` | `3` | Firmware motor ID for the X axis. |
| `idY` | `number` | `2` | Firmware motor ID for the Y axis. |
| `idZ` | `number` | `1` | Firmware motor ID for the Z axis. |
| `idA` | `number` | `4` | Firmware motor ID for the A (rotation) axis. |

### Safety Limits

| Option | Type | Default | Description |
|---|---|---|---|
| `maxSteps` | `number` | `30000` | Maximum number of steps allowed in a single packet. Moves exceeding this are automatically split across multiple packets. |
| `maxSpeed` | `number` | `30000` | Maximum step frequency (steps/sec). Packets exceeding this rate are slowed down by adjusting the interval. |

---

## SVG Authoring Guide

### Supported Elements

The converter handles all standard SVG shape elements:

| SVG Element | How it's processed |
|---|---|
| `<path>` | Parsed directly — supports `M L H V C S Q T A Z` commands |
| `<rect>` | Converted to 4 linear segments |
| `<circle>` | Converted to 4 cubic Bézier arcs (99.9% circular accuracy) |
| `<ellipse>` | Converted to 4 cubic Bézier arcs |
| `<line>` | Converted to `M` + `L` |
| `<polyline>` | Each point becomes a `L` segment |
| `<polygon>` | Same as polyline, with a closing `Z` |

### The `data-method` Attribute

Add `data-method` to any shape element to control cutting behavior:

```svg
<!-- Standard full-depth cut (default) -->
<path d="M0,0 L100,0" data-method="thru_cut" />

<!-- Score/fold line — cuts slightly shallower (zDown + 2mm) -->
<path d="M0,0 L100,0" data-method="crease" />

<!-- Kiss-cut on a sticker sheet — cuts slightly deeper than crease but not all the way through (zDown + 1mm) -->
<path d="M0,0 L100,0" data-method="off_base" />
```

**Automatic ordering:** When both `crease` and `thru_cut`/`off_base` shapes are present, the converter **always processes crease shapes first**, then injects a `PAUSE_FOR_TOOL_CHANGE` marker in the preamble before processing cuts. This prevents tearing on folded packaging designs.

### Group Transforms

Translate transforms on parent `<g>` elements are respected:

```svg
<g transform="translate(50, 30)">
  <path d="M0,0 L100,0" />  <!-- Treated as M50,30 L150,30 -->
</g>
```

### Filtering Hidden Elements

Elements with `display: none`, `visibility: hidden`, or inside `<defs>` / `<clipPath>` / `<mask>` are automatically skipped.

### Page Boundary Rect

A `<rect>` that exactly matches the SVG `viewBox` dimensions (within 1px tolerance) is automatically ignored — it's treated as a page background, not a cut shape.

---

## Output Format: The MicroSegment Packet

Each packet is a `Uint8Array` of exactly **26 bytes**, laid out in little-endian byte order:

```
Offset  Size  Type     Field
------  ----  -------  -----
  0       1   uint8    Start byte (always 0xAB)
  1       4   int32    dX  — relative X steps
  5       4   int32    dY  — relative Y steps
  9       4   int32    dZ  — relative Z steps
 13       4   int32    dA  — relative A (rotation) steps
 17       4   uint32   interval — timer ticks between steps (150 MHz clock)
 21       1   uint8    flags
 22       1   uint8    sequence number (wraps at 255)
 23       2   uint8×2  reserved (0x00)
 25       1   uint8    CRC-8 checksum (polynomial 0x8C, over bytes 0–24)
```

**Reading a packet in JavaScript:**
```javascript
const view = new DataView(packet.buffer);

const startByte = view.getUint8(0);    // 0xAB
const dX        = view.getInt32(1, true);
const dY        = view.getInt32(5, true);
const dZ        = view.getInt32(9, true);
const dA        = view.getInt32(13, true);
const interval  = view.getUint32(17, true);
const crc       = view.getUint8(25);
```

**Reconstructing physical distance from steps:**
```javascript
const STEPS_PER_MM_X = 26.5;
const distanceMM = dX / STEPS_PER_MM_X;
```

**Interval → speed:**
The `interval` field is in ticks of a 150 MHz timer. To convert to mm/s:
```
speed (steps/sec) = 150,000,000 / interval
speed (mm/sec)    = (150,000,000 / interval) / stepsPerMM
```

---

## Architecture Deep-Dive

The conversion pipeline has 7 distinct stages that every shape passes through before becoming binary packets.

### Stage 1 — Geometry Primitives

Two foundational classes handle all math.

**`Vector2`** — Immutable 2D vector:
```
add, sub, mul, div, dot, length, lengthSq, normalize, dist
```

**`CubicBezier`** — Defined by four `Vector2` control points (`p0`–`p3`):
- `sample(t)` — Evaluates the Bernstein polynomial at parameter `t` ∈ [0, 1]
- `getVelocity(t)` — Evaluates the **first derivative** `B'(t)`, giving the instantaneous direction vector. This is used to compute the correct knife heading and feed rate at every curve point.
- `getLUT(steps)` — Builds an arc-length look-up table by sampling the curve `n` times and accumulating chord distances. Returns `[{ t, dist }, ...]`.

### Stage 2 — Shape Normalization

All SVG elements are flattened into a single unified list of `{ type, args }` command objects before any geometry work begins.

- **Circles/Ellipses** → 4 cubic Bézier arcs using the magic constant `κ ≈ 0.5523`:
  ```
  A circle of radius r is approximated by 4 Bézier curves, each spanning 90°.
  Each control point is placed at distance κ·r from the anchor points.
  Maximum error: ~0.0273% of the radius.
  ```
- **Rects** → 4 `L` commands starting at the top-left corner
- **Polylines/Polygons** → sequential `L` commands, polygons closed with `Z`
- **Group `translate()` transforms** are accumulated and applied to all child command args

### Stage 3 — Path Tokenizer & Parser

SVG path `d` strings like `"M10,20 C30,40 50,60 70,80 Z"` are parsed by:

1. **Tokenizing** with regex: `/([a-zA-Z])|([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g`
2. **Command dispatch**: each letter maps to an argument count (`M`=2, `L`=2, `C`=6, `A`=7, etc.)
3. **Implicit repeat**: SVG allows chaining args without repeating the command letter (e.g., `L 10,20 30,40` = two separate `L` commands). The parser handles this by re-using the last command type when it encounters a number where it expects a letter.
4. **Relative → Absolute**: Lowercase commands (`m`, `l`, `c`, etc.) have their args offset by the current pen position, converting them to absolute coordinates.

### Stage 4 — Arc-Length Parameterization

Naïve curve sampling at equal `t` intervals bunches points near sharp turns and spreads them on gentle arcs — causing uneven step timing and tool pressure. This stage fixes that.

**For straight lines (`L`, `H`, `V`, `Z`):**
```
numSegments = ceil(totalDistance / segmentLength)
Each segment is exactly totalDistance/numSegments mm long.
```

**For Bézier curves:**
1. Build a LUT with 50 samples: `[{t:0, dist:0}, {t:0.02, dist:1.3}, ...]`
2. For each desired output point at distance `d_target`:
   - Binary-search the LUT for the bracket `[d_k, d_{k+1}]` containing `d_target`
   - Linear-interpolate to find the exact `t` value that corresponds to `d_target`
3. Sample `bezier.sample(t)` for position and `bezier.getVelocity(t)` for direction

Result: **every emitted point is exactly `segmentLength` mm from the previous**, regardless of curve curvature.

### Stage 5 — Coordinate Transformation

Before a point becomes a step count, it passes through a 4-stage filter:

```
Raw SVG (px)
  → × scale                   (px → mm)
  → flipY ? y = -y : y        (screen coord → machine coord)
  → + offsetX / offsetY       (center on physical bed)
  → clamp to bedW × bedH      (enforce physical limits)
```

### Stage 6 — Tangential Knife Kinematics

For each output point, the required knife heading is computed:

```javascript
targetAngle = atan2(dy, dx) × (180 / π)    // degrees, 0–360
diff = shortestRotation(state.machineA, targetAngle)
```

If `|diff| > angleThreshold`, a **Lift-Orient-Plunge** sequence is inserted:
```
1. Z → zUp              (lift tool clear of material)
2. A → targetAngle      (rotate knife to new heading)
3. Z → zDown            (plunge back to cutting depth)
4. Continue XY move
```

This prevents the blade from dragging sideways through the material on tight corners.

### Stage 7 — MicroSegment Packet Encoding

Each trajectory point becomes a delta relative to the previous machine position:

```javascript
dX = round((targetX - machineX) × stepsPerMM_X)
dY = round((targetY - machineY) × stepsPerMM_Y)
dZ = round((machineZ - targetZ) × stepsPerMM_Z)   // inverted: + = lift
dA = round((targetAngle - machineA) × stepsPerDeg_A)
```

The step interval is calculated from the velocity vector:

```javascript
maxStep   = max(|dX|, |dY|, |dZ|, |dA|)
duration  = maxStep / speed_in_steps_per_sec
interval  = round((150_000_000 × duration) / maxStep)
```

If `maxStep > maxSteps`, the move is automatically split into smaller sub-packets before encoding.

The packet is finalized with a CRC-8 checksum (polynomial `0x8C`) over bytes 0–24. The firmware validates this checksum and discards corrupted packets.

---

## API Reference

### `new SvgConverter(options)`

Creates a converter instance. See [Configuration Reference](#configuration-reference) for all options.

### `converter.convert(svgString) → { preamble, packets }`

Parses the SVG and returns:
- `preamble: string[]` — Text commands/markers
- `packets: Uint8Array[]` — 26-byte binary packets

### `converter.transform(point) → { x, y }`

Applies scale, flipY, and offsets to a `Vector2`. Useful for coordinate preview.

### `Vector2(x, y)`

Exported class. Available methods: `add`, `sub`, `mul`, `div`, `dot`, `length`, `lengthSq`, `normalize`, `dist`.

### `CubicBezier(p0, p1, p2, p3)`

Exported class. All args are `Vector2`. Available methods: `sample(t)`, `getVelocity(t)`, `getLUT(steps)`.

```javascript
import { Vector2, CubicBezier } from 'svg-trajectory-converter';

const curve = new CubicBezier(
  new Vector2(0, 0),
  new Vector2(25, 100),
  new Vector2(75, 100),
  new Vector2(100, 0)
);

const midpoint = curve.sample(0.5);
const velocity = curve.getVelocity(0.5);
const lut      = curve.getLUT(200);
```

---

## License

MIT © Nikhil Nair
