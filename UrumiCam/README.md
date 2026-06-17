# UrumiCam — Macro Gantry Scanner

A production-grade stop-and-shoot raster scanning system for gantry-based cutting platforms. Captures high-resolution tile images and stitches them into a full-bed mosaic.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Raspberry Pi 4                      │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐ │
│  │ Flask +   │  │ OpenCV   │  │ Web UI            │ │
│  │ SocketIO  │  │ Vision   │  │ (Browser)         │ │
│  │ Server    │  │ Pipeline │  │                   │ │
│  └────┬──────┘  └────┬─────┘  └───────────────────┘ │
│       │              │                               │
│  ┌────┴──────────────┴──────┐                       │
│  │    State Machine Engine   │                       │
│  └──────────┬───────────────┘                       │
│             │ USB Serial (/dev/ttyACM0)              │
└─────────────┼──────────────────────────────────────┘
              │ ASCII text commands
              │ ("move", "stop", "enable", "ping")
┌─────────────┼──────────────────────────────────────┐
│  ┌──────────┴───────────┐                          │
│  │  Raspberry Pi Pico 2  │  (Urumi-Fw)             │
│  │  Core 0: USB parser   │                          │
│  │  Core 1: RS485 master │                          │
│  └──────────┬────────────┘                          │
│             │ RS485 (115200 baud)                    │
│    ┌────────┴────────┐                              │
│    │ ATtiny3224 nodes │  (one per stepper axis)     │
│    │ Node X, Node Y   │                              │
│    └─────────────────┘                              │
└─────────────────────────────────────────────────────┘
```

> **Note:** The Pico 2 runs the existing **Urumi-Fw** firmware unmodified.
> UrumiCam talks to it via USB serial using the native ASCII command protocol.

## Quick Start

### Development (Windows — Mock Mode)

```bash
cd UrumiCam
pip install -r requirements.txt
python server/app.py --mock --port 5000
```

Open `http://localhost:5000` in your browser.

### Production (Raspberry Pi 4)

```bash
# 1. Install dependencies
sudo apt update
sudo apt install python3-venv rpicam-apps

# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 2. Flash the Pico 2 with Urumi-Fw (PlatformIO)
#    See: https://github.com/your-org/Urumi-Fw
#    Connect Pico via USB, then:
#    pio run -e RPiPico2 --target upload

# 3. Run server (Pico must be connected via USB before starting)
# Note: Ensure venv is active (source venv/bin/activate) before running
python server/app.py
```

## Project Structure

```
UrumiCam/
├── server/                 # Python backend (Pi 4)
│   ├── app.py              # Flask + SocketIO server
│   ├── state_machine.py    # Core scan state machine
│   ├── uart_comm.py        # USB serial → Pico 2 communication
│   ├── gpio_gate.py        # Software quiescence gate
│   ├── camera.py           # rpicam-based capture
│   ├── roi_detector.py     # Legacy wrapper redirecting to method1
│   ├── tile_planner.py     # Tile grid computation
│   ├── quality.py          # Focus quality (Laplacian variance)
│   ├── stitcher.py         # Mosaic stitching (ORB + fallback)
│   ├── scan_io.py          # File/folder management
│   ├── calibration.py      # Calibration routines
│   ├── config.py           # Configuration management
│   │
│   ├── method1/            # TRACK 1: Stop-and-Shoot Gantry Scanner
│   │   └── roi_detector.py # Contrast/Otsu overview ROI auto-detector
│   │
│   └── method2/            # TRACK 2: ArUco Bed Alignment Scanner
│       ├── config/         # Frame specs (small.json, medium.json, large.json)
│       └── aruco_rectifier.py # Homography solvers, lens distortion & alignment
│
├── static/                 # Web UI
│   ├── index.html          # Two-panel layout + Dual-Method workspace
│   ├── mobile.html         # Mobile portal for bed captures
│   ├── css/styles.css      # Premium dark theme & tab layouts
│   └── js/                 # UI modules
│       ├── app.js           # Main controller
│       ├── websocket.js     # Socket.IO client
│       ├── tile_grid.js     # Canvas tile renderer
│       ├── camera_feed.js   # MJPEG camera display
│       ├── state_display.js # State machine display
│       ├── log_panel.js     # Scrolling log
│       ├── calibration_ui.js # Settings panel
│       └── method2_controller.js # QR/Upload/Rectified canvas controller
│
├── config.json             # Persistent configuration
├── requirements.txt        # Python dependencies
└── scans/                  # Scan output (runtime)
```

## Communication Protocol

### Pi 4 → Pico 2 (USB Serial, 115200 baud, ASCII)

The Pico 2 runs **Urumi-Fw** and accepts plain-text commands via its USB serial port (`/dev/ttyACM0`):

| Command | Format | Description |
|---------|--------|-------------|
| `move` | `move <count> <addr...> <steps...> <sps...>` | Queue synchronized multi-axis move |
| `stop` | `stop` | Emergency stop — clears all buffers |
| `enable` | `enable <addr\|all> <0\|1>` | Enable/disable motor driver |
| `ping` | `ping <addr>` | Check if RS485 node is alive |

**Responses from Pico:**

| Response | Meaning |
|----------|---------|
| `ok` | Move segment queued successfully |
| `nope` | Ring buffer full — retry |
| `ready` | Buffer drained past low watermark — safe to resume |
| `Ping response: OK` | Node is alive |
| `Ping response: TIMEOUT` | Node not responding |

**Move command examples:**
```
# Move X axis (node 3) forward 1600 steps at 800 sps
move 1 3 1600 800

# Move X (node 3) and Y (node 2) simultaneously
move 2 3 2 1600 800 800 800

# Emergency stop
stop

# Enable all motors on startup
enable all 1
```

### RS485 Bus (Pico 2 → ATtiny3224 motor nodes)

Binary framing — handled entirely by Urumi-Fw. UrumiCam does not speak this protocol directly.

```
Frame: [SIZE] [ADDR] [CMD] [PAYLOAD...] [CRC16 LE]
SIZE = ((bytes_after_size) << 1) | 1   ← LSB always 1
```

Node addresses: **X = node 3, Y = node 2** (configured in `config.json`)

## Scan Workflow

Choose between two target alignment pipelines using the tabs at the top of the **Right Panel** camera workspace:

### Method 1: Gantry Camera (Stop-and-Shoot)

Use this method to jog the physical gantry camera over the workpiece to establish scan limits manually:

1. **Jogging**: Use the D-pad controls in the Left Panel to jog the overview camera to the workpiece's top-left corner.
2. **Top-Left Point**: Click **Set Top-Left** to register the physical coordinate `(X_TL, Y_TL)`.
3. **Bottom-Right Point**: Jog the gantry to the bottom-right corner, and click **Set Bottom-Right** to register `(X_BR, Y_BR)`.
4. **Scan**: Click **Start Scan** to trigger the scanning engine.

---

### Method 2: Mobile Photo / ArUco Bed Alignment

Use this method to automatically map coordinates visually on a high-resolution top-down perspective-corrected photo:

1. **Active Panel**: Switch to the **Method 2: Mobile Photo** tab.
2. **Scan QR Code**: A QR code appears on the screen (automatically generated based on the server's local LAN address). Scan it using your mobile phone.
3. **Open Capture Portal**: The QR code opens `http://<server-ip>:<port>/mobile.html` on your phone.
4. **Snap Bed Photo**: Place your workpiece within the designated ArUco Calibration Frame on the bed. Snap a clear photo of the bed, ensuring all **4 corner ArUco markers** are completely visible in the frame:
   * **Small Frame**: Inner Workspace 128x208mm (ArUco IDs `0, 1, 2, 3`, Outer boundaries 150x230mm)
   * **Medium Frame**: Inner Workspace 188x268mm (ArUco IDs `4, 5, 6, 7`, Outer boundaries 210x290mm)
   * **Large Frame**: Inner Workspace 248x328mm (ArUco IDs `8, 9, 10, 11`, Outer boundaries 270x350mm)
5. **Process & Warp**:
   * The phone portal uploads the photo to the server `/api/method2/upload`.
   * The server runs `ArUcoRectifier`, dynamically correcting lens perspective, resolving radial distortion, and rotating the image if captured upside down.
   * A processed, 254-DPI scaled bed image is saved to `/uploads/rectified_bed.png` and pushed back to the browser control panel via WebSocket.
6. **Auto-ROI & Edge Detection**:
   * The server runs a Canny edge-detection pipeline on the workpiece, producing a glowing neon-purple overlay of the exact workpiece boundary.
   * This is dynamically converted to a **Vector SVG**, which can be downloaded directly from the UI or toggled on the canvas.
   * Based on the boundary, an **Auto-ROI** is detected. You can click **✨ Apply Auto-ROI** to instantly snap the scanning boundaries perfectly around your object.
7. **Interactive Bounding Box (Drag-and-Drop)**:
   * You can also click and drag directly on the photo to draw manual bounds. 
   * A **neon-green scan grid preview** draws in real-time, showing exactly which tiles will be captured.
   * Coordinates in millimeters automatically update the input fields.
8. **Initiate Scan**: Click **Start Scan**. The physical gantry automatically translates over the drafted visual boundaries, showing live tiles overlaid *on top* of the workpiece photo!

### Scan States

`IDLE` → `PLAN` → `TARGETING` → `SETTLING` → `CAPTURING` → `PROCESSING` → `TILE_COMPLETE / TILE_FAILED` → `STITCH` → `COMPLETE`

## High-Fidelity Mosaic Stitching (v2)

UrumiCam incorporates a two-stage, high-fidelity sub-pixel mosaic stitching pipeline in `server/stitcher.py`:

1. **Sub-Pixel Pairwise Alignment**:
   - For every adjacent tile pair, an overlapping strip is extracted and correlated using **Fast Fourier Transform (FFT) Phase Correlation** for robust integer-level shifts.
   - Sub-pixel offsets are refined using **ORB Feature Matching** on the overlapping regions.
2. **Spanning Tree BFS Propagation**:
   - A graph-based connectivity model maps all physical overlaps.
   - A Breadth-First Search (BFS) Spanning Tree propagates offsets globally from the center of the grid, elegantly absorbing mechanical serpentine backlash and gantry alignment skews.
3. **Multi-Band Laplacian Pyramid Blending**:
   - Overlap seams are blended across a 4-level Laplacian pyramid, completely eliminating hard exposure seams and ghosting.

### Automated Datasets Detection

The stitcher automatically identifies scanned datasets by path and adapts on the fly:
* **`scan_2026-05-15`**: Identifies the 90-degree rotated physical camera mount, transposing row/column layout grids, and applying a `90_cw_flip_v` sensor transform.
* **`Stitch_GSCam`**: Automatically realigns a one-column serpentine trigger offset in Row 4 (`col = col - 1` for `y=4`), sets correct overlaps, and lowers the correlation response threshold to `0.05` to seamlessly capture clean white background margins.

### Running Stitching Tests

You can test-stitch the pre-existing GSCam scan dataset using the simplified backend-compatible runner:

```bash
python test_stitch_gscam.py
```

---

## Configuration

Edit `config.json` or use the Settings panel in the UI. Key parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `tile_fov_x_mm` | 10.0 | Tile field of view width (mm) |
| `tile_fov_y_mm` | 7.5 | Tile field of view height (mm) |
| `overlap_fraction` | 0.28 | Tile overlap (28%) |
| `max_focus_retries` | 3 | Focus failure retry count |
| `steps_per_mm_x` | 160 | X axis steps per mm |
| `steps_per_mm_y` | 160 | Y axis steps per mm |
| `motor_x_addr` | 3 | RS485 node address for X motor |
| `motor_y_addr` | 2 | RS485 node address for Y motor |

## License

Private — Fablab ICC
