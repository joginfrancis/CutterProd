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
- **Bezier kinematics** — cubic and quadratic Bézier curves are flattened into physical segments with normalized velocity vectors ensuring constant feedrate.
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
- **Stroke width** and **eraser radius** configurable in millimeters.
- **Undo** (`Ctrl+Z`) and **Clear All** controls.
- **Import SVG** — Load an existing vector file directly onto the drawing canvas to edit, manipulate, or selectively erase elements before exporting.
- **Send to Cutter** — exports all shapes as an SVG, pipes it through the `SvgConverter` trajectory compiler, and switches to the Trajectory Preview.
- All shapes (including rectangles, ellipses, and Bézier curves) are exported as `<path>` elements for full parser compatibility.

### Toolpath & Cut Methods
Native support for multi-layered cut profiles. In the Draw tab or via imported SVG `data-method` attributes, shapes can be assigned specific toolpaths:
- **Thru Cut** (Blue): Plunges to the maximum configured Z depth to sever the material completely.
- **Score / Off-Base** (Purple): Partial plunge depth to slice through upper layers (e.g. stickers).
- **Crease** (Amber/Yellow): Uses a specialized blunt tool offset or shallower depth to fold without cutting.

### UrumiCam Integration & Smart Skeletonization
- **Color-Coded Trajectory Classification** — Method 2 processes rectified color bed images (`rectified_bed.png`) in parallel with binary masks. It automatically detects and classifies stroke ink colors using an HSL neighborhood voting system:
  - **Red Ink** &rarr; **Thru Cut** (Blue preview, maximum Z-depth)
  - **Blue Ink** &rarr; **Score/Off-Base** (Purple preview, medium Z-depth)
  - **Green Ink** &rarr; **Crease** (Amber/Yellow preview, shallow Z-depth)
  - **Black/Neutral Ink** &rarr; **Thru Cut** (default fallback)
- **Real-time SVG push** — workpiece boundary contours detected by UrumiCam are pushed directly into CutterProd over HTTP and auto-compiled to trajectory data.
- **Sub-Millimeter Skeletonization** — hand-drawn ink patterns are captured, adaptively thresholded (ignoring ArUco frames), and traced into precision polylines using Lingdong's `TraceSkeleton` algorithm.
- **Two scanning modes:**
  - *Method 1* — Live gantry-mounted camera with ArUco marker calibration and mosaic stitching.
  - *Method 2* — Mobile phone photo with perspective rectification (homography) and Canny edge detection.
- The UrumiCam UI opens in its own tab via the **UrumiCam** link in the toolbar.

### Machine Control & End Effectors
- **WebSerial communication** — direct USB connection to the Raspberry Pi Pico, no drivers or backend required.
- **Smart buffer management** — handles `nope` (buffer full) / `ready` flow control for seamless large-file streaming.
- **End Effector Dashboard** — Sidebar controls for immediate **Vacuum Bed** toggling and absolute **Gantry Z-Parking**.
- **Sequential Execution Pipeline** — Jobs are bundled into distinct tasks (e.g. `[Task 1: Homing]`, `[Task 2: Cutting]`, `[Task 3: Parking]`) ensuring safe z-retracts and zero-collision restarts.
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

The UI streams **Binary MicroSegments** over Web Serial.
Each trajectory segment is exactly 26 bytes and encapsulates a 4-axis synchronized move:

| Byte | Field | Description |
|:---|:---|:---|
| 0 | `magic` | Always `0xAB` |
| 1-4 | `dx` | X-axis step delta (Int32, Little Endian) |
| 5-8 | `dy` | Y-axis step delta (Int32, LE) |
| 9-12 | `dz` | Z-axis step delta (Int32, LE) |
| 13-16| `da` | A-axis step delta (Int32, LE) |
| 17-20| `interval` | Delay ticks between steps (UInt32, LE). $150MHz / rate$ |
| 21 | `flags` | Bit 0 = 1 to enable stepper output |
| 22 | `seq` | Rolling sequence number (0-255) for duplicate ACK dropping |
| 23-24| `pad` | Reserved |
| 25 | `crc8` | CRC-8 over bytes 0-24 (poly `0x8C`) |

Flow control uses Go-Back-N with a window size of 16. The Pico responds to each packet with `ACK` (`0xAA` + seq) or `NACK` (`0xBB` + reason).

---

## Commands Reference

| Command | Description | Format |
|:---|:---|:---|
| Binary Move | Main trajectory packet | 26-byte `0xAB...` |
| `setorigin` | Establish local zero | `setorigin` |
| `stop` | Emergency abort | `stop` |
| `status` | Query buffer depth | `status` |
| `enable` | Enable or disable motors | `enable all <0\|1>` |
| `ping` | Query motor status | `ping <id>` |
| `seqreset` | Reset Go-Back-N counter | `seqreset` |
| `suction` | Toggle suction fan | `suction <0\|1>` |
| `servo` | Toggle a pneumatic valve | `servo <1-6> <0\|1>` |

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

## Model Context Protocol (MCP) Server

CutterProd includes an integrated Model Context Protocol (MCP) server located in the `mcp-server/` directory. This allows AI assistants (like Claude) to connect to the CutterProd ecosystem and act as an automated CAD/CAM co-pilot.

### Features
- **`generate_parametric_svg`**: AI can procedurally generate foldable box templates with correct `crease` and `thru_cut` styling based on human-readable dimensions.
- **`convert_and_estimate_svg`**: AI can simulate physical kinematics using the native `SvgConverter` engine to estimate exact cut times and total travel distances.

### Connecting the MCP Server
To use the MCP server with an AI client, you need to add it to your client's configuration file.

#### For Antigravity
Add the following configuration to your `mcp.json` file (typically located at `C:\Users\nikhil\.gemini\antigravity\mcp.json`):

```json
{
  "mcpServers": {
    "cutterprod": {
      "command": "node",
      "args": [
        "C:/Users/nikhil/Coding/CutterProd-microseg/mcp-server/index.js"
      ]
    }
  }
}
```

#### For Claude Desktop
Add the same JSON configuration block above to your `claude_desktop_config.json` file (typically located at `%APPDATA%\Claude\claude_desktop_config.json`).

Once connected, restart your AI client (Antigravity or Claude Desktop). You can then ask it to "generate a box template" or "estimate the cut time for my SVG", and it will securely interface with your machine's trajectory pipeline!

---

## License

ISC