"""
============================================================================
                    URUMICAM — STATE MACHINE ENGINE
============================================================================

Core sequential state machine implementing the scan lifecycle.

States:
    IDLE → ROI_SCAN → PLAN → TARGETING → SETTLING → CAPTURING → 
    PROCESSING → TILE_COMPLETE / TILE_FAILED → STITCH → COMPLETE

Hard Rules Enforced:
    - GPIO gate = hard capture gate (no bypass)
    - Motor stall = hard halt (never continue with corrupted coords)
    - Focus fail = soft retry (configurable retries, then mark and continue)
    - No Z movement (only X/Y motor IDs emitted)

============================================================================
"""

import time
import threading
import logging
from enum import Enum

logger = logging.getLogger("urumicam.state_machine")


class ScanState(str, Enum):
    IDLE = "idle"
    ROI_SCAN = "roi_scan"
    PLAN = "plan"
    TARGETING = "targeting"
    SETTLING = "settling"
    CAPTURING = "capturing"
    PROCESSING = "processing"
    TILE_COMPLETE = "tile_complete"
    TILE_FAILED = "tile_failed"
    STITCH = "stitch"
    COMPLETE = "complete"


class ScanEngine:
    """
    Core scan engine implementing the state machine.
    
    Coordinates all subsystems: UART, GPIO, Camera, ROI detection,
    tile planning, focus checking, stitching, and file I/O.
    """

    def __init__(self, config, uart, gpio, camera, roi_detector,
                 tile_planner, focus_checker, stitcher, scan_io):
        self.config = config
        self.uart = uart
        self.gpio = gpio
        self.camera = camera
        self.roi = roi_detector
        self.planner = tile_planner
        self.focus = focus_checker
        self.stitcher = stitcher
        self.io = scan_io

        # State
        self.state = ScanState.IDLE
        self.tiles = []
        self.current_tile_index = 0
        self.scan_dir = None
        self.roi_data = None
        self.scan_thread = None
        self._abort_flag = False
        self._lock = threading.Lock()

        # Event callbacks (set by app.py for WebSocket emission)
        self.on_state_change = None
        self.on_tile_update = None
        self.on_log = None
        self.on_progress = None
        self.on_scan_complete = None
        self.on_roi_detected = None
        self.on_error = None

        # Wire UART callbacks
        self._arrival_event = threading.Event()
        self._arrived_pos = (0, 0)
        self._stall_flag = False
        self._stall_axis = None

        self.uart.on_arrived = self._on_arrived
        self.uart.on_homed = self._on_homed
        self.uart.on_stall = self._on_stall
        self.uart.on_bounds = self._on_bounds
        self.uart.on_message = self._on_uart_message

    # ── State Transitions ──────────────────────────────────────────────────

    def _set_state(self, new_state):
        old = self.state
        self.state = new_state
        logger.info(f"[SM] {old.value} → {new_state.value}")
        if self.on_state_change:
            self.on_state_change(new_state.value, old.value)

    def _emit_log(self, message, level="info"):
        logger.info(f"[SCAN] {message}")
        if self.on_log:
            self.on_log(message, level)

    # ── UART Callbacks ─────────────────────────────────────────────────────

    def _on_arrived(self, x, y):
        self._arrived_pos = (x, y)
        self._arrival_event.set()

    def _on_homed(self):
        self._emit_log("Axes homed successfully", "success")

    def _on_stall(self, axis):
        self._stall_flag = True
        self._stall_axis = axis
        self._arrival_event.set()  # Unblock wait

    def _on_bounds(self):
        self._emit_log("Move exceeds soft limits!", "error")

    def _on_uart_message(self, msg):
        if self.on_log:
            self.on_log(msg, "uart")

    # ── Scan Lifecycle ─────────────────────────────────────────────────────

    def start_scan(self, folder_name, roi_box=None):
        """Start a new scan session."""
        if self.state != ScanState.IDLE:
            self._emit_log("Cannot start: scan already in progress", "error")
            return False

        self._abort_flag = False
        self._stall_flag = False
        self.scan_dir = self.io.create_scan_folder(folder_name)

        if roi_box:
            # Manual ROI provided, skip ROI_SCAN phase
            x1 = min(roi_box['x1'], roi_box['x2'])
            y1 = min(roi_box['y1'], roi_box['y2'])
            w = abs(roi_box['x2'] - roi_box['x1'])
            h = abs(roi_box['y2'] - roi_box['y1'])
            
            self.roi_data = {
                "method": "manual_bounds",
                "success": True,
                "rois": [(x1, y1, w, h)]
            }
            self.scan_thread = threading.Thread(
                target=self._run_plan_phase, daemon=True, name="scan-engine"
            )
        else:
            # Auto-detect using camera (legacy/fallback)
            self.scan_thread = threading.Thread(
                target=self._run_roi_scan, daemon=True, name="scan-engine"
            )
            
        self.scan_thread.start()
        return True

    def abort_scan(self):
        """Abort the current scan."""
        self._abort_flag = True
        self.uart.send_abort()
        self._emit_log("SCAN ABORTED", "error")
        self._set_state(ScanState.IDLE)

    def confirm_roi(self, roi_data=None):
        """Operator confirms ROI. Proceeds to PLAN phase."""
        if roi_data:
            self.roi_data = roi_data
        self._run_plan_phase()

    def rescan_roi(self):
        """Re-run ROI detection without starting a new scan session.
        Resets state to IDLE so start_scan's guard allows re-entry,
        then re-uses the existing scan directory."""
        folder = self.scan_dir.name if self.scan_dir else "rescan"
        self._set_state(ScanState.IDLE)
        self.start_scan(folder)

    def retry_failed_tiles(self):
        """Re-run scan on FAILED_FOCUS tiles only."""
        from .tile_planner import TileStatus
        failed = [t for t in self.tiles if t.status == TileStatus.FAILED_FOCUS]
        if not failed:
            self._emit_log("No failed tiles to retry", "info")
            return

        self._emit_log(f"Retrying {len(failed)} failed tiles", "info")
        # Reset failed tiles to pending
        for tile in failed:
            tile.status = TileStatus.PENDING
            tile.focus_retries = 0
            if self.on_tile_update:
                self.on_tile_update(tile.to_dict())

        # Run scan on just these tiles
        self.scan_thread = threading.Thread(
            target=self._run_tile_scan, args=(failed,),
            daemon=True, name="scan-retry"
        )
        self.scan_thread.start()

    # ── Phase Implementations ──────────────────────────────────────────────

    def _run_roi_scan(self):
        """ROI_SCAN phase: capture overview frame and detect workpiece."""
        self._set_state(ScanState.ROI_SCAN)
        self._emit_log("Capturing overview frame for ROI detection...")

        # Move to bed center overview position
        # (In practice, this would be a configured position)
        # For now, capture from current position
        frame = self.camera.capture_frame()
        if frame is None:
            self._emit_log("Failed to capture overview frame", "error")
            self._set_state(ScanState.IDLE)
            return

        # Run ROI detection
        multi_body = self.config.get("multi_body_mode", False)
        result = self.roi.detect(frame, multi_body=multi_body)

        if not result["success"]:
            self._emit_log(result.get("message", "ROI detection failed"), "error")
            if self.on_error:
                self.on_error("roi_failed", result.get("message", ""))
            self._set_state(ScanState.IDLE)
            return

        self.roi_data = result
        self._emit_log(
            f"ROI detected ({result['method']}): "
            f"{len(result['rois'])} region(s)", "success"
        )

        # Notify UI for confirmation
        if self.on_roi_detected:
            self.on_roi_detected(result)

        # Wait for operator confirmation (UI calls confirm_roi())

    def _run_plan_phase(self):
        """PLAN phase: compute tile grid from confirmed ROI."""
        self._set_state(ScanState.PLAN)

        if not self.roi_data or not self.roi_data.get("rois"):
            self._emit_log("No ROI data for planning", "error")
            self._set_state(ScanState.IDLE)
            return

        self.tiles = []
        for roi_box in self.roi_data["rois"]:
            x, y, w, h = roi_box
            grid = self.planner.compute_grid(x, y, w, h)
            self.tiles.extend(grid)

        total = len(self.tiles)
        self._emit_log(f"Tile grid computed: {total} tiles", "success")

        if self.on_progress:
            self.on_progress(0, total)

        # Notify UI with full tile grid
        if self.on_tile_update:
            for tile in self.tiles:
                self.on_tile_update(tile.to_dict())

        # Write initial manifest
        self.io.write_manifest(
            self.tiles,
            self.config.to_dict(),
            self.roi_data,
            self.scan_dir
        )

        # Start scanning
        self.scan_thread = threading.Thread(
            target=self._run_tile_scan, args=(self.tiles,),
            daemon=True, name="scan-tiles"
        )
        self.scan_thread.start()

    def _run_tile_scan(self, tiles):
        """Scan a list of tiles in order."""
        from .tile_planner import TileStatus

        total = len([t for t in self.tiles if t.status != TileStatus.COMPLETE])
        completed = sum(1 for t in self.tiles if t.status == TileStatus.COMPLETE)
        max_retries = self.config.get("max_focus_retries", 3)

        for tile in tiles:
            if self._abort_flag:
                break

            if tile.status == TileStatus.COMPLETE:
                continue

            # ── TARGETING ──
            self._set_state(ScanState.TARGETING)
            tile.status = TileStatus.TARGETING
            if self.on_tile_update:
                self.on_tile_update(tile.to_dict())

            self._emit_log(
                f"Targeting tile ({tile.row},{tile.col}) → "
                f"({tile.center_x_steps}, {tile.center_y_steps}) steps"
            )

            # Send move command — reset quiescence first so settling is fresh
            self._arrival_event.clear()
            self._stall_flag = False
            self.gpio.reset()
            self.uart.send_move_to(tile.center_x_steps, tile.center_y_steps)

            # Wait for ACK_ARRIVED
            arrived = self._arrival_event.wait(timeout=30)

            if self._stall_flag:
                # ── FAILED_MOTOR — HARD HALT ──
                self._emit_log(
                    f"MOTOR STALL on {self._stall_axis}! HARD HALT.", "error"
                )
                tile.status = TileStatus.FAILED_MOTOR
                if self.on_tile_update:
                    self.on_tile_update(tile.to_dict())

                # Abort, home, and halt
                self.uart.send_abort()
                self.uart.send_home()

                # Mark all remaining tiles as unvisited
                for t in tiles:
                    if t.status not in (TileStatus.COMPLETE, TileStatus.FAILED_MOTOR):
                        t.status = TileStatus.PENDING

                if self.on_error:
                    self.on_error("motor_stall", self._stall_axis)

                self._set_state(ScanState.IDLE)
                return

            if not arrived:
                self._emit_log("Move timeout — no ACK_ARRIVED", "error")
                continue

            # ── SETTLING ──
            self._set_state(ScanState.SETTLING)
            tile.status = TileStatus.SETTLING
            if self.on_tile_update:
                self.on_tile_update(tile.to_dict())

            # HARD GATE: Wait for GPIO quiescence
            settled = self.gpio.wait_for_quiescence(timeout=10)
            if not settled:
                self._emit_log("Quiescence timeout", "warning")
                # Continue anyway if in mock mode, otherwise retry
                if not self.gpio.mock:
                    continue

            # ── CAPTURING ──
            # HARD RULE: Camera fires ONLY when GPIO is HIGH
            if not self.gpio.is_quiescent():
                self._emit_log("GPIO gate not HIGH — capture blocked", "error")
                continue

            self._set_state(ScanState.CAPTURING)
            tile.status = TileStatus.CAPTURING
            if self.on_tile_update:
                self.on_tile_update(tile.to_dict())

            tile.capture_timestamp = time.strftime("%Y-%m-%dT%H:%M:%S")

            # Capture with retry loop for focus
            capture_ok = False
            for retry in range(max_retries + 1):
                frame = self.camera.capture_frame()
                if frame is None:
                    self._emit_log("Frame capture failed", "error")
                    continue

                # ── PROCESSING ──
                self._set_state(ScanState.PROCESSING)

                # Focus quality check
                passed, variance = self.focus.check(frame)
                tile.laplacian_variance = variance

                if passed:
                    # Save tile image + JSON sidecar
                    tile.status = TileStatus.COMPLETE
                    img_path, json_path = self.io.save_tile(
                        tile, frame, self.scan_dir
                    )

                    if img_path:
                        capture_ok = True
                        break
                else:
                    tile.focus_retries = retry + 1
                    if retry < max_retries:
                        self._emit_log(
                            f"Focus retry {retry + 1}/{max_retries} "
                            f"(variance={variance:.1f})", "warning"
                        )
                        time.sleep(0.5)  # Brief delay before retry

            if capture_ok:
                # ── TILE_COMPLETE ──
                self._set_state(ScanState.TILE_COMPLETE)
                completed += 1
                self._emit_log(
                    f"Tile ({tile.row},{tile.col}) complete "
                    f"[{completed}/{len(self.tiles)}]", "success"
                )
            else:
                # ── TILE_FAILED (focus) ──
                tile.status = TileStatus.FAILED_FOCUS
                self._set_state(ScanState.TILE_FAILED)
                self._emit_log(
                    f"Tile ({tile.row},{tile.col}) FAILED_FOCUS "
                    f"after {max_retries} retries", "warning"
                )

            if self.on_tile_update:
                self.on_tile_update(tile.to_dict())
            if self.on_progress:
                self.on_progress(completed, len(self.tiles))

        # ── Post-scan ──
        if not self._abort_flag:
            self._run_stitch_phase()

    def _run_stitch_phase(self):
        """STITCH phase: assemble mosaic from completed tiles."""
        self._set_state(ScanState.STITCH)
        self._emit_log("Starting mosaic stitching...")

        mosaic_path = self.stitcher.stitch(self.tiles, self.scan_dir)
        mosaic_edges_path = None
        
        if mosaic_path and os.path.exists(mosaic_path):
            try:
                import cv2
                import numpy as np
                img = cv2.imread(mosaic_path)
                h_px, w_px = img.shape[:2]
                gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                blurred = cv2.bilateralFilter(gray, 9, 75, 75)
                edges = cv2.Canny(blurred, 30, 90)
                contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                
                edge_overlay = np.zeros((h_px, w_px, 4), dtype=np.uint8)
                cv2.drawContours(edge_overlay, contours, -1, (255, 100, 180, 80), 4, cv2.LINE_AA)
                cv2.drawContours(edge_overlay, contours, -1, (255, 100, 180, 255), 2, cv2.LINE_AA)
                
                edges_filename = os.path.basename(mosaic_path).replace(".jpg", "_edges.png")
                edges_abs_path = os.path.join(self.scan_dir, edges_filename)
                cv2.imwrite(edges_abs_path, edge_overlay)
                
                import os
                mosaic_edges_path = os.path.relpath(edges_abs_path, start=os.getcwd())
            except Exception as e:
                self._emit_log(f"Edge detection failed on mosaic: {e}", "warning")

        # Write final manifest
        self.io.write_manifest(
            self.tiles,
            self.config.to_dict(),
            self.roi_data,
            self.scan_dir
        )

        # ── COMPLETE ──
        self._set_state(ScanState.COMPLETE)

        from .tile_planner import TileStatus
        completed = sum(1 for t in self.tiles if t.status == TileStatus.COMPLETE)
        failed = sum(1 for t in self.tiles if t.status == TileStatus.FAILED_FOCUS)

        self._emit_log(
            f"Scan complete: {completed} tiles captured, "
            f"{failed} failed", "success"
        )

        if self.on_scan_complete:
            self.on_scan_complete({
                "total": len(self.tiles),
                "completed": completed,
                "failed_focus": failed,
                "mosaic_path": mosaic_path,
                "mosaic_edges_path": mosaic_edges_path,
                "scan_dir": str(self.scan_dir),
            })

    # ── Public API ─────────────────────────────────────────────────────────

    def get_status(self):
        """Return current scan status for UI."""
        from .tile_planner import TileStatus

        completed = sum(1 for t in self.tiles if t.status == TileStatus.COMPLETE)
        return {
            "state": self.state.value,
            "total_tiles": len(self.tiles),
            "completed_tiles": completed,
            "current_tile": self.current_tile_index,
            "scan_dir": str(self.scan_dir) if self.scan_dir else None,
        }

    def reset(self):
        """Reset engine to IDLE for a new scan."""
        self._abort_flag = False
        self._stall_flag = False
        self.tiles = []
        self.current_tile_index = 0
        self.roi_data = None
        self.scan_dir = None
        self._set_state(ScanState.IDLE)
