"""
============================================================================
                    URUMICAM — CALIBRATION ROUTINES
============================================================================

Four calibration routines accessible from the UI settings panel.
All calibration values are persisted to config.json.

============================================================================
"""

import time
import logging
import numpy as np

logger = logging.getLogger("urumicam.calibration")


class CalibrationManager:
    """
    Manages all calibration routines.
    
    1. Pixels-per-step: move gantry known steps, measure pixel displacement
    2. Tile FOV: capture calibration target, measure physical dimensions
    3. Quiescence threshold: record accelerometer ringdown profile
    4. Focus baseline: capture reference tile, record Laplacian variance
    """

    def __init__(self, config, camera, uart, gpio, focus_checker):
        self.config = config
        self.camera = camera
        self.uart = uart
        self.gpio = gpio
        self.focus = focus_checker

    def calibrate_pixels_per_step(self, step_count=1000, callback=None):
        """
        Calibrate pixels-per-step by moving gantry and measuring
        pixel displacement in the captured frame.
        
        Args:
            step_count: Number of steps to move for calibration.
            callback: Progress callback function.
            
        Returns:
            dict: Calibration results with px_per_step_x, px_per_step_y
        """
        import cv2

        if callback:
            callback("Capturing reference frame...")

        # Capture reference frame
        ref_frame = self.camera.capture_frame()
        if ref_frame is None:
            return {"error": "Failed to capture reference frame"}

        # Move X axis by known step count
        if callback:
            callback(f"Moving X axis by {step_count} steps...")

        self.uart.send_move_to(
            self.config.get("motor_x_rs485_id", 3) * step_count,
            0
        )

        # Wait for arrival and quiescence
        time.sleep(2)
        self.gpio.wait_for_quiescence(timeout=5)

        # Capture displaced frame
        if callback:
            callback("Capturing displaced frame...")

        disp_frame = self.camera.capture_frame()
        if disp_frame is None:
            return {"error": "Failed to capture displaced frame"}

        # Measure pixel displacement using template matching
        ref_gray = cv2.cvtColor(ref_frame, cv2.COLOR_BGR2GRAY)
        disp_gray = cv2.cvtColor(disp_frame, cv2.COLOR_BGR2GRAY)

        # Use ORB feature matching to find displacement
        orb = cv2.ORB_create(nfeatures=1000)
        kp1, des1 = orb.detectAndCompute(ref_gray, None)
        kp2, des2 = orb.detectAndCompute(disp_gray, None)

        if des1 is None or des2 is None:
            return {"error": "Insufficient features for calibration"}

        bf = cv2.BFMatcher(cv2.NORM_HAMMING)
        matches = bf.knnMatch(des1, des2, k=2)

        good = []
        for m_pair in matches:
            if len(m_pair) == 2:
                m, n = m_pair
                if m.distance < 0.7 * n.distance:
                    good.append(m)

        if len(good) < 10:
            return {"error": f"Only {len(good)} matches found, need >= 10"}

        # Compute median pixel displacement
        dxs = [kp2[m.trainIdx].pt[0] - kp1[m.queryIdx].pt[0] for m in good]
        pixel_displacement = abs(np.median(dxs))

        if pixel_displacement < 1:
            return {"error": "Pixel displacement too small"}

        px_per_step = pixel_displacement / step_count

        # Update config
        self.config.update({
            "pixels_per_step_x": round(px_per_step, 6),
            "pixels_per_step_y": round(px_per_step, 6),
        })

        result = {
            "pixels_per_step_x": round(px_per_step, 6),
            "pixels_per_step_y": round(px_per_step, 6),
            "pixel_displacement": round(pixel_displacement, 1),
            "step_count": step_count,
            "match_count": len(good),
        }

        if callback:
            callback(f"Calibrated: {px_per_step:.6f} px/step")

        logger.info(f"[CAL] Pixels/step: {result}")
        return result

    def calibrate_tile_fov(self, known_width_mm, known_height_mm, callback=None):
        """
        Calibrate tile FOV by capturing a known-size calibration target.
        
        Args:
            known_width_mm: Physical width of calibration target (mm)
            known_height_mm: Physical height of calibration target (mm)
            callback: Progress callback function.
            
        Returns:
            dict: FOV calibration results
        """
        if callback:
            callback("Capturing calibration target...")

        frame = self.camera.capture_frame()
        if frame is None:
            return {"error": "Failed to capture frame"}

        h, w = frame.shape[:2]

        # For now, assume the calibration target fills the frame
        # In practice, the user would measure the target in the frame
        fov_x_mm = known_width_mm
        fov_y_mm = known_height_mm

        self.config.update({
            "tile_fov_x_mm": round(fov_x_mm, 2),
            "tile_fov_y_mm": round(fov_y_mm, 2),
        })

        result = {
            "tile_fov_x_mm": round(fov_x_mm, 2),
            "tile_fov_y_mm": round(fov_y_mm, 2),
            "frame_resolution": [w, h],
        }

        if callback:
            callback(f"FOV: {fov_x_mm:.2f} x {fov_y_mm:.2f} mm")

        logger.info(f"[CAL] Tile FOV: {result}")
        return result

    def calibrate_focus_baseline(self, callback=None):
        """
        Calibrate focus baseline from a reference tile.
        
        Returns:
            dict: Focus calibration results
        """
        if callback:
            callback("Capturing reference tile for focus baseline...")

        frame = self.camera.capture_frame()
        if frame is None:
            return {"error": "Failed to capture frame"}

        baseline = self.focus.calibrate_baseline(frame)
        threshold = baseline * self.config.get("focus_threshold_ratio", 0.6)

        self.config.update({
            "focus_baseline": round(baseline, 1),
            "min_focus_variance": round(threshold, 1),
        })

        result = {
            "focus_baseline": round(baseline, 1),
            "min_focus_variance": round(threshold, 1),
            "threshold_ratio": self.config.get("focus_threshold_ratio", 0.6),
        }

        if callback:
            callback(f"Baseline: {baseline:.1f}, Threshold: {threshold:.1f}")

        logger.info(f"[CAL] Focus baseline: {result}")
        return result

    def calibrate_quiescence(self, callback=None):
        """
        Calibrate quiescence threshold by recording accelerometer 
        ringdown profile. Returns suggested threshold and dwell coefficient.
        
        Note: This requires the ADXL345 accelerometer on the Pico 2.
        The Pico 2 firmware handles the actual measurement and reports
        back the ringdown profile over UART.
        
        Returns:
            dict: Quiescence calibration results
        """
        if callback:
            callback("Running quiescence calibration...")
            callback("This requires physical hardware. Using config defaults.")

        result = {
            "accel_rms_threshold": self.config.get("accel_rms_threshold", 0.05),
            "quiescence_window_ms": self.config.get("quiescence_window_ms", 50),
            "base_dwell_ms": self.config.get("base_dwell_ms", 200),
            "dwell_per_step_coeff": self.config.get("dwell_per_step_coeff", 0.01),
            "note": "Update these values after hardware ringdown measurement"
        }

        logger.info(f"[CAL] Quiescence config: {result}")
        return result

    def calibrate_aruco_dpi(self, marker_id=0, marker_size_mm=20.0, callback=None):
        """
        Calibrate camera pixels_per_mm using a known physical-sized ArUco marker.
        Uses 4x4 dictionary (DICT_4X4_50).
        """
        import cv2

        if callback:
            callback(f"Capturing frame to locate ArUco Marker ID {marker_id}...")

        frame = self.camera.capture_frame()
        if frame is None:
            return {"error": "Failed to capture frame"}

        # Detect ArUco markers
        aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        params = cv2.aruco.DetectorParameters()
        if hasattr(cv2.aruco, 'ArucoDetector'):
            detector = cv2.aruco.ArucoDetector(aruco_dict, params)
            corners, ids, rejected = detector.detectMarkers(frame)
        else:
            corners, ids, rejected = cv2.aruco.detectMarkers(frame, dictionary=aruco_dict, parameters=params)

        if ids is None or len(ids) == 0:
            return {"error": f"No ArUco markers detected. Ensure Marker ID {marker_id} is in view."}

        # Find specified marker_id
        target_idx = -1
        for idx, mid in enumerate(ids.flatten()):
            if mid == marker_id:
                target_idx = idx
                break

        if target_idx == -1:
            return {"error": f"ArUco Marker ID {marker_id} not found (detected markers: {ids.flatten().tolist()})"}

        # Compute pixel width/height of the marker
        c = corners[target_idx][0]  # 4 corners (top-left, top-right, bottom-right, bottom-left)

        # Compute length of all 4 sides
        side1 = np.linalg.norm(c[0] - c[1])
        side2 = np.linalg.norm(c[1] - c[2])
        side3 = np.linalg.norm(c[2] - c[3])
        side4 = np.linalg.norm(c[3] - c[0])

        average_side_px = float((side1 + side2 + side3 + side4) / 4.0)

        if average_side_px < 5.0:
            return {"error": "Detected ArUco marker is too small in the frame"}

        pixels_per_mm = average_side_px / marker_size_mm

        # Retrieve steps_per_mm from config (defaulting to 160)
        steps_per_mm_x = self.config.get("steps_per_mm_x", 160.0)
        steps_per_mm_y = self.config.get("steps_per_mm_y", 160.0)

        pixels_per_step_x = pixels_per_mm / steps_per_mm_x
        pixels_per_step_y = pixels_per_mm / steps_per_mm_y

        # Calculate physical FOV dimensions (e.g., 40.0mm by 30.0mm)
        h_frame, w_frame = frame.shape[:2]
        tile_fov_x_mm = w_frame / pixels_per_mm
        tile_fov_y_mm = h_frame / pixels_per_mm

        # Save to config
        self.config.update({
            "pixels_per_mm": round(pixels_per_mm, 6),
            "pixels_per_step_x": round(pixels_per_step_x, 6),
            "pixels_per_step_y": round(pixels_per_step_y, 6),
            "tile_fov_x_mm": round(tile_fov_x_mm, 2),
            "tile_fov_y_mm": round(tile_fov_y_mm, 2)
        })

        result = {
            "success": True,
            "marker_id": marker_id,
            "marker_size_mm": marker_size_mm,
            "average_side_px": round(average_side_px, 2),
            "pixels_per_mm": round(pixels_per_mm, 6),
            "pixels_per_step_x": round(pixels_per_step_x, 6),
            "pixels_per_step_y": round(pixels_per_step_y, 6),
            "tile_fov_x_mm": round(tile_fov_x_mm, 2),
            "tile_fov_y_mm": round(tile_fov_y_mm, 2)
        }

        if callback:
            callback(f"Successfully calibrated: {pixels_per_mm:.4f} px/mm, {pixels_per_step_x:.6f} px/step")

        logger.info(f"[CAL] ArUco Calibration complete: {result}")
        return result
