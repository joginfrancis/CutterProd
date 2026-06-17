"""
============================================================================
                    URUMICAM — CAMERA CONTROLLER
============================================================================

Camera capture using rpicam-still (since libcamera doesn't work on this
hardware, but rpicam-vid does). Uses subprocess calls for capture and 
provides MJPEG streaming for the live preview feed.

============================================================================
"""

import subprocess
import time
import io
import threading
import logging
import numpy as np
from pathlib import Path

logger = logging.getLogger("urumicam.camera")


class CameraController:
    """
    Camera controller using rpicam-still for high-res capture
    and rpicam-vid for live preview streaming.
    """

    def __init__(self, config=None, mock=False):
        self.mock = mock
        self.config = config
        self._preview_thread = None
        self._preview_running = False
        self._latest_frame = None
        self._frame_lock = threading.Lock()
        self._frame_event = threading.Event()

        # Capture settings
        self.capture_width = 2028
        self.capture_height = 1520
        self.preview_width = 640
        self.preview_height = 480
        self.jpeg_quality = 95

        if config:
            res = config.get("camera_capture_resolution", [2028, 1520])
            self.capture_width, self.capture_height = res
            prev = config.get("camera_preview_resolution", [640, 480])
            self.preview_width, self.preview_height = prev
            self.jpeg_quality = config.get("camera_jpeg_quality", 95)

    def capture_to_file(self, filepath):
        """
        Capture a single high-resolution frame and save to file.
        Uses rpicam-still for maximum quality.
        
        Args:
            filepath: Path to save the JPEG image.
            
        Returns:
            bool: True if capture succeeded.
        """
        filepath = Path(filepath)
        filepath.parent.mkdir(parents=True, exist_ok=True)

        if self.mock:
            self._generate_mock_image(filepath)
            logger.info(f"[CAM MOCK] Saved {filepath}")
            return True

        try:
            cmd = [
                "rpicam-still",
                "-o", str(filepath),
                "--width", str(self.capture_width),
                "--height", str(self.capture_height),
                "--quality", str(self.jpeg_quality),
                "--nopreview",
                "--immediate",
                "-t", "1",  # minimal timeout
            ]
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                logger.info(f"[CAM] Captured {filepath}")
                return True
            else:
                logger.error(f"[CAM] rpicam-still error: {result.stderr}")
                return False
        except subprocess.TimeoutExpired:
            logger.error("[CAM] Capture timed out")
            return False
        except FileNotFoundError:
            logger.error("[CAM] rpicam-still not found")
            return False
        except Exception as e:
            logger.error(f"[CAM] Capture failed: {e}")
            return False

    def capture_frame(self):
        """
        Capture a single frame and return as numpy array.
        
        Returns:
            numpy.ndarray or None: BGR image array.
        """
        if self.mock:
            return self._generate_mock_array()

        try:
            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
                tmp_path = tmp.name

            if self.capture_to_file(tmp_path):
                import cv2
                img = cv2.imread(tmp_path)
                Path(tmp_path).unlink(missing_ok=True)
                return img
            return None
        except Exception as e:
            logger.error(f"[CAM] Frame capture failed: {e}")
            return None

    def start_preview(self):
        """Start the live preview stream in a background thread."""
        if self._preview_running:
            return
        self._preview_running = True
        self._preview_thread = threading.Thread(
            target=self._preview_loop, daemon=True, name="cam-preview"
        )
        self._preview_thread.start()
        logger.info("[CAM] Preview stream started")

    def stop_preview(self):
        """Stop the live preview stream."""
        self._preview_running = False
        if self._preview_thread:
            self._preview_thread.join(timeout=3)
        logger.info("[CAM] Preview stream stopped")

    def get_preview_frame(self):
        """
        Get the latest preview frame as JPEG bytes.
        
        Returns:
            bytes or None: JPEG-encoded frame.
        """
        with self._frame_lock:
            return self._latest_frame

    def _preview_loop(self):
        """Background thread for continuous preview capture."""
        if self.mock:
            while self._preview_running:
                frame = self._generate_mock_jpeg()
                with self._frame_lock:
                    self._latest_frame = frame
                self._frame_event.set()
                time.sleep(1.0 / 15)  # 15 FPS
            return

        try:
            proc = subprocess.Popen(
                [
                    "rpicam-vid",
                    "-t", "0",  # run indefinitely
                    "--width", str(self.preview_width),
                    "--height", str(self.preview_height),
                    "--codec", "mjpeg",
                    "--nopreview",
                    "-o", "-",  # output to stdout
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

            # Parse MJPEG stream from stdout
            buffer = b""
            while self._preview_running:
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                buffer += chunk

                # Find JPEG boundaries
                while True:
                    start = buffer.find(b"\xff\xd8")
                    end = buffer.find(b"\xff\xd9", start + 2) if start >= 0 else -1
                    if start >= 0 and end >= 0:
                        frame = buffer[start:end + 2]
                        buffer = buffer[end + 2:]
                        with self._frame_lock:
                            self._latest_frame = frame
                        self._frame_event.set()
                    else:
                        break

            proc.terminate()
            proc.wait(timeout=3)
        except Exception as e:
            logger.error(f"[CAM] Preview loop error: {e}")

    # ── Mock Helpers ───────────────────────────────────────────────────────

    def _generate_mock_image(self, filepath):
        """Generate a synthetic test image for mock mode."""
        try:
            import cv2
            img = self._generate_mock_array()
            cv2.imwrite(str(filepath), img, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
        except Exception:
            # Fallback: write a minimal JPEG
            filepath.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100 + b"\xff\xd9")

    def _generate_mock_array(self):
        """Generate a synthetic test image as numpy array."""
        try:
            import cv2
            img = np.zeros((self.capture_height, self.capture_width, 3), dtype=np.uint8)
            img[:] = (40, 40, 40)  # Dark gray background
            
            # Generate and draw ArUco marker ID 0 of size 1014x1014 px (centered)
            try:
                aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
                try:
                    marker_img = cv2.aruco.generateImageMarker(aruco_dict, 0, 1014)
                except AttributeError:
                    marker_img = cv2.aruco.drawMarker(aruco_dict, 0, 1014)
                
                # Convert to BGR and paste into the mock frame centered at [253:1267, 507:1521]
                marker_bgr = cv2.cvtColor(marker_img, cv2.COLOR_GRAY2BGR)
                img[253:1267, 507:1521] = marker_bgr
            except Exception as ae:
                logger.warning(f"[CAM] Failed to generate mock ArUco marker: {ae}")
            # Draw a grid pattern
            for x in range(0, self.capture_width, 100):
                cv2.line(img, (x, 0), (x, self.capture_height), (60, 60, 60), 1)
            for y in range(0, self.capture_height, 100):
                cv2.line(img, (0, y), (self.capture_width, y), (60, 60, 60), 1)
            
            # Draw a simulated workpiece for testing automatic edge detection
            cv2.rectangle(img, (500, 400), (1500, 1100), (220, 220, 220), -1)
            # Add a border to the simulated workpiece
            cv2.rectangle(img, (500, 400), (1500, 1100), (180, 180, 180), 3)
            # Put text label inside
            cv2.putText(img, "WORKPIECE", (850, 780), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (80, 80, 80), 4)

            # Draw center crosshair
            cx, cy = self.capture_width // 2, self.capture_height // 2
            cv2.line(img, (cx - 50, cy), (cx + 50, cy), (0, 255, 0), 2)
            cv2.line(img, (cx, cy - 50), (cx, cy + 50), (0, 255, 0), 2)
            # Add some random texture for focus testing
            noise = np.random.randint(0, 30, img.shape, dtype=np.uint8)
            img = cv2.add(img, noise)
            return img
        except Exception:
            return np.random.randint(30, 80, (self.capture_height, self.capture_width, 3), dtype=np.uint8)


    def _generate_mock_jpeg(self):
        """Generate a synthetic JPEG frame for preview."""
        try:
            import cv2
            img = np.zeros((self.preview_height, self.preview_width, 3), dtype=np.uint8)
            img[:] = (30, 30, 30)
            cx, cy = self.preview_width // 2, self.preview_height // 2
            cv2.line(img, (cx - 30, cy), (cx + 30, cy), (0, 200, 0), 1)
            cv2.line(img, (cx, cy - 30), (cx, cy + 30), (0, 200, 0), 1)
            ts = time.strftime("%H:%M:%S")
            cv2.putText(img, ts, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 0), 1)
            _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
            return buf.tobytes()
        except ImportError:
            return b"\xff\xd8\xff\xe0" + b"\x00" * 50 + b"\xff\xd9"
