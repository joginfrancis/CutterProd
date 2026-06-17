"""
============================================================================
                    URUMICAM — SCAN FILE I/O
============================================================================

File and folder management for scan output. Handles tile images, 
JSON sidecar metadata, scan manifests, and mosaic output.

HARD RULE: Every captured image MUST have a JSON sidecar.
The save_tile() method atomically writes both files.

============================================================================
"""

import json
import time
import logging
import numpy as np
from pathlib import Path


class NumpySafeEncoder(json.JSONEncoder):
    """JSON encoder that handles numpy types."""
    def default(self, obj):
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        if isinstance(obj, (np.integer,)):
            return int(obj)
        if isinstance(obj, (np.floating,)):
            return float(obj)
        if isinstance(obj, (np.bool_,)):
            return bool(obj)
        return super().default(obj)

logger = logging.getLogger("urumicam.scan_io")


class ScanIO:
    """
    Manages scan output files and folders.
    
    Directory structure:
        /scans/<foldername>/
            tile_<row>_<col>.jpg
            tile_<row>_<col>.json
            scan_manifest.json
            mosaic_<timestamp>.jpg
    """

    def __init__(self, base_dir=None):
        self.base_dir = Path(base_dir) if base_dir else Path("scans")
        self.current_scan_dir = None

    def create_scan_folder(self, folder_name):
        """
        Create a new scan output folder.
        
        Args:
            folder_name: Name for this scan session.
            
        Returns:
            Path: The created scan directory.
        """
        self.current_scan_dir = self.base_dir / folder_name
        self.current_scan_dir.mkdir(parents=True, exist_ok=True)
        logger.info(f"[IO] Scan folder: {self.current_scan_dir}")
        return self.current_scan_dir

    def save_tile(self, tile, image_data, scan_dir=None):
        """
        Save a tile image and its JSON sidecar atomically.
        
        HARD RULE: Both files must be written. Cannot write 
        image without metadata.
        
        Args:
            tile: Tile object with populated metadata
            image_data: numpy array (BGR) or bytes (JPEG)
            scan_dir: Override scan directory (optional)
            
        Returns:
            tuple: (image_path, json_path) or (None, None) on failure
        """
        scan_dir = Path(scan_dir) if scan_dir else self.current_scan_dir
        if not scan_dir:
            logger.error("[IO] No scan directory set")
            return None, None

        scan_dir.mkdir(parents=True, exist_ok=True)

        img_name = f"tile_{tile.row:03d}_{tile.col:03d}.jpg"
        json_name = f"tile_{tile.row:03d}_{tile.col:03d}.json"
        img_path = scan_dir / img_name
        json_path = scan_dir / json_name

        try:
            # Write image
            if isinstance(image_data, bytes):
                img_path.write_bytes(image_data)
            else:
                import cv2
                cv2.imwrite(str(img_path), image_data, [cv2.IMWRITE_JPEG_QUALITY, 95])

            # Write JSON sidecar
            metadata = {
                "tile_index": {"row": tile.row, "col": tile.col},
                "gantry_position": {
                    "x_steps": tile.center_x_steps,
                    "y_steps": tile.center_y_steps,
                    "x_mm": round(tile.center_x_mm, 3),
                    "y_mm": round(tile.center_y_mm, 3),
                },
                "timestamp": tile.capture_timestamp or time.strftime("%Y-%m-%dT%H:%M:%S"),
                "laplacian_variance": tile.laplacian_variance,
                "status": tile.status.value,
                "focus_retries": tile.focus_retries,
                "file_path": str(img_path),
            }

            with open(json_path, "w") as f:
                json.dump(metadata, f, indent=2, cls=NumpySafeEncoder)

            # Update tile references
            tile.image_path = str(img_path)
            tile.json_path = str(json_path)

            logger.info(f"[IO] Saved tile ({tile.row},{tile.col})")
            return str(img_path), str(json_path)

        except Exception as e:
            logger.error(f"[IO] Failed to save tile ({tile.row},{tile.col}): {e}")
            # Clean up partial writes
            img_path.unlink(missing_ok=True)
            json_path.unlink(missing_ok=True)
            return None, None

    def write_manifest(self, tiles, config_snapshot, roi_data, scan_dir=None):
        """
        Write the scan_manifest.json with full scan metadata.
        
        Args:
            tiles: List of all Tile objects
            config_snapshot: Dict of config values at scan time
            roi_data: ROI detection results
            scan_dir: Override scan directory
        """
        scan_dir = Path(scan_dir) if scan_dir else self.current_scan_dir
        if not scan_dir:
            return

        # Filter out non-serializable fields (contours are large numpy arrays)
        safe_roi = {k: v for k, v in (roi_data or {}).items() if k != "contours"}

        manifest = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "config": config_snapshot,
            "roi": safe_roi,
            "tile_count": len(tiles),
            "completed": sum(1 for t in tiles if t.status.value == "complete"),
            "failed_focus": sum(1 for t in tiles if t.status.value == "failed_focus"),
            "failed_motor": sum(1 for t in tiles if t.status.value == "failed_motor"),
            "tiles": [t.to_dict() for t in tiles],
        }

        manifest_path = scan_dir / "scan_manifest.json"
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2, cls=NumpySafeEncoder)

        logger.info(f"[IO] Manifest written: {manifest_path}")
