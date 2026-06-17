"""
============================================================================
                    URUMICAM — ARUCO BED RECTIFIER
============================================================================

Perspective correction and scaling of mobile-uploaded machine bed images
using ArUco frame references.

- Automatically identifies frame size (Small, Medium, Large)
- Calibrates DPI based on known physical marker coordinates
- Compensates for lens distortion using perimeter checkerboard corners
- Returns a top-down, dimensionally accurate rectified image

============================================================================
"""

import os
import json
import logging
import cv2
import numpy as np
import scipy.optimize

logger = logging.getLogger("urumicam.aruco")

class ArUcoRectifier:
    """
    Detects ArUco markers on the machine bed frame and transforms 
    the perspective into a scaled, rectified top-down coordinate space.
    """

    def __init__(self, config_dir=None):
        if config_dir is None:
            # Default to the adjacent config directory
            config_dir = os.path.join(os.path.dirname(__file__), "config")
        
        self.config_dir = config_dir
        self.config_frames = self._load_all_configs()

    def _load_all_configs(self):
        """Load configuration details for small, medium, and large ArUco frames."""
        configs = {}
        config_path = os.path.join(self.config_dir, "config.json")
        if not os.path.exists(config_path):
            logger.error(f"Frame config index not found at: {config_path}")
            return configs

        try:
            with open(config_path, "r") as f:
                index = json.load(f)
            
            for name, relative_filename in index.items():
                full_path = os.path.join(self.config_dir, relative_filename)
                if os.path.exists(full_path):
                    with open(full_path, "r") as f_frame:
                        configs[name] = json.load(f_frame)
                    logger.info(f"Loaded frame configuration: {name}")
                else:
                    logger.warning(f"Frame config file not found: {full_path}")
        except Exception as e:
            logger.error(f"Failed to load frame configs: {e}")
        
        return configs

    def solve_affine(self, xy_array, uv_array):
        """Solves a 3x3 homography matrix mapping xy to uv coordinates."""
        if len(xy_array) < 4 or len(uv_array) != len(xy_array):
            raise ValueError("Wrong input sizes: should be at least 4x2 mapping")
        n_points = len(uv_array)
        A = np.zeros((2 * n_points, 8))
        b = np.zeros((2 * n_points,))
        for i in range(n_points):
            xy = xy_array[i, :]
            uv = uv_array[i, :]

            A[2 * i, 0:2] = xy
            A[2 * i, 2] = 1
            A[2 * i, 6:8] = -xy * uv[0]

            A[2 * i + 1, 3:5] = xy
            A[2 * i + 1, 5] = 1
            A[2 * i + 1, 6:8] = -xy * uv[1]

            b[2 * i] = uv[0]
            b[2 * i + 1] = uv[1]

        sol = np.ones((9,))
        A_inv = np.linalg.pinv(A) if n_points > 4 else np.linalg.inv(A)
        sol[:8] = A_inv @ b
        return sol.reshape((3, 3))

    def apply_affine(self, a, xy):
        """Applies homography matrix a to xy coordinates to get uv."""
        n = len(xy)
        xyz = np.ones((n, 3))
        xyz[:, :2] = xy
        uvw = xyz @ a.T
        uv = uvw[:, :2] / uvw[:, 2:]
        return uv

    def undistort(self, params, uv, f):
        """Compensates lens distortion using distortion parameters."""
        k1, k2 = params[:2]
        uv_c = params[2:4]
        r2 = np.sum(np.square((uv - uv_c) / f), axis=1, keepdims=True)
        coeff = 1 / (1 + k1 * r2 + k2 * r2 * r2)
        return uv_c + (uv - uv_c) * coeff

    def xy_error(self, xy, uv, P):
        """Computes residual distance error between physically expected and mapped points."""
        n_points = len(uv)
        P_inv = np.linalg.inv(P)
        P_inv /= P_inv[2, 2]

        uv_ext = np.ones((n_points, 3))
        uv_ext[:, :2] = uv
        xy2_ext = P_inv @ uv_ext.T
        xy2 = xy2_ext[:2, :].T / xy2_ext[2:, :].T
        return xy2 - xy

    def xy_loss(self, params, xy, uv, proj, f):
        """Loss function for lens distortion optimization."""
        uv_u = self.undistort(params, uv, f)
        err = self.xy_error(xy, uv_u, proj)
        return np.mean(np.sum(err * err, axis=1))

    def solve_distortion(self, xy, uv, proj, f, w, h):
        """Optimizes lens distortion parameters to align corner features."""
        x0 = np.array([0, 0, w / 2, h / 2])
        result = scipy.optimize.minimize(self.xy_loss, x0, args=(xy, uv, proj, f))
        return result.x

    def extract_image(self, img, proj, config, dots_per_mm, dist_params=None):
        """Remaps the original image into a rectified top-down perspective."""
        h, w = img.shape[:2]
        m = config["margins"]["inner_content"]
        xmin = m
        xmax = config["width"] - m
        ymin = m
        ymax = config["height"] - m

        h_out = int(dots_per_mm * (ymax - ymin))
        w_out = int(dots_per_mm * (xmax - xmin))

        x = np.linspace(xmin, xmax, w_out)
        y = np.linspace(ymax, ymin, h_out)
        xx, yy = np.meshgrid(x, y)

        xy_list = np.ones((h_out * w_out, 2))
        xy_list[:, 0] = xx.flatten()
        xy_list[:, 1] = yy.flatten()
        uv_src = self.apply_affine(proj, xy_list)

        if dist_params is not None:
            k1, k2, uc, vc = dist_params[:]
            mat = np.array([[w, 0, uc], [0, w, vc], [0, 0, 1]], dtype=np.float32)
            dist_coeffs = np.array([[0, 0, 0, 0, 0, k1, k2, 0]], dtype=np.float32)
            out = cv2.undistortPoints(uv_src, mat, dist_coeffs, P=mat)
            uv_src = out[:, 0, :]

        map1 = uv_src[:, 0].reshape((h_out, w_out)).astype(np.float32)
        map2 = uv_src[:, 1].reshape((h_out, w_out)).astype(np.float32)

        img_out = cv2.remap(img, map1, map2, interpolation=cv2.INTER_CUBIC)
        return img_out

    def find_aruco(self, img):
        """Detects ArUco markers in the image."""
        # Use 4x4 dictionary (DICT_4X4_50 is standard in this repo)
        aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        params = cv2.aruco.DetectorParameters()
        params.adaptiveThreshWinSizeMax = 40
        params.useAruco3Detection = True
        
        if hasattr(cv2.aruco, 'ArucoDetector'):
            detector = cv2.aruco.ArucoDetector(aruco_dict, params)
            corners, ids, rejected = detector.detectMarkers(img)
        else:
            corners, ids, rejected = cv2.aruco.detectMarkers(img, dictionary=aruco_dict, parameters=params)
            
        if ids is None:
            return {}
        else:
            corners_dict = {ids[k][0]: corners[k][0, :, :] for k in range(len(ids))}
            return corners_dict

    def identify_frame(self, img):
        """Scans detected ArUco marker IDs to identify the matching frame configuration."""
        corners_dict = self.find_aruco(img)
        if not corners_dict:
            return None

        name_found = None
        for name, config in self.config_frames.items():
            match = True
            for aruco_id in config["aruco_id"]:
                if aruco_id not in corners_dict:
                    match = False
                    break
            if match:
                name_found = name
                break
        return name_found

    def get_aruco_features(self, img, config):
        """Extracts the expected physical and observed camera coordinates of the 4 ArUco markers."""
        corners_dict_all = self.find_aruco(img)
        corners_dict = {k: corners_dict_all[k] for k in config["aruco_id"]}
        centers_dict = {k: np.mean(corners_dict[k], axis=0) for k in corners_dict}

        xy_array = np.zeros((4, 2))
        uv_array = np.zeros((4, 2))

        for i in range(4):
            xy_array[i, :] = config["aruco_pos"][i]
            uv_array[i, :] = centers_dict[config["aruco_id"][i]]

        return xy_array, uv_array

    def get_corner_features(self, img_gray, proj, config):
        """Finds additional grid corners for camera lens distortion compensation."""
        n_points = sum(len(edge) for edge in config["corner_pos"])
        xy_feats = np.zeros((n_points, 2))
        uv_feats_approx = np.zeros((n_points, 2))

        k = 0
        for edge in config["corner_pos"]:
            n_edge = len(edge)
            xy_feats[k:k + n_edge, :] = np.array(edge)
            uv_feats_approx[k:k + n_edge] = self.apply_affine(proj, xy_feats[k:k + n_edge, :])
            k += n_edge

        search_mm = 0.7 * config["corner_size"] / 2
        cross_xy = np.zeros((4 * n_points, 2), dtype=np.float32)
        cross_xy[0::4, :] = xy_feats - np.array([search_mm, 0])
        cross_xy[1::4, :] = xy_feats + np.array([search_mm, 0])
        cross_xy[2::4, :] = xy_feats - np.array([0, search_mm])
        cross_xy[3::4, :] = xy_feats + np.array([0, search_mm])

        cross_uv = self.apply_affine(proj, cross_xy)
        cross_uv_r = cross_uv.reshape(n_points, 4, 2)

        span_uv = (np.max(cross_uv_r, axis=1) - np.min(cross_uv_r, axis=1)) / 2
        search_uv = np.mean(span_uv, axis=0).astype(np.int32)

        # Enforce search box minimum to avoid subpixel errors
        search_uv[0] = max(5, search_uv[0])
        search_uv[1] = max(5, search_uv[1])

        criteria = (cv2.TERM_CRITERIA_COUNT + cv2.TERM_CRITERIA_EPS, 40, 0.001)
        
        # Sub-pixel extraction can fail if checkerboard corners are blurry
        try:
            ret = cv2.cornerSubPix(img_gray,
                                   uv_feats_approx[:, np.newaxis, :].astype(np.float32),
                                   (search_uv[0], search_uv[1]),
                                   (-1, -1),
                                   criteria)
            uv_feats = ret[:, 0, :]
            return xy_feats, uv_feats, True
        except Exception as e:
            logger.warning(f"Sub-pixel corner extraction failed, using approximation: {e}")
            return xy_feats, uv_feats_approx, False

    def get_dots_per_mm(self, xy, uv, use_max=True):
        """Calculates scaling DPI based on the physical distance in mm vs pixel distance."""
        xy_dist = np.zeros((4,))
        uv_dist = np.zeros((4,))
        for i in range(-1, 3):
            xy_dist[i] = np.linalg.norm(xy[i + 1] - xy[i])
            uv_dist[i] = np.linalg.norm(uv[i + 1] - uv[i])
        if use_max:
            return np.max(uv_dist / xy_dist)
        else:
            return np.mean(uv_dist / xy_dist)

    def process_image(self, img, solve_dist=False, target_dpi=None):
        """
        Processes a raw image containing an ArUco frame, rectifying perspective 
        and extracting the clean, top-down machine bed representation.
        
        Args:
            img: BGR input image
            solve_dist: Whether to attempt lens distortion optimization (requires good lighting/focus)
            target_dpi: Standardized output DPI (default: computed automatically)
            
        Returns:
            dict containing:
                "success": bool
                "image": Rectified BGR image numpy array
                "dpi": Computed or requested DPI
                "frame_name": Name of frame detected (small, medium, large)
                "physical_width": Width in mm
                "physical_height": Height in mm
                "dots_per_mm": Scale factor
                "error_mm": Mean physical projection error
        """
        h, w = img.shape[:2]
        img_gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        frame_name = self.identify_frame(img)
        if frame_name is None:
            return {
                "success": False,
                "message": "No matching ArUco frame detected. Please check that all 4 corners are visible."
            }

        config = self.config_frames[frame_name]
        xy_a, uv_a = self.get_aruco_features(img, config)
        
        # Calculate initial homography projection based on ArUco centers
        proj = self.solve_affine(xy_a, uv_a)

        # Scale calculation
        if target_dpi is None:
            dpi = int(self.get_dots_per_mm(xy_a, uv_a) * 25.4)
        else:
            dpi = target_dpi
        dots_per_mm = dpi / 25.4

        # Extract perimeter checkerboard corners for fine-tuning homography and distortion
        xy_c, uv_c, subpix_ok = self.get_corner_features(img_gray, proj, config)

        proj_fine = self.solve_affine(xy_c, uv_c)
        err_init = self.xy_error(xy_c, uv_c, proj)
        err_fine = self.xy_error(xy_c, uv_c, proj_fine)
        mean_err_mm = np.mean(np.linalg.norm(err_fine, axis=1))

        logger.info(f"[ArUco] Frame: {frame_name}, DPI: {dpi}")
        logger.info(f"[ArUco] Error init: {np.mean(np.linalg.norm(err_init, axis=1)):.3f} mm")
        logger.info(f"[ArUco] Error fine: {mean_err_mm:.3f} mm")

        # Perform lens distortion solve if requested and subpixel corners succeeded
        if solve_dist and subpix_ok:
            try:
                params = self.solve_distortion(xy_c, uv_c, proj_fine, w, w, h)
                for _ in range(3):
                    uv_u = self.undistort(params, uv_c, w)
                    proj_fine = self.solve_affine(xy_c, uv_u)
                    params = self.solve_distortion(xy_c, uv_c, proj_fine, w, w, h)

                uv_u = self.undistort(params, uv_c, w)
                err_dist = self.xy_error(xy_c, uv_u, proj_fine)
                mean_err_mm = np.mean(np.linalg.norm(err_dist, axis=1))
                logger.info(f"[ArUco] Error after lens distortion: {mean_err_mm:.3f} mm")
                
                img_out = self.extract_image(img, proj_fine, config, dots_per_mm, dist_params=params)
            except Exception as e:
                logger.warning(f"Lens distortion optimization failed, falling back to homography only: {e}")
                img_out = self.extract_image(img, proj_fine, config, dots_per_mm)
        else:
            # Fall back to standard projective warp
            img_out = self.extract_image(img, proj_fine, config, dots_per_mm)

        # Handle upside down case (180 degree rotation if markers are inverted)
        if uv_a[0][1] < uv_a[2][1]:
            img_out = cv2.rotate(img_out, cv2.ROTATE_180)
            logger.info("[ArUco] Frame orientation was upside down, rotating 180 degrees.")

        # Inner contents dimensions
        m = config["margins"]["inner_content"]
        inner_width_mm = config["width"] - 2 * m
        inner_height_mm = config["height"] - 2 * m

        return {
            "success": True,
            "image": img_out,
            "dpi": dpi,
            "frame_name": frame_name,
            "physical_width": inner_width_mm,
            "physical_height": inner_height_mm,
            "dots_per_mm": dots_per_mm,
            "error_mm": mean_err_mm
        }
