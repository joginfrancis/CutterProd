"""
============================================================================
                    URUMICAM — TILE GRID PLANNER
============================================================================

Computes tile grids from ROI bounding boxes with configurable overlap.
Generates bidirectional snake raster scan order.

============================================================================
"""

import math
import logging
from enum import Enum

logger = logging.getLogger("urumicam.planner")


class TileStatus(str, Enum):
    PENDING = "pending"
    TARGETING = "targeting"
    SETTLING = "settling"
    CAPTURING = "capturing"
    COMPLETE = "complete"
    FAILED_FOCUS = "failed_focus"
    FAILED_MOTOR = "failed_motor"


class Tile:
    """Represents a single tile in the scan grid."""

    def __init__(self, row, col, center_x_mm, center_y_mm, steps_per_mm_x, steps_per_mm_y):
        self.row = row
        self.col = col
        self.center_x_mm = center_x_mm
        self.center_y_mm = center_y_mm
        self.center_x_steps = int(round(center_x_mm * steps_per_mm_x))
        self.center_y_steps = int(round(center_y_mm * steps_per_mm_y))
        self.status = TileStatus.PENDING
        self.image_path = None
        self.json_path = None
        self.laplacian_variance = None
        self.capture_timestamp = None
        self.focus_retries = 0

    def to_dict(self):
        return {
            "row": self.row,
            "col": self.col,
            "center_x_mm": round(self.center_x_mm, 3),
            "center_y_mm": round(self.center_y_mm, 3),
            "center_x_steps": self.center_x_steps,
            "center_y_steps": self.center_y_steps,
            "status": self.status.value,
            "image_path": self.image_path,
            "laplacian_variance": self.laplacian_variance,
            "capture_timestamp": self.capture_timestamp,
            "focus_retries": self.focus_retries,
        }


class TilePlanner:
    """
    Computes tile grid from ROI bounding box.
    
    Grid formulas from spec:
        tile_step_x_mm = tile_fov_x_mm * (1 - overlap_fraction)
        tile_step_y_mm = tile_fov_y_mm * (1 - overlap_fraction)
        cols = ceil(roi_width_mm / tile_step_x_mm) + 1
        rows = ceil(roi_height_mm / tile_step_y_mm) + 1
    
    Scan order: bidirectional snake raster
        (left→right on even rows, right→left on odd rows)
    """

    def __init__(self, config):
        self.tile_fov_x_mm = config.get("tile_fov_x_mm", 10.0)
        self.tile_fov_y_mm = config.get("tile_fov_y_mm", 7.5)
        self.overlap_fraction = config.get("overlap_fraction", 0.28)
        self.steps_per_mm_x = config.get("steps_per_mm_x", 160.0)
        self.steps_per_mm_y = config.get("steps_per_mm_y", 160.0)

    def compute_grid(self, roi_x_mm, roi_y_mm, roi_width_mm, roi_height_mm):
        """
        Compute the tile grid for a given ROI bounding box.
        
        Args:
            roi_x_mm: ROI origin X (mm)
            roi_y_mm: ROI origin Y (mm)
            roi_width_mm: ROI width (mm)
            roi_height_mm: ROI height (mm)
            
        Returns:
            list[Tile]: Tiles in bidirectional snake raster order.
        """
        tile_step_x = self.tile_fov_x_mm * (1.0 - self.overlap_fraction)
        tile_step_y = self.tile_fov_y_mm * (1.0 - self.overlap_fraction)

        cols = math.ceil(roi_width_mm / tile_step_x) + 1
        rows = math.ceil(roi_height_mm / tile_step_y) + 1

        logger.info(
            f"[PLANNER] Grid: {rows}x{cols} = {rows * cols} tiles, "
            f"step=({tile_step_x:.2f}, {tile_step_y:.2f})mm, "
            f"overlap={self.overlap_fraction * 100:.0f}%"
        )

        tiles = []
        for row in range(rows):
            # Snake raster: even rows L→R, odd rows R→L
            col_range = range(cols) if row % 2 == 0 else range(cols - 1, -1, -1)

            for col in col_range:
                cx = roi_x_mm + col * tile_step_x + self.tile_fov_x_mm / 2
                cy = roi_y_mm + row * tile_step_y + self.tile_fov_y_mm / 2

                tile = Tile(
                    row=row, col=col,
                    center_x_mm=cx, center_y_mm=cy,
                    steps_per_mm_x=self.steps_per_mm_x,
                    steps_per_mm_y=self.steps_per_mm_y,
                )
                tiles.append(tile)

        return tiles

    def compute_multi_body_grids(self, roi_list):
        """
        Compute separate tile grids for multiple ROI bounding boxes.
        
        Args:
            roi_list: List of (x_mm, y_mm, width_mm, height_mm) tuples.
            
        Returns:
            list[list[Tile]]: One tile list per ROI.
        """
        grids = []
        for roi in roi_list:
            grid = self.compute_grid(*roi)
            grids.append(grid)
        return grids

    def get_grid_info(self, roi_width_mm, roi_height_mm):
        """
        Get grid dimensions without generating tiles.
        
        Returns:
            dict with rows, cols, total_tiles, tile_step_x, tile_step_y
        """
        tile_step_x = self.tile_fov_x_mm * (1.0 - self.overlap_fraction)
        tile_step_y = self.tile_fov_y_mm * (1.0 - self.overlap_fraction)
        cols = math.ceil(roi_width_mm / tile_step_x) + 1
        rows = math.ceil(roi_height_mm / tile_step_y) + 1

        return {
            "rows": rows,
            "cols": cols,
            "total_tiles": rows * cols,
            "tile_step_x_mm": round(tile_step_x, 3),
            "tile_step_y_mm": round(tile_step_y, 3),
            "fov_x_mm": self.tile_fov_x_mm,
            "fov_y_mm": self.tile_fov_y_mm,
            "overlap": self.overlap_fraction,
        }
