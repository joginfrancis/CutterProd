"""
============================================================================
                    URUMICAM — ROI DETECTION
============================================================================

Contrast-based Region of Interest detection for workpiece segmentation.
4-stage cascade: Otsu → Edge Energy → Contour Filtering → ROI Expansion.

============================================================================
"""

import logging
import numpy as np

logger = logging.getLogger("urumicam.roi")


class ROIDetector:
    """
    Detects the workpiece bounding box from a wide-context overview frame.
    
    Stage 1 — Otsu thresholding (bimodal histogram detection)
    Stage 2 — Edge energy projection (fallback for low-contrast)
    Stage 3 — Contour filtering (largest contour = workpiece)
    Stage 4 — ROI expansion + coordinate conversion
    """

    def __init__(self, config):
        self.roi_margin_mm = config.get("roi_margin_mm", 5.0)
        self.min_area_px = config.get("min_contour_area_px", 500)
        self.noise_floor = config.get("edge_noise_floor", 0.1)
        self.pixels_per_step_x = config.get("pixels_per_step_x", 1.0)
        self.pixels_per_step_y = config.get("pixels_per_step_y", 1.0)
        self.steps_per_mm_x = config.get("steps_per_mm_x", 160.0)
        self.steps_per_mm_y = config.get("steps_per_mm_y", 160.0)

    def detect(self, frame, multi_body=False):
        """
        Run the 4-stage ROI detection pipeline.
        
        Args:
            frame: BGR numpy array from camera
            multi_body: If True, return per-contour ROIs
            
        Returns:
            dict with:
                success: bool
                rois: list of (x_mm, y_mm, w_mm, h_mm) tuples
                rois_px: list of (x, y, w, h) in pixels
                method: str describing which stage succeeded
                contours: list of contour arrays (for visualization)
        """
        import cv2

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape

        # Stage 1 — Otsu thresholding
        mask, otsu_ok = self._stage1_otsu(gray)

        if not otsu_ok:
            # Stage 2 — Edge energy projection fallback
            bbox_px = self._stage2_edge_energy(gray)
            if bbox_px is None:
                return {
                    "success": False,
                    "rois": [],
                    "rois_px": [],
                    "method": "failed",
                    "contours": [],
                    "message": "No workpiece detected. Please enter ROI manually."
                }
            # Convert edge-detected bbox to a mask for Stage 3
            x, y, bw, bh = bbox_px
            mask = np.zeros_like(gray)
            mask[y:y+bh, x:x+bw] = 255

        # Stage 3 — Contour filtering
        contours_result = self._stage3_contours(mask, multi_body)

        if not contours_result:
            return {
                "success": False,
                "rois": [],
                "rois_px": [],
                "method": "failed",
                "contours": [],
                "message": "No valid contours found."
            }

        # Stage 4 — ROI expansion and coordinate conversion
        rois_px = []
        rois_mm = []
        for contour in contours_result:
            x, y, bw, bh = cv2.boundingRect(contour)
            rois_px.append((x, y, bw, bh))

            # Convert pixel coords to mm via steps
            margin_steps_x = self.roi_margin_mm * self.steps_per_mm_x
            margin_steps_y = self.roi_margin_mm * self.steps_per_mm_y
            margin_px_x = margin_steps_x * self.pixels_per_step_x
            margin_px_y = margin_steps_y * self.pixels_per_step_y

            # Expand and convert to mm
            ex = max(0, x - margin_px_x)
            ey = max(0, y - margin_px_y)
            ew = min(w - ex, bw + 2 * margin_px_x)
            eh = min(h - ey, bh + 2 * margin_px_y)

            mm_x = ex / (self.pixels_per_step_x * self.steps_per_mm_x)
            mm_y = ey / (self.pixels_per_step_y * self.steps_per_mm_y)
            mm_w = ew / (self.pixels_per_step_x * self.steps_per_mm_x)
            mm_h = eh / (self.pixels_per_step_y * self.steps_per_mm_y)

            rois_mm.append((mm_x, mm_y, mm_w, mm_h))

        method = "otsu" if otsu_ok else "edge_energy"

        return {
            "success": True,
            "rois": rois_mm,
            "rois_px": rois_px,
            "method": method,
            "contours": contours_result,
        }

    def _stage1_otsu(self, gray):
        """
        Stage 1: Otsu thresholding.
        Returns (binary_mask, success_bool).
        Fails if histogram shows single merged peak (low contrast).
        """
        import cv2

        # Check for bimodal histogram
        hist = cv2.calcHist([gray], [0], None, [256], [0, 256]).flatten()
        hist_norm = hist / hist.sum()

        # Simple bimodality test: find if there are two distinct peaks
        from scipy.signal import find_peaks
        try:
            peaks, props = find_peaks(hist_norm, height=0.005, distance=30)
            is_bimodal = len(peaks) >= 2
        except ImportError:
            # Fallback: check if Otsu threshold is not at extremes
            thresh_val, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            is_bimodal = 30 < thresh_val < 225

        if not is_bimodal:
            logger.info("[ROI] Stage 1: Histogram not bimodal, falling to Stage 2")
            return None, False

        thresh_val, mask = cv2.threshold(
            gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
        )
        logger.info(f"[ROI] Stage 1: Otsu threshold = {thresh_val}")

        # Morphological cleanup
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

        return mask, True

    def _stage2_edge_energy(self, gray):
        """
        Stage 2: Edge energy projection fallback.
        Returns bounding box (x, y, w, h) in pixels or None.
        """
        import cv2

        # Apply Laplacian for edge detection
        edges = cv2.Laplacian(gray, cv2.CV_64F)
        edge_energy = np.abs(edges)

        # Project along columns (X) and rows (Y)
        x_proj = edge_energy.sum(axis=0)
        y_proj = edge_energy.sum(axis=1)

        # Normalize
        x_proj = x_proj / x_proj.max() if x_proj.max() > 0 else x_proj
        y_proj = y_proj / y_proj.max() if y_proj.max() > 0 else y_proj

        # Find outermost peaks above noise floor
        x_above = np.where(x_proj > self.noise_floor)[0]
        y_above = np.where(y_proj > self.noise_floor)[0]

        if len(x_above) < 2 or len(y_above) < 2:
            logger.warning("[ROI] Stage 2: No peaks above noise floor")
            return None

        x_min, x_max = x_above[0], x_above[-1]
        y_min, y_max = y_above[0], y_above[-1]

        bbox = (int(x_min), int(y_min), int(x_max - x_min), int(y_max - y_min))
        logger.info(f"[ROI] Stage 2: Edge bbox = {bbox}")
        return bbox

    def _stage3_contours(self, mask, multi_body=False):
        """
        Stage 3: Contour filtering.
        Returns list of contour arrays (largest only if single body mode).
        """
        import cv2

        contours, _ = cv2.findContours(
            mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )

        # Filter by minimum area
        valid = [c for c in contours if cv2.contourArea(c) >= self.min_area_px]

        if not valid:
            logger.warning("[ROI] Stage 3: No contours above minimum area")
            return []

        # Sort by area descending
        valid.sort(key=cv2.contourArea, reverse=True)

        if multi_body:
            logger.info(f"[ROI] Stage 3: {len(valid)} contours (multi-body)")
            return valid
        else:
            logger.info(f"[ROI] Stage 3: Largest contour selected")
            return [valid[0]]
