# Vision — Phone Camera over WebRTC

Captures a photo on a phone and delivers it directly into the UrumiCutter PC
browser canvas. **No server, no second app** — pure browser-to-browser WebRTC.

## Flow
1. User clicks the **Vision** draw-tool button (`#dtVision`).
2. App opens `#visionQrModal`, creates a PeerJS peer, and renders a QR pointing to
   the GitHub-hosted phone app: `https://joginfrancis.github.io/photoshare/mobile.html?id=<peerId>`.
3. Phone scans QR → opens that page → takes a photo → sends it over the WebRTC
   data channel (`meta` → binary chunks → `done`).
4. PC browser reassembles the chunks into a Blob and injects it onto the canvas
   via `canvasEditor.addImage()`. Image processing happens later, in-browser.

## Implementation (all in CutterProd/src)
- `script.js` — `initPeerConnection()` + receive handlers (already existed).
  ICE config now includes the openrelay TURN relay so a phone on 4G/another
  network can connect (STUN-only only works on the same LAN).
- `index.html` — added the PeerJS CDN `<script>`, the `#visionQrModal` markup,
  and removed the stale `window.open('http://localhost:5000')` from `#dtVision`.

## Dependencies (phone needs internet)
- PeerJS 1.5.2 (CDN) + peerjs.com signaling.
- QR image from `api.qrserver.com`.
- TURN relay `openrelay.metered.ca` (free; swap for a private TURN for production).

## Connection lifecycle
- Closing the popup (✕ / backdrop / after "Add to Canvas") calls `closeVisionModal()`,
  which closes the data connection and `peer.destroy()`s the peer (sets both null).
- Reopening Vision always re-inits (`if (!peer) initPeerConnection()`), so each open is a
  fresh peer with a new QR and accepts a new phone connection / new photo.

## Interactive crop + perspective flatten (pure JS — NO OpenCV)
Replaces ArUco. After a photo arrives the popup shows the photo with a draggable
4-corner overlay (CamScanner / Google-Docs style), a paper-size picker
(A4 / A3 / A5 / Letter / Custom mm), and a **Crop, Flatten & Add to Canvas** button.

> OpenCV.js was removed: loading it (~8 MB + synchronous WASM compile) froze the
> renderer. Everything below is plain JS/Canvas — no heavy dependency, no freeze.

UI / interaction (`script.js`) — **canvas-rendered with a view transform**:
- The photo is drawn ONTO `#visionCropCanvas` under a zoom/pan transform
  (`cropView = {z, ox, oy, baseScale}`). Image, handles, and loupe all live in one
  coordinate space via `imgToScreen()` / `screenToImg()`. This replaced an `<img>` +
  `object-fit:contain`, whose letterboxing made the corner land away from the loupe.
- `fitCropView()` fits the whole photo at z=1 and centres it.
- Wheel = zoom about the cursor (z 1–8); drag empty area = pan (`clampCropPan`);
  drag a handle = move that corner. `updateLoupe()` shows a 2× magnifier that tracks
  the current zoom, positioned at the handle's screen location.
- Corners are always stored in image-natural px, so the flatten is unaffected by zoom.

### Live page detection (phone) → corner pre-fill (PC) — IMPLEMENTED
The phone viewfinder (GitHub repo `joginfrancis/photoshare`, `mobile.html`) runs a
pure-JS detector in a **Web Worker** (no OpenCV): grayscale → Sobel → extreme-points
of the strong-edge cloud → 4 page corners (tl,tr,br,bl), ~6–8 fps. It draws a live
overlay on `#detect-canvas` (blue tracking → green "Page detected" lock at conf>0.30).
On capture, the detected quad is mapped from the proc frame to captured-image px and
sent in the `meta` message as `corners: [{x,y}×4]` (or `null`).

PC side (`script.js`): the receive handler passes `fileMeta.corners` into
`showVisionPreview(img, corners)`, which validates them (4 finite points within the
image) and initialises `cropCorners` to them — so the cropper opens **pre-snapped to
the page** ("Page auto-detected"). Invalid/absent → default inset rectangle. The user
can always fine-tune before flattening.

Note: the extreme-point detector is accurate when the page fills the frame (verified
~1px on synthetic input); it needs on-device tuning for cluttered backgrounds. Upgrade
path = trimmed OpenCV.js (core+imgproc, ~1–2 MB) in the worker if needed.

### Planned: computer-vision auto edge-snap — superseded by the above for the phone
Goal: auto-place the 4 corners (and let a dragged corner "snap" to the nearest real
edge), without the OpenCV freeze. Approach:
1. Run detection in a **Web Worker** (OffscreenCanvas) so the UI never blocks.
2. Downscale the photo to ~600 px. Grayscale → Sobel/Scharr gradient → light blur.
3. Global guess: Hough-style line voting OR largest-quad via a small contour pass;
   pick 4 dominant near-orthogonal lines, intersect → candidate corners.
4. Per-corner snap on drag: sample a small window around the dragged corner, find the
   strongest local gradient maximum / line intersection, pull the corner to it
   (magnetic snap within ~15 px), shown live in the loupe.
5. Fallback to the current manual rectangle if confidence is low.
Implementation candidates: hand-written Sobel+Hough in the worker (no dep), or a tiny
WASM edge lib. Keep it opt-in via an "Auto-detect" button so the manual flow always works.

Flatten math (all in `script.js`, no libs):
- `_solveHomography(dst, src)` — 8×8 Gaussian elimination for the projective transform.
- `_drawTexTriangle()` — affine-maps the source photo onto each output triangle.
- `addVisionToCanvas()` tessellates the output paper rectangle into a 24×24 grid and
  texture-maps each cell from the source → perspective-correct flattened raster
  (~6 px/mm). Inserted at the real paper size in mm, centered on the bed.

## Verified
- WebRTC: PeerJS loads, peer opens, QR renders, receive handler fires, teardown on close.
- Cropper: overlay canvas sizes correctly; dragging the top-left handle moved corner 0
  to the target and showed/hid the loupe; flatten of a synthetic skewed A4 produced a
  1260×1782 raster placed at exactly 210×297 mm centered on the bed; modal auto-closed.
