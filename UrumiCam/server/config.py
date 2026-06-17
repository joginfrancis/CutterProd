"""
============================================================================
                    URUMICAM — SYSTEM CONFIGURATION
============================================================================

Centralized configuration management. All tunables live here, loaded from 
and persisted to config.json. Default values match the system specification.

============================================================================
"""

import json
import os
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_FILE = BASE_DIR / "config.json"
SCANS_DIR = BASE_DIR / "scans"

# ── Default Configuration ──────────────────────────────────────────────────

DEFAULTS = {
    # --- Motor Configuration ---
    "motor_x_rs485_id": 3,
    "motor_y_rs485_id": 2,
    "steps_per_mm_x": 160.0,    # 200 steps/rev * 32 microsteps / 40 mm/rev
    "steps_per_mm_y": 160.0,
    "max_sps": 30000,
    "max_steps_per_command": 30000,

    # --- UART Configuration ---
    "uart_port": "/dev/ttyAMA0",
    "uart_baudrate": 115200,

    # --- GPIO Configuration ---
    "gpio_quiescence_pin": 17,   # Pi 4 BCM pin for quiescence input

    # --- Camera Configuration ---
    "camera_resolution": [4056, 3040],  # HQ Camera native resolution
    "camera_capture_resolution": [2028, 1520],  # Working resolution (half native)
    "camera_jpeg_quality": 95,
    "camera_preview_resolution": [640, 480],
    "camera_preview_fps": 15,

    # --- Scan Configuration ---
    "tile_fov_x_mm": 10.0,      # Physical FOV of macro lens at fixed Z
    "tile_fov_y_mm": 7.5,       # Measured during calibration
    "overlap_fraction": 0.28,    # 28% overlap between adjacent tiles
    "scan_output_dir": str(SCANS_DIR),

    # --- ROI Detection ---
    "roi_margin_mm": 5.0,       # Expand ROI bounding box by this amount
    "min_contour_area_px": 500, # Minimum contour area for workpiece detection
    "edge_noise_floor": 0.1,    # Fraction of max edge energy for peak detection
    "multi_body_mode": False,   # False = single bounding box, True = per-contour

    # --- Focus Quality ---
    "min_focus_variance": 100.0,    # Laplacian variance threshold
    "focus_baseline": 0.0,          # Set during calibration
    "focus_threshold_ratio": 0.6,   # MIN_FOCUS_VARIANCE = FOCUS_BASELINE * ratio
    "max_focus_retries": 3,

    # --- Quiescence (Pico 2 side, stored here for reference/config push) ---
    "accel_rms_threshold": 0.05,    # g-force RMS threshold
    "quiescence_window_ms": 50,     # Sustained window for quiescence
    "base_dwell_ms": 200,           # Fallback dwell (no accelerometer)
    "dwell_per_step_coeff": 0.01,   # Fallback dwell coefficient

    # --- Stitching ---
    "min_match_count": 12,      # Minimum keypoint matches for feature-based alignment
    "stitch_method": "orb",     # "orb" or "sift"

    # --- Calibration ---
    "pixels_per_step_x": 1.0,  # Set during calibration
    "pixels_per_step_y": 1.0,

    # --- Soft Limits (steps) ---
    "x_max_steps": 200000,
    "y_max_steps": 200000,
}


class Config:
    """
    Configuration manager. Loads from config.json on init,
    falls back to DEFAULTS for any missing keys.
    """

    def __init__(self, config_path=None):
        self._path = Path(config_path) if config_path else CONFIG_FILE
        self._data = dict(DEFAULTS)
        self.load()

    def load(self):
        """Load configuration from JSON file, merging with defaults."""
        if self._path.exists():
            try:
                with open(self._path, "r") as f:
                    stored = json.load(f)
                self._data.update(stored)
            except (json.JSONDecodeError, IOError) as e:
                print(f"[CONFIG] Warning: Could not load {self._path}: {e}")
                print("[CONFIG] Using defaults.")

    def save(self):
        """Persist current configuration to JSON file."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._path, "w") as f:
            json.dump(self._data, f, indent=2)

    def get(self, key, default=None):
        """Get a configuration value."""
        return self._data.get(key, default)

    def set(self, key, value):
        """Set a configuration value and persist."""
        self._data[key] = value
        self.save()

    def update(self, updates: dict):
        """Update multiple configuration values and persist."""
        self._data.update(updates)
        self.save()

    def to_dict(self):
        """Return full configuration as a dictionary."""
        return dict(self._data)

    def __getattr__(self, name):
        """Allow attribute-style access: config.overlap_fraction"""
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._data:
            return self._data[name]
        raise AttributeError(f"Config has no key '{name}'")

    def __repr__(self):
        return f"Config({self._path})"


# ── Singleton Instance ─────────────────────────────────────────────────────

config = Config()
