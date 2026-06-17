/**
 * ============================================================================
 *                       URUMICAM CONTROLLER & BRIDGE
 * ============================================================================
 * 
 * Coordinates the visual integration between the CutterProd Trajectory Sender
 * and the UrumiCam Python/CV server running at http://localhost:5000.
 * 
 * FEATURES:
 * 1. Offline-First Socket.IO Loader: Automatically fetches socket.io.js from the
 *    local server, falling back to a CDN if the server is starting up or offline.
 * 2. Perspective Bed & Neon Contours Canvas: Renders corrected ArUco uploads
 *    and glowing boundaries with interactive overlay toggles.
 * 3. Drag-and-Draft ROI: Drag directly on the rectified photo to draw manual bounds.
 *    Renders a live neon-green grid overlay of serpentine scanner tiles!
 * 4. One-Click Contour Trajectory Import: Fetches the detected OpenCV vector SVG
 *    and converts it into a relative trajectory instantly via a virtual File wrapper.
 * ============================================================================
 */

import { log } from './Console.js';
import { handleFile } from './FileHandler.js';

export function setupUrumiCam(onGCodeReady) {
    const serverUrl = "http://localhost:5000";
    let socket = null;
    let bedMeta = null;
    let autoRoi = null;
    let currentRoi = null; // {x, y, w, h} in mm
    let showEdges = true;
    
    // Scan step definitions (FOV = 10x7.5mm, overlap = 28%)
    const fovX = 10.0;
    const fovY = 7.5;
    const overlap = 0.28;
    const stepX = fovX * (1 - overlap);
    const stepY = fovY * (1 - overlap);

    // Image variables
    const rectifiedImg = new Image();
    const edgesImg = new Image();
    let rectifiedImgLoaded = false;
    let edgesImgLoaded = false;

    // ROI Drag variables
    let isDrawing = false;
    let startPx = 0, startPy = 0;
    let curPx = 0, curPy = 0;

    // DOM Elements
    const tabM1 = document.getElementById('btnMethod1Tab');
    const tabM2 = document.getElementById('btnMethod2Tab');
    const panelM1 = document.getElementById('method1Controls');
    const panelM2 = document.getElementById('method2Controls');
    const feedContainer = document.getElementById('mjpegFeedContainer');
    const rectCanvas = document.getElementById('rectifiedCanvas');
    const rectCtx = rectCanvas.getContext('2d');

    const btnApplyAutoRoi = document.getElementById('btnApplyAutoRoi');
    const btnToggleContours = document.getElementById('btnToggleContours');
    const btnImportWorkpieceSvg = document.getElementById('btnImportWorkpieceSvg');
    const desktopBedUpload = document.getElementById('desktopBedUpload');
    
    const metaDpi = document.getElementById('metaDpi');
    const metaFrame = document.getElementById('metaFrame');
    const metaRoi = document.getElementById('metaRoi');
    const qrText = document.getElementById('qrText');

    // --- Dynamic Socket.IO Loader ---
    function loadSocketIO() {
        return new Promise((resolve, reject) => {
            if (window.io) return resolve(window.io);
            
            // Try loading from local Flask server first
            const script = document.createElement('script');
            script.src = `${serverUrl}/socket.io/socket.io.js`;
            script.onload = () => resolve(window.io);
            script.onerror = () => {
                console.log("[UrumiCam] Local Socket.IO failed. Trying CDN fallback...");
                // Fallback to CDN
                const fallbackScript = document.createElement('script');
                fallbackScript.src = "https://cdn.socket.io/4.7.2/socket.io.min.js";
                fallbackScript.onload = () => resolve(window.io);
                fallbackScript.onerror = () => reject(new Error("Socket.IO client library failed to load."));
                document.head.appendChild(fallbackScript);
            };
            document.head.appendChild(script);
        });
    }

    // --- Initialize ---
    async function init() {
        bindEvents();
        
        try {
            await loadSocketIO();
            connectSocket();
            fetchNetworkInfo();
        } catch (e) {
            log(`Socket.IO Load failed. Vision feedback limited: ${e.message}`, 'warning');
        }
    }

    function bindEvents() {
        // Tab switching
        tabM1.addEventListener('click', () => {
            tabM1.classList.add('active');
            tabM2.classList.remove('active');
            panelM1.classList.remove('hidden');
            panelM2.classList.add('hidden');
            feedContainer.style.display = 'flex';
            rectCanvas.style.display = 'none';
        });

        tabM2.addEventListener('click', () => {
            tabM2.classList.add('active');
            tabM1.classList.remove('active');
            panelM2.classList.remove('hidden');
            panelM1.classList.add('hidden');
            feedContainer.style.display = 'none';
            rectCanvas.style.display = 'block';
        });

        // Bed upload fallback
        desktopBedUpload.addEventListener('change', handleDirectUpload);

        // Buttons
        btnApplyAutoRoi.addEventListener('click', applyAutoRoi);
        btnToggleContours.addEventListener('click', toggleContours);
        btnImportWorkpieceSvg.addEventListener('click', importWorkpieceSvg);

        // Canvas mouse drag ROI selection
        rectCanvas.addEventListener('mousedown', startRoiDrag);
        rectCanvas.addEventListener('mousemove', updateRoiDrag);
        window.addEventListener('mouseup', endRoiDrag);
    }

    // --- WebSocket handlers ---
    function connectSocket() {
        socket = window.io(serverUrl, { reconnection: true });

        socket.on('connect', () => {
            log("[UrumiCam] Connected to camera server.", "success");
            document.getElementById('cameraOfflineState').classList.add('hidden');
            const feedImg = document.getElementById('mjpegFeed');
            if (feedImg) feedImg.style.display = 'block';
        });

        socket.on('disconnect', () => {
            log("[UrumiCam] Connection to camera server lost.", "error");
            document.getElementById('cameraOfflineState').classList.remove('hidden');
            const feedImg = document.getElementById('mjpegFeed');
            if (feedImg) feedImg.style.display = 'none';
        });

        socket.on('bed_rectified', (data) => {
            log("[UrumiCam] Perspective photo processed and aligned!", "success");
            bedMeta = data.metadata;
            autoRoi = data.auto_roi;
            
            // Update metadata display
            metaDpi.textContent = `${data.metadata.dots_per_mm * 25.4} DPI`;
            metaFrame.textContent = data.metadata.frame_size || "Medium";
            
            // Load and draw rectified images
            rectifiedImgLoaded = false;
            edgesImgLoaded = false;

            rectifiedImg.onload = () => {
                rectifiedImgLoaded = true;
                rectCanvas.width = rectifiedImg.width;
                rectCanvas.height = rectifiedImg.height;
                redrawCanvas();
            };
            rectifiedImg.src = serverUrl + data.image_url;

            edgesImg.onload = () => {
                edgesImgLoaded = true;
                redrawCanvas();
            };
            edgesImg.src = serverUrl + data.edges_image_url;

            // Enable action buttons
            if (autoRoi) {
                btnApplyAutoRoi.disabled = false;
            }
            btnImportWorkpieceSvg.disabled = false;
        });

        socket.on('scan_progress', (data) => {
            log(`[UrumiCam] Scan Progress: ${data.completed}/${data.total} tiles.`, "info");
        });

        socket.on('scan_complete', (data) => {
            log("[UrumiCam] Scan Complete! high-fidelity mosaic stitched.", "success");
        });

        socket.on('log_message', (data) => {
            console.log(`[UrumiCam CV] ${data.message}`);
        });

        socket.on('error', (data) => {
            log(`[UrumiCam Server Error] ${data.detail || data.error}`, "error");
        });
    }

    // --- Dynamic Network QR info ---
    async function fetchNetworkInfo() {
        try {
            qrText.textContent = "Fetching server address...";
            const res = await fetch(`${serverUrl}/api/network-info`);
            if (!res.ok) throw new Error();
            const data = await res.json();
            
            qrText.textContent = data.url;
            
            // Generate QR Canvas using free external API
            const qrCanvas = document.getElementById('qrCanvas');
            const ctx = qrCanvas.getContext('2d');
            const qrImg = new Image();
            qrImg.onload = () => {
                ctx.clearRect(0, 0, 150, 150);
                ctx.drawImage(qrImg, 0, 0, 150, 150);
            };
            qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(data.url)}`;
        } catch (e) {
            qrText.textContent = "Could not fetch local LAN IP";
            console.error(e);
        }
    }

    // --- Canvas Rendering & Redraw ---
    function redrawCanvas() {
        if (!rectifiedImgLoaded) return;

        rectCtx.clearRect(0, 0, rectCanvas.width, rectCanvas.height);
        
        // Draw the background rectified bed
        rectCtx.drawImage(rectifiedImg, 0, 0);

        // Draw neon outlines if enabled
        if (showEdges && edgesImgLoaded) {
            rectCtx.shadowColor = "rgba(139, 92, 246, 0.8)";
            rectCtx.shadowBlur = 8;
            rectCtx.drawImage(edgesImg, 0, 0);
            rectCtx.shadowBlur = 0; // reset
        }

        // Draw dragging ROI
        if (isDrawing) {
            const rx = Math.min(startPx, curPx);
            const ry = Math.min(startPy, curPy);
            const rw = Math.abs(startPx - curPx);
            const rh = Math.abs(startPy - curPy);
            
            rectCtx.strokeStyle = "#4ade80"; // Bright neon green for manual ROI
            rectCtx.lineWidth = 3;
            rectCtx.shadowColor = "rgba(74, 222, 128, 0.8)";
            rectCtx.shadowBlur = 6;
            rectCtx.strokeRect(rx, ry, rw, rh);
            rectCtx.shadowBlur = 0; // reset

            // Render live scan tile grid inside manually drawn ROI
            drawGridOverlay(rx, ry, rw, rh);
        } else if (currentRoi && bedMeta) {
            // Draw active confirmed ROI
            const dots = bedMeta.dots_per_mm;
            const rx = currentRoi.x * dots;
            const ry = currentRoi.y * dots;
            const rw = currentRoi.w * dots;
            const rh = currentRoi.h * dots;

            rectCtx.strokeStyle = "#10b981"; // Confirmed green
            rectCtx.lineWidth = 3;
            rectCtx.strokeRect(rx, ry, rw, rh);
            
            drawGridOverlay(rx, ry, rw, rh);
        }
    }

    function drawGridOverlay(rx, ry, rw, rh) {
        if (!bedMeta) return;
        const dots = bedMeta.dots_per_mm;

        // Calculate tile sizes in pixels
        const tileW_px = fovX * dots;
        const tileH_px = fovY * dots;
        const stepX_px = stepX * dots;
        const stepY_px = stepY * dots;

        const cols = Math.max(1, Math.ceil(rw / stepX_px));
        const rows = Math.max(1, Math.ceil(rh / stepY_px));

        rectCtx.strokeStyle = "rgba(74, 222, 128, 0.4)";
        rectCtx.lineWidth = 1;
        rectCtx.setLineDash([5, 3]);

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const tx = rx + c * stepX_px;
                const ty = ry + r * stepY_px;
                rectCtx.strokeRect(tx, ty, tileW_px, tileH_px);
            }
        }
        rectCtx.setLineDash([]); // Reset
    }

    // --- ROI Drag interactions ---
    function getCanvasCoords(e) {
        const rect = rectCanvas.getBoundingClientRect();
        const px = (e.clientX - rect.left) * (rectCanvas.width / rect.width);
        const py = (e.clientY - rect.top) * (rectCanvas.height / rect.height);
        return { px, py };
    }

    function startRoiDrag(e) {
        if (!bedMeta) return;
        isDrawing = true;
        const coords = getCanvasCoords(e);
        startPx = coords.px;
        startPy = coords.py;
        curPx = coords.px;
        curPy = coords.py;
        redrawCanvas();
    }

    function updateRoiDrag(e) {
        if (!isDrawing) return;
        const coords = getCanvasCoords(e);
        curPx = coords.px;
        curPy = coords.py;
        redrawCanvas();
        
        // Show current measurements in header/labels
        const dots = bedMeta.dots_per_mm;
        const w_mm = Math.abs(curPx - startPx) / dots;
        const h_mm = Math.abs(curPy - startPy) / dots;
        metaRoi.textContent = `${w_mm.toFixed(1)} x ${h_mm.toFixed(1)} mm`;
    }

    function endRoiDrag(e) {
        if (!isDrawing) return;
        isDrawing = false;
        
        const dots = bedMeta.dots_per_mm;
        const rx = Math.min(startPx, curPx) / dots;
        const ry = Math.min(startPy, curPy) / dots;
        const rw = Math.abs(startPx - curPx) / dots;
        const rh = Math.abs(startPy - curPy) / dots;

        if (rw > 2 && rh > 2) {
            currentRoi = { x: rx, y: ry, w: rw, h: rh };
            metaRoi.textContent = `${rw.toFixed(1)} x ${rh.toFixed(1)} mm (x:${rx.toFixed(1)}, y:${ry.toFixed(1)})`;
            
            // Sync with backend if connected
            if (socket) {
                socket.emit('on_roi_confirm', { roi: currentRoi });
            }
        } else {
            currentRoi = null;
            metaRoi.textContent = "None";
        }
        redrawCanvas();
    }

    // --- Action Button triggers ---
    function applyAutoRoi() {
        if (!autoRoi || !bedMeta) return;
        currentRoi = autoRoi;
        
        const rx = autoRoi.x;
        const ry = autoRoi.y;
        const rw = autoRoi.w;
        const rh = autoRoi.h;
        
        metaRoi.textContent = `${rw.toFixed(1)} x ${rh.toFixed(1)} mm (Auto)`;
        log(`Auto-ROI applied around workpiece boundary: ${rw.toFixed(1)}x${rh.toFixed(1)}mm.`, "success");
        redrawCanvas();
        
        if (socket) {
            socket.emit('on_roi_confirm', { roi: currentRoi });
        }
    }

    function toggleContours() {
        showEdges = !showEdges;
        btnToggleContours.textContent = showEdges ? "👁️ Hide Neon Outlines" : "👁️ Show Neon Outlines";
        btnToggleContours.classList.toggle('active', showEdges);
        redrawCanvas();
    }

    async function importWorkpieceSvg() {
        const svgUrl = `${serverUrl}/uploads/rectified_edges.svg?t=${Date.now()}`;
        
        try {
            log("Fetching workpiece vector boundary SVG...", "info");
            const res = await fetch(svgUrl);
            if (!res.ok) throw new Error("Workpiece SVG not found on UrumiCam server.");
            
            const svgText = await res.text();
            
            // Create a virtual file object to reuse existing FileHandler.js logic perfectly!
            const virtualFile = new File([svgText], "rectified_edges.svg", { type: "image/svg+xml" });
            
            log("Importing boundary into SvgConverter...", "info");
            
            // Call the core onGCodeReady function passed from script.js
            handleFile(virtualFile, onGCodeReady, window.switchTab);
            
            log("Workpiece vectors imported successfully!", "success");
        } catch (e) {
            log(`Workpiece Import Failed: ${e.message}`, "error");
            alert(`Failed to import workpiece: ${e.message}`);
        }
    }

    // --- Fallback direct photo uploader ---
    async function handleDirectUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        log(`Uploading photo directly to UrumiCam Rectifier...`, 'info');
        const formData = new FormData();
        formData.append('file', file);
        formData.append('frame_size', 'Medium'); // Default to medium

        try {
            const res = await fetch(`${serverUrl}/api/method2/upload`, {
                method: 'POST',
                body: formData
            });
            
            if (!res.ok) throw new Error();
            log(`Photo uploaded successfully. Awaiting alignment and perspective warping...`, 'success');
        } catch (err) {
            log(`Upload failed. Make sure UrumiCam server is running on port 5000.`, 'error');
        }
    }

    // Return init to boot from script.js
    return { init };
}
