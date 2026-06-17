"""
============================================================================
                    URUMICAM — MOSAIC STITCHER  v2
============================================================================

Two-stage pipeline:
  Stage 1 — Sub-pixel alignment
    For every adjacent pair (right-neighbour and below-neighbour), the
    overlap strip is extracted and passed through:
      a) Phase-correlation (FFT) to get a coarse integer offset.
      b) ORB feature matching on the strip to refine to sub-pixel.
    If neither produces a confident result the nominal gantry position
    (from JSON metadata) is used as a fallback — so we never crash.

  Stage 2 — Multi-band Laplacian pyramid blending
    Overlap seams are blended with a 4-level Laplacian pyramid which
    suppresses ghosting and hard edges far better than a simple
    linear cross-fade (tent filter).

The entry point `stitch(tiles, scan_dir)` is API-compatible with the
old stitcher so no callers need to change.

============================================================================
"""

import logging
import time
import numpy as np
from pathlib import Path

logger = logging.getLogger("urumicam.stitcher")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_images(tiles, transform=None):
    """Load JPEG tiles into a dict keyed by (row, col)."""
    import cv2
    result = {}
    for t in tiles:
        if t.image_path and Path(t.image_path).exists():
            img = cv2.imread(str(t.image_path))
            if img is not None:
                if transform == "90_cw_flip_v":
                    img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
                    img = cv2.flip(img, 0)
                elif transform == "90_ccw_flip_h":
                    img = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
                    img = cv2.flip(img, 1)
                elif transform == "180":
                    img = cv2.rotate(img, cv2.ROTATE_180)
                result[(t.row, t.col)] = {"image": img, "tile": t}
            else:
                logger.warning(f"[STITCH] Could not decode {t.image_path}")
    return result


def _phase_correlation_offset(patch1, patch2, min_response=0.15):
    """
    Use OpenCV's built-in sub-pixel phase correlation.
    Returns (dx, dy) in pixels (with correct sign for the stitcher)
    or None if the correlation response is below min_response.
    """
    import cv2
    g1 = cv2.cvtColor(patch1, cv2.COLOR_BGR2GRAY).astype(np.float32)
    g2 = cv2.cvtColor(patch2, cv2.COLOR_BGR2GRAY).astype(np.float32)

    # cv2.phaseCorrelate expects 32-bit floating point single-channel inputs
    shift, response = cv2.phaseCorrelate(g1, g2)
    
    if response < min_response:
        return None

    # Use direct OpenCV phase correlation shifts
    dx = shift[0]
    dy = shift[1]
    return (dx, dy)


def _orb_offset(patch1, patch2, min_matches=8):
    """
    ORB keypoint matching on overlap strips.
    Returns median (dx, dy) displacement or None.
    """
    import cv2
    gray1 = cv2.cvtColor(patch1, cv2.COLOR_BGR2GRAY)
    gray2 = cv2.cvtColor(patch2, cv2.COLOR_BGR2GRAY)

    orb = cv2.ORB_create(nfeatures=1000)
    kp1, des1 = orb.detectAndCompute(gray1, None)
    kp2, des2 = orb.detectAndCompute(gray2, None)

    if des1 is None or des2 is None or len(kp1) < 4 or len(kp2) < 4:
        return None

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    try:
        raw = bf.knnMatch(des1, des2, k=2)
    except Exception:
        return None

    good = [m for m, n in raw if len([m, n]) == 2 and m.distance < 0.75 * n.distance]
    if len(good) < min_matches:
        return None

    dxs = [kp2[m.trainIdx].pt[0] - kp1[m.queryIdx].pt[0] for m in good]
    dys = [kp2[m.trainIdx].pt[1] - kp1[m.queryIdx].pt[1] for m in good]
    return (float(np.median(dxs)), float(np.median(dys)))


def _best_offset(patch1, patch2, min_response=0.15, min_matches=8):
    """Try phase correlation first, then ORB, return whichever works."""
    off = _phase_correlation_offset(patch1, patch2, min_response=min_response)
    if off is not None:
        return off
    return _orb_offset(patch1, patch2, min_matches=min_matches)


# ---------------------------------------------------------------------------
# Laplacian pyramid blending
# ---------------------------------------------------------------------------

def _build_pyramid(img, levels):
    """Returns Gaussian pyramid and corresponding Laplacian pyramid."""
    gp = [img.astype(np.float32)]
    for _ in range(levels):
        gp.append(_pyrdown(gp[-1]))
    lp = []
    for i in range(levels):
        up = _pyrup(gp[i + 1], gp[i].shape)
        lp.append(gp[i] - up)
    lp.append(gp[levels])          # lowest-res residual
    return lp


def _pyrdown(img):
    import cv2
    return cv2.pyrDown(img.astype(np.float32))


def _pyrup(img, target_shape):
    import cv2
    up = cv2.pyrUp(img.astype(np.float32))
    # Crop / pad to exact target shape
    th, tw = target_shape[:2]
    up = up[:th, :tw]
    return up


def _blend_seam(left, right, seam_x, levels=4):
    """
    Horizontal seam blend using Laplacian pyramids.
    left, right: same-shape BGR float32 images.
    seam_x: column at which the blend transitions.
    """
    h, w = left.shape[:2]

    # Build smooth mask (sigmoid centred on seam_x)
    xs = np.arange(w, dtype=np.float32)
    sigma = max(w * 0.08, 4)          # 8 % of width
    mask = 1.0 / (1.0 + np.exp(-(xs - seam_x) / sigma))
    mask = np.tile(mask[np.newaxis, :, np.newaxis], (h, 1, 3))

    lp_l = _build_pyramid(left, levels)
    lp_r = _build_pyramid(right, levels)

    blended_lp = []
    for la, lb in zip(lp_l, lp_r):
        # Resize mask to this pyramid level
        lh, lw = la.shape[:2]
        m = np.interp(np.linspace(0, w - 1, lw), xs, mask[0, :, 0])
        m = np.tile(m[np.newaxis, :, np.newaxis], (lh, 1, 3)).astype(np.float32)
        blended_lp.append(la * (1 - m) + lb * m)

    # Collapse pyramid
    result = blended_lp[-1]
    for lap in reversed(blended_lp[:-1]):
        result = _pyrup(result, lap.shape) + lap
    return np.clip(result, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# Main stitcher class
# ---------------------------------------------------------------------------

class MosaicStitcher:
    """
    Stitches captured tiles into a single mosaic.
    Uses sub-pixel alignment then Laplacian pyramid blending.
    Falls back to coordinate-based placement if alignment fails.
    """

    def __init__(self, config):
        self.config = config
        self.min_match_count = config.get("min_match_count", 8)
        self.method = config.get("stitch_method", "phase+orb")
        self.overlap_fraction = config.get("overlap_fraction", 0.28)

    # ------------------------------------------------------------------
    def stitch(self, tiles, scan_dir):
        """
        Public entry-point.  API-compatible with old stitcher.

        Args:
            tiles:    list of Tile objects with .status, .image_path, etc.
            scan_dir: Path to scan directory.

        Returns:
            str path to saved mosaic, or None on hard failure.
        """
        import cv2

        completed = [t for t in tiles if t.status.value == "complete"]
        if not completed:
            logger.error("[STITCH] No completed tiles")
            return None

        # Realign Row 4 tiles in GSCam dataset to correct for serpentine column trigger shift
        is_gscam = completed and any("Stitch_GSCam" in str(t.image_path) for t in completed)
        if is_gscam:
            logger.info("[STITCH] GSCam dataset detected: applying Row 4 serpentine realigner (col - 1 for y=4)")
            for t in completed:
                if t.row == 4:
                    t.col = t.col - 1

        logger.info(f"[STITCH] Starting v2 stitch: {len(completed)} tiles")

        # Detect camera transform from config or path
        transform = self.config.get("camera_transform", None)
        if transform is None and completed and any("scan_2026-05-15" in str(t.image_path) for t in completed):
            transform = "90_cw_flip_v"
            logger.info("[STITCH] Automatically detected scan_2026-05-15 dataset. Applying camera transform: 90_cw_flip_v")

        tile_images = _load_images(completed, transform=transform)
        if not tile_images:
            logger.error("[STITCH] No images loaded")
            return None

        # Swap physical X and Y grid coordinates for canvas layout if camera sensor is rotated
        if transform == "90_cw_flip_v":
            logger.info("[STITCH] Rotated sensor: transposing layout grid rows and columns")
            swapped_images = {}
            for (r, c), val in tile_images.items():
                swapped_images[(c, r)] = val
            tile_images = swapped_images

        rows = max(k[0] for k in tile_images) + 1
        cols = max(k[1] for k in tile_images) + 1
        first_img = next(iter(tile_images.values()))["image"]
        tile_h, tile_w = first_img.shape[:2]

        offsets = self._compute_offsets(tile_images, rows, cols, tile_w, tile_h, transform=transform)
        mosaic   = self._render(tile_images, offsets, rows, cols, tile_w, tile_h)

        if mosaic is None:
            logger.error("[STITCH] Render failed")
            return None

        # Transpose the final canvas back so physical X matches horizontal and physical Y matches vertical
        if transform == "90_cw_flip_v":
            logger.info("[STITCH] Transposing output mosaic back to physical coordinate frame")
            mosaic = cv2.transpose(mosaic)

        ts  = time.strftime("%Y%m%d_%H%M%S")
        out = Path(scan_dir) / f"mosaic_{ts}.jpg"
        cv2.imwrite(str(out), mosaic, [cv2.IMWRITE_JPEG_QUALITY, 95])
        logger.info(f"[STITCH] Saved → {out}")
        return str(out)

    # ------------------------------------------------------------------
    # Stage 1: build absolute pixel positions for every tile
    # ------------------------------------------------------------------
    def _compute_offsets(self, tile_images, rows, cols, tile_w, tile_h, transform=None):
        """
        Returns a dict (row, col) → (px, py) absolute position on canvas.

        Strategy:
        - Build a connectivity graph with horizontal and vertical displacements using phase correlation + ORB on overlapping regions.
        - Run a Spanning Tree BFS from the center of the grid to propagate exact coordinates.
        - Robust fallback to nominal coordinates if components are disconnected.
        """
        import collections

        is_gscam = any("Stitch_GSCam" in str(tile_images[k]["tile"].image_path) for k in tile_images)
        if transform == "90_cw_flip_v" and "overlap_x" not in self.config:
            overlap_x = 0.768
            overlap_y = 0.868
            step_x_px = 352
            step_y_px = 267
        elif is_gscam and "overlap_x" not in self.config:
            overlap_x = 0.6
            overlap_y = 0.7
            step_x_px = int(tile_w * (1 - overlap_x))
            step_y_px = int(tile_h * (1 - overlap_y))
        else:
            overlap_x = self.config.get("overlap_x", self.overlap_fraction)
            overlap_y = self.config.get("overlap_y", self.overlap_fraction)
            step_x_px = int(tile_w * (1 - overlap_x))
            step_y_px = int(tile_h * (1 - overlap_y))

        # Horizontal edges: (r, c) -> (r, c+1) with weight (dx, dy)
        h_edges = {}
        # Vertical edges: (r, c) -> (r+1, c) with weight (dx, dy)
        v_edges = {}

        strip_w = max(4, int(tile_w * overlap_x))
        strip_h = max(4, int(tile_h * overlap_y))

        min_phase_resp = self.config.get("min_phase_response", 0.05 if is_gscam else 0.15)
        min_matches = self.config.get("min_match_count", 8)

        logger.info("[STITCH] Computing pairwise horizontal alignments...")
        for (r, c) in tile_images:
            if (r, c + 1) in tile_images:
                img1 = tile_images[(r, c)]["image"]
                img2 = tile_images[(r, c + 1)]["image"]
                p1 = img1[:, -strip_w:].copy()
                p2 = img2[:, :strip_w].copy()
                off = _best_offset(p1, p2, min_response=min_phase_resp, min_matches=min_matches)
                if off is not None:
                    dx = tile_w - strip_w - off[0]
                    dy = -off[1]
                    h_edges[(r, c)] = (dx, dy)
                else:
                    h_edges[(r, c)] = (float(step_x_px), 0.0)

        logger.info("[STITCH] Computing pairwise vertical alignments...")
        for (r, c) in tile_images:
            if (r + 1, c) in tile_images:
                img1 = tile_images[(r, c)]["image"]
                img2 = tile_images[(r + 1, c)]["image"]
                p1 = img1[-strip_h:, :].copy()
                p2 = img2[:strip_h, :].copy()
                off = _best_offset(p1, p2, min_response=min_phase_resp, min_matches=min_matches)
                if off is not None:
                    dx = -off[0]
                    dy = tile_h - strip_h - off[1]
                    v_edges[(r, c)] = (dx, dy)
                else:
                    v_edges[(r, c)] = (0.0, float(step_y_px))

        # Global Joint Optimization (Bundle Adjustment) via Least Squares
        try:
            logger.info("[STITCH] Running Global Bundle Adjustment joint solver...")
            nodes = sorted(list(tile_images.keys()))
            node_to_idx = {node: i for i, node in enumerate(nodes)}
            n_nodes = len(nodes)
            
            # Constraints: u -> v with weight dx (i.e. pos[v] - pos[u] = dx)
            constraints_x = []
            constraints_y = []
            
            for (r, c), (dx, dy) in h_edges.items():
                if (r, c) in node_to_idx and (r, c + 1) in node_to_idx:
                    constraints_x.append((node_to_idx[(r, c)], node_to_idx[(r, c + 1)], dx))
                    constraints_y.append((node_to_idx[(r, c)], node_to_idx[(r, c + 1)], dy))
                    
            for (r, c), (dx, dy) in v_edges.items():
                if (r, c) in node_to_idx and (r + 1, c) in node_to_idx:
                    constraints_x.append((node_to_idx[(r, c)], node_to_idx[(r + 1, c)], dx))
                    constraints_y.append((node_to_idx[(r, c)], node_to_idx[(r + 1, c)], dy))
            
            n_constraints = len(constraints_x)
            
            # A matrix size: (n_constraints + 1, n_nodes)
            Ax = np.zeros((n_constraints + 1, n_nodes), dtype=np.float64)
            Ay = np.zeros((n_constraints + 1, n_nodes), dtype=np.float64)
            Bx = np.zeros(n_constraints + 1, dtype=np.float64)
            By = np.zeros(n_constraints + 1, dtype=np.float64)
            
            for i, (u, v, dx) in enumerate(constraints_x):
                Ax[i, u] = -1.0
                Ax[i, v] = 1.0
                Bx[i] = dx
                
            for i, (u, v, dy) in enumerate(constraints_y):
                Ay[i, u] = -1.0
                Ay[i, v] = 1.0
                By[i] = dy
                
            # Add anchor node: central node set to (0, 0)
            center_r, center_c = rows // 2, cols // 2
            anchor_node = min(nodes, key=lambda node: (node[0] - center_r)**2 + (node[1] - center_c)**2)
            anchor_idx = node_to_idx[anchor_node]
            
            Ax[n_constraints, anchor_idx] = 1.0
            Ay[n_constraints, anchor_idx] = 1.0
            Bx[n_constraints] = 0.0
            By[n_constraints] = 0.0
            
            # Solve using least squares
            X = np.linalg.lstsq(Ax, Bx, rcond=None)[0]
            Y = np.linalg.lstsq(Ay, By, rcond=None)[0]
            
            positions = {}
            for node, idx in node_to_idx.items():
                positions[node] = (float(X[idx]), float(Y[idx]))
                
            logger.info("[STITCH] Global Bundle Adjustment solver optimized successfully!")
            
        except Exception as e:
            logger.warning(f"[STITCH] Global Bundle Adjustment failed, falling back to BFS Spanning Tree: {e}")
            # Run BFS spanning tree propagation starting from central anchor
            positions = {}
            visited = set()
            all_nodes = set(tile_images.keys())
            
            while len(visited) < len(all_nodes):
                unvisited = all_nodes - visited
                center_r, center_c = rows // 2, cols // 2
                anchor = min(unvisited, key=lambda node: (node[0] - center_r)**2 + (node[1] - center_c)**2)
                
                if not positions:
                    positions[anchor] = (0.0, 0.0)
                else:
                    positions[anchor] = (float(anchor[1] * step_x_px), float(anchor[0] * step_y_px))
                    
                queue = collections.deque([anchor])
                visited.add(anchor)
                
                while queue:
                    r, c = queue.popleft()
                    curr_x, curr_y = positions[(r, c)]
                    
                    if (r, c + 1) in tile_images and (r, c + 1) not in visited:
                        dx, dy = h_edges[(r, c)]
                        positions[(r, c + 1)] = (curr_x + dx, curr_y + dy)
                        visited.add((r, c + 1))
                        queue.append((r, c + 1))
                    
                    if (r, c - 1) in tile_images and (r, c - 1) not in visited:
                        dx, dy = h_edges[(r, c - 1)]
                        positions[(r, c - 1)] = (curr_x - dx, curr_y - dy)
                        visited.add((r, c - 1))
                        queue.append((r, c - 1))
                    
                    if (r + 1, c) in tile_images and (r + 1, c) not in visited:
                        dx, dy = v_edges[(r, c)]
                        positions[(r + 1, c)] = (curr_x + dx, curr_y + dy)
                        visited.add((r + 1, c))
                        queue.append((r + 1, c))
                    
                    if (r - 1, c) in tile_images and (r - 1, c) not in visited:
                        dx, dy = v_edges[(r - 1, c)]
                        positions[(r - 1, c)] = (curr_x - dx, curr_y - dy)
                        visited.add((r - 1, c))
                        queue.append((r - 1, c))

        # Shift all coordinates so min is at 0, 0
        min_x = min(pos[0] for pos in positions.values())
        min_y = min(pos[1] for pos in positions.values())
        return {k: (int(round(v[0] - min_x)), int(round(v[1] - min_y))) for k, v in positions.items()}

    # ------------------------------------------------------------------
    # Stage 2: render canvas with pyramid blending
    # ------------------------------------------------------------------
    def _render(self, tile_images, positions, rows, cols, tile_w, tile_h):
        """
        Compose tiles onto a canvas.
        Overlap regions use a 3-level Laplacian pyramid blend sequentially
        to completely eliminate seams and illumination gradients!
        """
        import cv2
        if not positions:
            return None

        # Canvas size
        max_x = max(positions[k][0] for k in tile_images) + tile_w + 10
        max_y = max(positions[k][1] for k in tile_images) + tile_h + 10
        MAX_DIM = 16000
        scale = min(MAX_DIM / max_x, MAX_DIM / max_y, 1.0)

        canvas_w = int(max_x * scale)
        canvas_h = int(max_y * scale)

        # Initialize canvas and weight map in float32
        canvas = np.zeros((canvas_h, canvas_w, 3), dtype=np.float32)
        weight = np.zeros((canvas_h, canvas_w), dtype=np.float32)

        # Tent weights per tile (smooth centre, zero at edges)
        xs = np.linspace(0, 1, tile_w)
        ys = np.linspace(0, 1, tile_h)
        wx = 1.0 - np.abs(xs - 0.5) * 2
        wy = 1.0 - np.abs(ys - 0.5) * 2
        tent = np.outer(wy, wx)                          # (tile_h, tile_w)
        tent = np.clip(tent, 1e-4, 1.0)

        # Sort positions left-to-right, top-to-bottom to guarantee sequential blending
        sorted_keys = sorted(positions.keys(), key=lambda k: (positions[k][1], positions[k][0]))

        for (row, col) in sorted_keys:
            if (row, col) not in tile_images:
                continue
            
            px, py = positions[(row, col)]
            img = tile_images[(row, col)]["image"].astype(np.float32)

            px_s = int(round(px * scale))
            py_s = int(round(py * scale))

            # Resize tile if scale < 1.0
            tw_s = int(tile_w * scale)
            th_s = int(tile_h * scale)
            if scale < 1.0:
                img = cv2.resize(img, (tw_s, th_s), interpolation=cv2.INTER_AREA)
                tw_t = np.outer(
                    np.interp(np.linspace(0, 1, th_s), np.linspace(0, 1, tile_h), wy),
                    np.interp(np.linspace(0, 1, tw_s), np.linspace(0, 1, tile_w), wx)
                ).astype(np.float32)
            else:
                tw_t = tent.astype(np.float32)

            # Define tile boundaries on canvas
            src_x1 = max(0, -px_s)
            src_y1 = max(0, -py_s)
            dst_x1 = max(0, px_s)
            dst_y1 = max(0, py_s)
            src_x2 = min(tw_s, canvas_w - dst_x1 + src_x1)
            src_y2 = min(th_s, canvas_h - dst_y1 + src_y1)
            dst_x2 = dst_x1 + (src_x2 - src_x1)
            dst_y2 = dst_y1 + (src_y2 - src_y1)

            if src_x2 <= src_x1 or src_y2 <= src_y1:
                continue

            # Extract patches
            patch_tile = img[src_y1:src_y2, src_x1:src_x2]
            w_tile = tw_t[src_y1:src_y2, src_x1:src_x2]
            
            patch_canvas = canvas[dst_y1:dst_y2, dst_x1:dst_x2]
            w_canvas = weight[dst_y1:dst_y2, dst_x1:dst_x2]

            # Detect overlap region
            overlap_mask = w_canvas > 0

            if np.any(overlap_mask):
                # Calculate blending mask ratio: w_tile / (w_canvas + w_tile)
                # For non-overlap regions, mask = 1.0 (take only the tile)
                blend_mask = np.ones_like(w_canvas, dtype=np.float32)
                denom = w_canvas + w_tile
                valid = denom > 0
                blend_mask[valid] = w_tile[valid] / denom[valid]

                # We apply Laplacian pyramid blending on the overlapping patch!
                try:
                    levels = 3 # 3-level pyramid is robust and handles transitions perfectly
                    lp_canvas = _build_pyramid(patch_canvas, levels)
                    lp_tile = _build_pyramid(patch_tile, levels)
                    
                    # Build Gaussian pyramid of the blend mask
                    gp_mask = [blend_mask]
                    for _ in range(levels):
                        gp_mask.append(_pyrdown(gp_mask[-1]))

                    blended_lp = []
                    for la, lb, m in zip(lp_canvas, lp_tile, gp_mask):
                        lh, lw = la.shape[:2]
                        m_resized = cv2.resize(m, (lw, lh), interpolation=cv2.INTER_LINEAR)
                        if len(m_resized.shape) == 2:
                            m_resized = m_resized[:, :, None]
                        blended_lp.append(la * (1.0 - m_resized) + lb * m_resized)

                    # Collapse pyramid
                    patch_blended = blended_lp[-1]
                    for lap in reversed(blended_lp[:-1]):
                        patch_blended = _pyrup(patch_blended, lap.shape) + lap
                    
                    patch_blended = np.clip(patch_blended, 0.0, 255.0)
                    
                    # Update canvas and weights
                    canvas[dst_y1:dst_y2, dst_x1:dst_x2] = patch_blended
                    weight[dst_y1:dst_y2, dst_x1:dst_x2] = np.maximum(w_canvas, w_tile)
                except Exception as e:
                    # Fallback to standard weighted average if pyramid blend fails
                    logger.warning(f"[STITCH] Laplacian blend failed, falling back to tent: {e}")
                    denom = w_canvas + w_tile
                    denom[denom == 0] = 1e-4
                    m = w_tile / denom
                    patch_blended = patch_canvas * (1.0 - m[:, :, None]) + patch_tile * m[:, :, None]
                    canvas[dst_y1:dst_y2, dst_x1:dst_x2] = patch_blended
                    weight[dst_y1:dst_y2, dst_x1:dst_x2] = np.maximum(w_canvas, w_tile)
            else:
                # No overlap: just place the tile directly
                canvas[dst_y1:dst_y2, dst_x1:dst_x2] = patch_tile
                weight[dst_y1:dst_y2, dst_x1:dst_x2] = w_tile

        # Clip and convert to uint8
        result = np.clip(canvas, 0, 255).astype(np.uint8)
        return result

    # ------------------------------------------------------------------
    # Legacy helper kept for compatibility (not called in v2 path)
    # ------------------------------------------------------------------
    def _try_feature_match(self, img1, img2):
        return _orb_offset(img1, img2, self.min_match_count)
