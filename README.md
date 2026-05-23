# UrumiCutter

A unified browser-based control platform for driving a multi-axis CNC/plotter gantry over USB (via WebSerial) and scanning workpieces with the integrated **UrumiCam** computer-vision system.

One command — `npm start` — launches both the CutterProd frontend and the UrumiCam Python backend.

---

## Architecture

```
CutterProd/
├── src/                   # Frontend (vanilla JS, served on port 3000)
│   ├── index.html         # Single-page shell
│   ├── script.js          # Main controller & job loop
│   ├── CanvasEditor.js    # Interactive drawing editor (Draw tab)
│   ├── SvgConverter.js    # SVG → trajectory compiler
│   ├── Viewer.js          # G-code / trajectory canvas renderer
│   ├── FileHandler.js     # File loading, scaling, SVG parsing
│   ├── Connection.js      # WebSerial communication layer
│   ├── Tabs.js            # Tab navigation controller
│   ├── Console.js         # Console logging utility
│   ├── UI.js              # Status badge & button state helpers
│   └── styles.css         # Design system (dark slate theme)
│
├── UrumiCam/              # Vision system (Python/Flask, port 5000)
│   ├── server/app.py      # Flask backend — camera, ArUco, edge detection
│   ├── static/            # Frontend assets for UrumiCam UI
│   ├── config.json        # Frame & calibration configuration
│   └── requirements.txt   # Python dependencies
│
├── start.js               # Unified launcher (Node + Python)
└── package.json
```

---

## Features

### Trajectory Engine
- **Segmented trajectory generation** — paths are subdivided into precise, equal-length segments (configurable resolution down to 0.1 mm).
- **Bezier kinematics** — cubic and quadratic Bézier curves are flattened into physical segments with normalised velocity vectors ensuring constant feedrate.
- **Tangential knife support** — automatic rotational angle calculation with Z-lift/plunge sequences on sharp corners (configurable angle threshold).
- **Absolute boundary clamping** — all generated machine coordinates are rigidly constrained to the physical bed dimensions (`bedW`, `bedH`) to prevent hardware collisions.
- **Comprehensive SVG primitive parsing** — native geometry conversion for `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`, `<polyline>`, and `<polygon>` elements.
- **Multi-axis relative step output** — all commands are emitted as signed relative steps with synchronised Steps-Per-Second values, ensuring perfect multi-motor arrival.
- **Per-axis configuration** — independent RS485 IDs, motor steps/rev, microstepping, and mm/rev for X, Y, Z, and A (rotary) axes.

### Drawing Editor (Draw Tab)
A full interactive vector drawing surface mapped to the physical cutter bed coordinate space.

| Tool | Shortcut | Description |
|:---|:---:|:---|
| **Select** | `V` | Click to select shapes, drag to move, `Delete` to remove |
| **Pencil** | `P` | Freehand polyline |
| **Line** | `L` | Two-point straight line |
| **Rectangle** | `R` | Axis-aligned rectangle |
| **Ellipse** | `E` | Drag-to-size ellipse |
| **Bezier** | `B` | Cubic Bézier curve (4-click: start → control 1 → control 2 → end) |
| **Eraser** | `X` | Touch-to-delete any shape |

- **50 mm reference grid** with dashed bed boundary and corner labels.
- **Stroke width** and **eraser radius** configurable in millimetres.
- **Undo** (`Ctrl+Z`) and **Clear All** controls.
- **Import SVG** — Load an existing vector file directly onto the drawing canvas to edit, manipulate, or selectively erase elements before exporting.
- **Send to Cutter** — exports all shapes as an SVG, pipes it through the `SvgConverter` trajectory compiler, and switches to the Trajectory Preview.
- All shapes (including rectangles, ellipses, and Bézier curves) are exported as `<path>` elements for full parser compatibility.

### UrumiCam Integration
- **Real-time SVG push** — workpiece boundary contours detected by UrumiCam are pushed directly into CutterProd over HTTP and auto-compiled to trajectory data.
- **Two scanning modes:**
  - *Method 1* — Live gantry-mounted camera with ArUco marker calibration and mosaic stitching.
  - *Method 2* — Mobile phone photo with perspective rectification (homography) and Canny edge detection.
- The UrumiCam UI opens in its own tab via the **UrumiCam** link in the toolbar.

### Machine Control
- **WebSerial communication** — direct USB connection to the Raspberry Pi Pico, no drivers or backend required.
- **Smart buffer management** — handles `nope` (buffer full) / `ready` flow control for seamless large-file streaming.
- **Safe retract on restart** — if a job is interrupted, a vertical Z-lift is injected before the next start to prevent drag crashes.
- **Jog control modal** — D-pad for X/Y, vertical buttons for Z, rotary buttons for A-axis.
  - Keyboard: `Arrow keys` (X/Y), `Page Up/Down` (Z), `[ ]` (A-axis), `Home` (zero all).
- **Simulation mode** — toggle to preview job execution without a connected machine.

### Visualiser
- **Trajectory Preview** — rendered on HTML5 Canvas with coordinate mapping from machine-mm (Y-up) to screen-px (Y-down).
  - Orange dots: cutting sample points. Dashed grey: travel moves. Emerald green: executed segments during simulation.
  - Gantry footprint overlay tracks the current tool position.
- **SVG Preview** — raw browser rendering of the loaded SVG.
- **Data Editor** — direct text editing of the trajectory command stream.

---

## Setup

### Prerequisites
- **Node.js** (v16+)
- **Python 3.9+** (for UrumiCam backend)
- **pip** packages: `pip install -r UrumiCam/requirements.txt`

### Quick Start

```bash
# Clone the repository
git clone https://github.com/icebelly29/CutterProd.git
cd CutterProd

# Launch both servers with one command
npm start
```

This runs `node start.js` which:
1. Starts the CutterProd static frontend via `npx serve src` (port 3000).
2. Starts the UrumiCam Flask backend via `python server/app.py` (port 5000, `--mock` mode on Windows).

Open **http://localhost:3000** in a Chromium-based browser (Chrome, Edge — required for WebSerial).

---

## Workflow

1. **Connect** — Plug in the Pico, click **Connect Serial**, select the COM port.
2. **Configure** — Open **Settings** to set bed dimensions, axis parameters, segment length, and cutting speed.
3. **Load** — Drag-and-drop an `.svg` file, or use the **Draw** tab to create shapes directly.
4. **Scan** *(optional)* — Open UrumiCam, capture a workpiece photo, and push the detected edge SVG to CutterProd.
5. **Preview** — Review the trajectory in the **Trajectory Preview** tab. Orange dots show each motor step.
6. **Cut** — Click **Start**. The app streams commands line-by-line, managing buffer flow automatically.

---

## Output Format

The first line is always `enable all 1` to engage stepper drivers. All subsequent lines:

```
move <count> <RS485 IDs...> <steps...> <SPS...>
```

| Field | Description |
|:---|:---|
| `count` | Number of motors moving in this segment |
| `RS485 IDs` | Space-separated motor IDs (e.g. `3 2 1 4` for X, Y, Z, A) |
| `steps` | Signed relative step deltas for each motor |
| `SPS` | Steps-Per-Second velocity for each motor, calculated for synchronous arrival |

**Example:** `move 3 3 2 1 1600 1600 6400 4800 4800 24000`

---

## Commands Reference

| Command | Description | Format |
|:---|:---|:---|
| `move` | Trajectory segment / manual jog | `move <count> <ids…> <steps…> <sps…>` |
| `home` | Return all axes to zero | `home` |
| `enable` | Enable or disable motors | `enable all <0\|1>` |
| `ping` | Query motor status | `ping <id>` |

---

## Keyboard Shortcuts

### Draw Tab
| Key | Action |
|:---:|:---|
| `V` | Select tool |
| `P` | Pencil tool |
| `L` | Line tool |
| `R` | Rectangle tool |
| `E` | Ellipse tool |
| `B` | Bezier curve tool |
| `X` | Eraser tool |
| `Ctrl+Z` | Undo last shape |
| `Delete` | Delete selected shape |
| `Escape` | Cancel current operation / deselect |

### Jog Modal
| Key | Action |
|:---:|:---|
| `←→↑↓` | Jog X / Y |
| `PgUp / PgDn` | Jog Z |
| `[ / ]` | Rotate A-axis |
| `Home` | Home all axes |

---

## License

ISC
