"""
============================================================================
                    URUMICAM — FOCUS QUALITY ASSESSMENT
============================================================================

Laplacian variance-based focus quality metric. Used to determine if a 
captured tile meets the minimum sharpness requirement.

============================================================================
"""

import logging
import numpy as np

logger = logging.getLogger("urumicam.quality")


class FocusChecker:
    """
    Focus quality assessment using Laplacian variance.
    
    The Laplacian highlights edges and rapid intensity changes.
    Its variance is high for sharp images and low for blurry ones.
    """

    def __init__(self, config):
        self.min_variance = config.get("min_focus_variance", 100.0)
        self.baseline = config.get("focus_baseline", 0.0)
        self.threshold_ratio = config.get("focus_threshold_ratio", 0.6)

        # If we have a calibrated baseline, use it
        if self.baseline > 0:
            self.min_variance = self.baseline * self.threshold_ratio

    def check(self, frame):
        """
        Check if a frame meets the focus quality threshold.
        
        Args:
            frame: BGR numpy array (captured tile image)
            
        Returns:
            tuple: (passed: bool, variance: float)
        """
        import cv2

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        laplacian = cv2.Laplacian(gray, cv2.CV_64F)
        variance = float(laplacian.var())

        passed = variance >= self.min_variance
        level = "PASS" if passed else "FAIL"
        logger.info(
            f"[FOCUS] {level}: variance={variance:.1f} "
            f"(threshold={self.min_variance:.1f})"
        )

        return passed, variance

    def calibrate_baseline(self, frame):
        """
        Calibrate the focus baseline from a reference tile.
        
        Returns:
            float: Laplacian variance of the reference frame.
        """
        import cv2

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        laplacian = cv2.Laplacian(gray, cv2.CV_64F)
        self.baseline = float(laplacian.var())
        self.min_variance = self.baseline * self.threshold_ratio

        logger.info(
            f"[FOCUS] Calibrated: baseline={self.baseline:.1f}, "
            f"threshold={self.min_variance:.1f}"
        )
        return self.baseline
