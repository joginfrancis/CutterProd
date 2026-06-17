"""
Stitch GSCam dataset using the newly unified MosaicStitcher Spanning Tree BFS solver.

Usage:
    python test_stitch_gscam.py
"""

import sys
import re
import time
from pathlib import Path
from types import SimpleNamespace

# Bootstrap the stitcher from the project root
sys.path.insert(0, str(Path(__file__).parent))
from server.stitcher import MosaicStitcher

SCAN_DIR = Path(__file__).parent / "scans" / "Stitch_GSCam"

def load_gscam_tiles():
    """Gather all serpentine x*y*.jpg tiles and build mock Tile objects."""
    pattern = re.compile(r"x(\d+)y(\d+)\.jpg")
    tiles = []
    
    for f in SCAN_DIR.glob("x*y*.jpg"):
        m = pattern.match(f.name)
        if m:
            col, row = int(m.group(1)), int(m.group(2))
            # GSCam tiles are named with col/row, and we map them to Tile namespace
            tile = SimpleNamespace(
                row         = row,
                col         = col,
                center_x_mm = float(col * 10),  # dummy mm coords
                center_y_mm = float(row * 10),
                image_path  = str(f),
                status      = SimpleNamespace(value="complete"),
            )
            tiles.append(tile)
            
    return tiles

def main():
    print("=" * 60)
    print("  UrumiCam — Stitching GSCam with Spanning Tree BFS")
    print("=" * 60)

    tiles = load_gscam_tiles()
    if not tiles:
        print("[FAIL] No GSCam tiles found.")
        sys.exit(1)
        
    print(f"  Loaded {len(tiles)} tiles from {SCAN_DIR}...")

    # Test the MosaicStitcher with standard settings, confirming automatic GSCam detection
    config = {
        "min_match_count": 8,
        "stitch_method": "phase+orb",
    }

    stitcher = MosaicStitcher(config)

    t0 = time.perf_counter()
    out_path = stitcher.stitch(tiles, SCAN_DIR)
    elapsed = time.perf_counter() - t0

    if out_path:
        size_mb = Path(out_path).stat().st_size / 1_048_576
        print(f"\n  [OK] GSCam Mosaic saved -> {out_path}")
        print(f"    Size  : {size_mb:.2f} MB")
        print(f"    Time  : {elapsed:.2f}s")
    else:
        print("\n  [FAIL] Stitching failed -- check logs above")
        sys.exit(1)

if __name__ == "__main__":
    import logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )
    main()
