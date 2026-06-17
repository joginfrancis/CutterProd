/**
 * ============================================================================
 *  URUMICAM — METHOD 2 CONTROLLER (MOBILE PHOTO & ARUCO ALIGNMENT)
 * ============================================================================
 * Coordinates the tab states, QR code generation, image upload, 
 * and interactive perspective-corrected ROI drafting workspace.
 * ============================================================================
 */

const Method2Controller = (() => {
    let active = false;
    
    // DOM Elements
    let tabM1 = null;
    let tabM2 = null;
    let feedM1 = null;
    let workspaceM2 = null;
    let setupM2 = null;
    let viewM2 = null;
    
    let qrCanvas = null;
    let qrSpinner = null;
    let desktopUploadInput = null;
    let btnResetBed = null;
    let btnApplyAutoRoi = null;
    let btnToggleSvg = null;
    let btnDownloadSvg = null;
    let btnSendToCutter = null;
    
    let rectCanvas = null;
    let rectCtx = null;
    
    // Meta Displays
    let metaFrameName = null;
    let metaWorkspaceSize = null;
    let metaDpiScale = null;
    let metaProjError = null;

    // State Variables
    let rectifiedImg = new Image();
    let edgesImg = null; // Holds the transparent edges overlay
    let svgUrl = null; // Holds path to SVG vector edges
    let showEdges = true; // Toggle state for rendering edges
    let bedMeta = null; // Holds dots_per_mm, physical_width/height, etc.
    let isDrawing = false;
    let startPx = 0;
    let startPy = 0;
    let curPx = 0;
    let curPy = 0;
    
    // Dragged ROI in mm
    let currentRoi = null; // {x, y, w, h}
    let autoRoi = null; // Stored Auto-ROI from server
    
    // Active scan tracking
    let activeScanTiles = {}; // "row_col" -> status
    let activeGridRows = 0;
    let activeGridCols = 0;
    let completedTileImages = {}; // "row_col" -> HTMLImageElement

    function init() {
        // Tabs
        tabM1 = document.getElementById('tabMethod1');
        tabM2 = document.getElementById('tabMethod2');
        feedM1 = document.getElementById('cameraFeed');
        workspaceM2 = document.getElementById('method2Workspace');
        
        // Workspace Panels
        setupM2 = document.getElementById('method2Setup');
        viewM2 = document.getElementById('method2View');
        
        // QR & Uploads
        qrCanvas = document.getElementById('qrCanvas');
        qrSpinner = document.getElementById('qrSpinner');
        desktopUploadInput = document.getElementById('desktopBedUpload');
        btnResetBed = document.getElementById('btnResetBed');
        btnApplyAutoRoi = document.getElementById('btnApplyAutoRoi');
        btnToggleSvg = document.getElementById('btnToggleSvg');
        btnDownloadSvg = document.getElementById('btnDownloadSvg');
        btnSendToCutter = document.getElementById('btnSendToCutter');
        
        // Canvas
        rectCanvas = document.getElementById('rectifiedCanvas');
        rectCtx = rectCanvas.getContext('2d');
        
        // Meta
        metaFrameName = document.getElementById('metaFrameName');
        metaWorkspaceSize = document.getElementById('metaWorkspaceSize');
        metaDpiScale = document.getElementById('metaDpiScale');
        metaProjError = document.getElementById('metaProjError');

        // Event Bindings
        tabM1.addEventListener('click', () => switchTab('method1'));
        tabM2.addEventListener('click', () => switchTab('method2'));
        
        desktopUploadInput.addEventListener('change', handleDirectUpload);
        btnResetBed.addEventListener('click', resetBedPhoto);
        if (btnApplyAutoRoi) btnApplyAutoRoi.addEventListener('click', applyAutoRoi);
        if (btnToggleSvg) btnToggleSvg.addEventListener('click', toggleSvgEdges);
        if (btnDownloadSvg) btnDownloadSvg.addEventListener('click', downloadSvg);
        if (btnSendToCutter) btnSendToCutter.addEventListener('click', sendToCutter);

        // Canvas ROI mouse actions
        rectCanvas.addEventListener('mousedown', startRoiDrag);
        rectCanvas.addEventListener('mousemove', updateRoiDrag);
        window.addEventListener('mouseup', endRoiDrag);
        
        // Touch events for tablets/mobiles
        rectCanvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                const rect = rectCanvas.getBoundingClientRect();
                const touch = e.touches[0];
                const mouseEvent = new MouseEvent('mousedown', {
                    clientX: touch.clientX,
                    clientY: touch.clientY
                });
                rectCanvas.dispatchEvent(mouseEvent);
            }
        });
        rectCanvas.addEventListener('touchmove', (e) => {
            if (e.touches.length === 1) {
                const rect = rectCanvas.getBoundingClientRect();
                const touch = e.touches[0];
                const mouseEvent = new MouseEvent('mousemove', {
                    clientX: touch.clientX,
                    clientY: touch.clientY
                });
                rectCanvas.dispatchEvent(mouseEvent);
                e.preventDefault(); // Stop page scrolling while drawing ROI
            }
        }, { passive: false });
        rectCanvas.addEventListener('touchend', () => {
            const mouseEvent = new MouseEvent('mouseup', {});
            window.dispatchEvent(mouseEvent);
        });

        // WebSocket events
        WS.on('bed_rectified', (data) => {
            handleBedRectified(data);
        });

        WS.on('tile_update', (data) => {
            if (bedMeta) {
                const key = `${data.row}_${data.col}`;
                activeScanTiles[key] = data.status;
                activeGridRows = Math.max(activeGridRows, data.row + 1);
                activeGridCols = Math.max(activeGridCols, data.col + 1);
                
                // If this tile is completed and has a valid image_path, load it!
                if (data.status === 'complete' && data.image_path) {
                    let url = data.image_path.replace(/\\/g, '/');
                    const idx = url.indexOf('scans/');
                    if (idx !== -1) {
                        url = '/' + url.slice(idx);
                    } else {
                        url = '/scans/' + url;
                    }
                    
                    const img = new Image();
                    img.onload = () => {
                        completedTileImages[key] = img;
                        renderWorkspace();
                    };
                    img.src = url;
                } else {
                    renderWorkspace();
                }
            }
        });
        
        WS.on('scan_reset', () => {
            activeScanTiles = {};
            activeGridRows = 0;
            activeGridCols = 0;
            completedTileImages = {}; // Clear completed tile images
            renderWorkspace();
        });

        // Pull settings change event to re-draw grid preview in real-time
        const settingsInputs = ['setTileFovX', 'setTileFovY', 'setOverlap'];
        settingsInputs.forEach(id => {
            document.getElementById(id)?.addEventListener('input', () => {
                if (currentRoi) renderWorkspace();
            });
        });
    }

    function switchTab(method) {
        if (method === 'method1') {
            active = false;
            tabM1.classList.add('active');
            tabM2.classList.remove('active');
            feedM1.classList.remove('hidden');
            workspaceM2.classList.add('hidden');
            CameraFeed.startPreview();
            LogPanel.addLine('Switched to Method 1 (Gantry Camera)', 'info');
        } else {
            active = true;
            tabM1.classList.remove('active');
            tabM2.classList.add('active');
            feedM1.classList.add('hidden');
            workspaceM2.classList.remove('hidden');
            CameraFeed.stopPreview();
            LogPanel.addLine('Switched to Method 2 (Mobile ArUco Bed)', 'info');
            
            // If no bed is loaded, fetch network info for QR
            if (!bedMeta) {
                generateQrCode();
            } else {
                sizeCanvas();
                renderWorkspace();
            }
        }
    }

    function generateQrCode() {
        qrSpinner.classList.remove('hidden');
        qrCanvas.style.opacity = '0.3';
        
        fetch('/api/network-info')
            .then(r => r.json())
            .then(data => {
                qrSpinner.classList.add('hidden');
                qrCanvas.style.opacity = '1';
                
                // Clear existing QR code canvas
                qrCanvas.width = 160;
                qrCanvas.height = 160;
                
                new QRious({
                    element: qrCanvas,
                    value: data.url,
                    size: 160,
                    background: '#111827',
                    foreground: '#3b82f6',
                    level: 'H'
                });
                qrCanvas.style.borderRadius = '';
                qrCanvas.style.padding = '';
                qrCanvas.style.backgroundColor = '';
                LogPanel.addLine(`QR code generated for mobile sync: ${data.url}`, 'info');
            })
            .catch(err => {
                qrSpinner.innerText = 'Failed to generate QR';
                LogPanel.addLine('Failed to retrieve network details for QR generation', 'error');
            });
    }

    function handleDirectUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        LogPanel.addLine('Uploading machine bed photo directly...', 'info');
        const formData = new FormData();
        formData.append('image', file);

        fetch('/api/method2/upload', {
            method: 'POST',
            body: formData
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                LogPanel.addLine(`Direct upload processed successfully: ${data.frame_name} frame`, 'success');
                // The server will also broadcast 'bed_rectified' via WS, which we handle
            } else {
                LogPanel.addLine(`Rectification error: ${data.message}`, 'error');
                alert(`ArUco Rectification Failed!\n\n${data.message}`);
            }
        })
        .catch(err => {
            LogPanel.addLine('Direct upload failed due to server or network error', 'error');
        });
    }

    function handleBedRectified(data) {
        bedMeta = data;
        
        // Show meta
        metaFrameName.textContent = data.frame_name;
        metaWorkspaceSize.textContent = `${data.physical_width} x ${data.physical_height} mm`;
        metaDpiScale.textContent = `${data.dpi} DPI (${data.dots_per_mm.toFixed(1)} px/mm)`;
        metaProjError.textContent = `${data.error_mm.toFixed(3)} mm`;

        // Switch panels
        setupM2.classList.add('hidden');
        viewM2.classList.remove('hidden');

        // Push to Method 1 Scan Grid (Left Panel)
        if (typeof TileGrid !== 'undefined' && TileGrid.setBedBackground) {
            TileGrid.setBedBackground(data, data.image_url, data.edges_image_url);
        }

        // Load transparent edges overlay (Prefer SVG if available)
        svgUrl = data.edges_svg_url || null;
        if (svgUrl || data.edges_image_url) {
            edgesImg = new Image();
            edgesImg.onload = () => {
                renderWorkspace();
            };
            edgesImg.src = svgUrl || data.edges_image_url;
            showEdges = true;
            if (btnToggleSvg) {
                btnToggleSvg.classList.remove('hidden');
                btnToggleSvg.innerHTML = '<i data-lucide="eye-off"></i> Hide SVG Edges';
                lucide.createIcons();
            }
            if (btnDownloadSvg && svgUrl) {
                btnDownloadSvg.classList.remove('hidden');
                if (btnSendToCutter) btnSendToCutter.classList.remove('hidden');
            }
        } else {
            edgesImg = null;
            svgUrl = null;
            if (btnToggleSvg) btnToggleSvg.classList.add('hidden');
            if (btnDownloadSvg) btnDownloadSvg.classList.add('hidden');
            if (btnSendToCutter) btnSendToCutter.classList.add('hidden');
        }

        // Load image
        rectifiedImg = new Image();
        rectifiedImg.onload = () => {
            sizeCanvas();
            // Load auto-detected ROI if present
            if (data.detected_roi) {
                autoRoi = data.detected_roi;
                if (btnApplyAutoRoi) btnApplyAutoRoi.classList.remove('hidden');
                clearRoi(); // Start clear so user can choose to click it or drag manually
            } else {
                autoRoi = null;
                if (btnApplyAutoRoi) btnApplyAutoRoi.classList.add('hidden');
                clearRoi();
            }
            renderWorkspace();
        };
        rectifiedImg.src = data.image_url;

        // Auto force active Method 2 tab if not yet active
        if (!active) {
            switchTab('method2');
        }
    }

    function toggleSvgEdges() {
        showEdges = !showEdges;
        if (btnToggleSvg) {
            btnToggleSvg.innerHTML = showEdges ? 
                '<i data-lucide="eye-off"></i> Hide SVG Edges' : 
                '<i data-lucide="eye"></i> Show SVG Edges';
            lucide.createIcons();
        }
        renderWorkspace();
    }

    function downloadSvg() {
        if (!svgUrl) return;
        const a = document.createElement('a');
        a.href = svgUrl;
        a.download = 'workpiece_edges.svg';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        LogPanel.addLine('SVG edges downloaded.', 'success');
    }

    function sendToCutter() {
        if (!svgUrl) return;
        WS.emit('send_to_cutter', { svg_url: svgUrl });
        LogPanel.addLine('Sent SVG edge vectors directly to CutterProd!', 'success');
    }

    function applyAutoRoi() {
        if (!autoRoi || !bedMeta) return;
        currentRoi = autoRoi;
        
        const x1 = currentRoi.x;
        const y1 = currentRoi.y;
        const x2 = x1 + currentRoi.w;
        const y2 = y1 + currentRoi.h;
        
        document.getElementById('roiTlX').value = x1.toFixed(3);
        document.getElementById('roiTlY').value = y1.toFixed(3);
        document.getElementById('roiBrX').value = x2.toFixed(3);
        document.getElementById('roiBrY').value = y2.toFixed(3);
        
        document.getElementById('roiTlDisplay').textContent = `X:${x1.toFixed(2)} Y:${y1.toFixed(2)}`;
        document.getElementById('roiBrDisplay').textContent = `X:${x2.toFixed(2)} Y:${y2.toFixed(2)}`;
        
        LogPanel.addLine('Auto-ROI perfectly snapped to workpiece edges.', 'success');
        renderWorkspace();
    }

    function resetBedPhoto() {
        if (confirm('Discard current bed photo and upload a new one?')) {
            bedMeta = null;
            currentRoi = null;
            autoRoi = null;
            edgesImg = null;
            if (btnApplyAutoRoi) btnApplyAutoRoi.classList.add('hidden');
            if (btnSendToCutter) btnSendToCutter.classList.add('hidden');
            activeScanTiles = {};
            activeGridRows = 0;
            activeGridCols = 0;
            completedTileImages = {}; // Clear completed tile images
            clearRoi();
            setupM2.classList.remove('hidden');
            viewM2.classList.add('hidden');
            generateQrCode();
            LogPanel.addLine('Bed photo reset. Waiting for new upload.', 'info');
        }
    }

    function sizeCanvas() {
        if (!bedMeta) return;
        
        const container = rectCanvas.parentElement;
        const aspect = bedMeta.physical_height / bedMeta.physical_width;
        
        // Constrain height based on width
        const width = container.clientWidth;
        const height = width * aspect;
        
        rectCanvas.width = width;
        rectCanvas.height = height;
        rectCanvas.style.width = width + 'px';
        rectCanvas.style.height = height + 'px';
    }

    function clearRoi() {
        document.getElementById('roiTlX').value = '';
        document.getElementById('roiTlY').value = '';
        document.getElementById('roiBrX').value = '';
        document.getElementById('roiBrY').value = '';
        
        document.getElementById('roiTlDisplay').textContent = 'not set';
        document.getElementById('roiBrDisplay').textContent = 'not set';
        currentRoi = null;
    }

    // ── Mouse Drag ROI Handling ──────────────────────────────────────────

    function startRoiDrag(e) {
        if (isScanning() || !bedMeta) return;
        isDrawing = true;
        
        const rect = rectCanvas.getBoundingClientRect();
        startPx = e.clientX - rect.left;
        startPy = e.clientY - rect.top;
        curPx = startPx;
        curPy = startPy;
    }

    function updateRoiDrag(e) {
        if (!isDrawing) return;
        
        const rect = rectCanvas.getBoundingClientRect();
        curPx = Math.max(0, Math.min(rectCanvas.width, e.clientX - rect.left));
        curPy = Math.max(0, Math.min(rectCanvas.height, e.clientY - rect.top));
        
        // Calculate raw mm coordinates
        const scaleX = bedMeta.physical_width / rectCanvas.width;
        const scaleY = bedMeta.physical_height / rectCanvas.height;
        
        const x1 = Math.min(startPx, curPx) * scaleX;
        const y1 = Math.min(startPy, curPy) * scaleY;
        const w = Math.abs(startPx - curPx) * scaleX;
        const h = Math.abs(startPy - curPy) * scaleY;
        
        currentRoi = { x: x1, y: y1, w: w, h: h };
        
        // Update input boxes instantly
        const x2 = x1 + w;
        const y2 = y1 + h;
        document.getElementById('roiTlX').value = x1.toFixed(3);
        document.getElementById('roiTlY').value = y1.toFixed(3);
        document.getElementById('roiBrX').value = x2.toFixed(3);
        document.getElementById('roiBrY').value = y2.toFixed(3);
        
        document.getElementById('roiTlDisplay').textContent = `X:${x1.toFixed(2)} Y:${y1.toFixed(2)}`;
        document.getElementById('roiBrDisplay').textContent = `X:${x2.toFixed(2)} Y:${y2.toFixed(2)}`;
        
        renderWorkspace();
    }

    function endRoiDrag() {
        if (!isDrawing) return;
        isDrawing = false;
        
        if (currentRoi && (currentRoi.w < 2 || currentRoi.h < 2)) {
            // Drag was too small, register as click-clear
            clearRoi();
            renderWorkspace();
            LogPanel.addLine('ROI cleared.', 'info');
        } else if (currentRoi) {
            LogPanel.addLine(`ROI drawn visually: (${currentRoi.x.toFixed(1)}, ${currentRoi.y.toFixed(1)}) to ` +
                             `(${(currentRoi.x + currentRoi.w).toFixed(1)}, ${(currentRoi.y + currentRoi.h).toFixed(1)}) mm`, 'info');
        }
    }

    function isScanning() {
        const btnAbort = document.getElementById('btnAbortScan');
        return btnAbort && !btnAbort.classList.contains('hidden');
    }

    // ── Drawing logic ─────────────────────────────────────────────────────

    function renderWorkspace() {
        if (!rectCtx || !bedMeta || !rectifiedImg.complete) return;
        
        const w = rectCanvas.width;
        const h = rectCanvas.height;
        
        rectCtx.clearRect(0, 0, w, h);
        
        // 1. Draw physical bed rectified background
        rectCtx.drawImage(rectifiedImg, 0, 0, w, h);
        
        // 2. Draw workpiece edges detection overlay if loaded and toggled on
        if (showEdges && edgesImg && edgesImg.complete) {
            rectCtx.drawImage(edgesImg, 0, 0, w, h);
        }
        
        // 3. Draw selection ROI bounding box
        if (currentRoi) {
            const scaleX = w / bedMeta.physical_width;
            const scaleY = h / bedMeta.physical_height;
            
            const rx = currentRoi.x * scaleX;
            const ry = currentRoi.y * scaleY;
            const rw = currentRoi.w * scaleX;
            const rh = currentRoi.h * scaleY;
            
            // Neon blue glow bounding box
            rectCtx.save();
            rectCtx.strokeStyle = '#3b82f6';
            rectCtx.lineWidth = 2;
            rectCtx.shadowColor = '#3b82f6';
            rectCtx.shadowBlur = 8;
            rectCtx.strokeRect(rx, ry, rw, rh);
            
            // Faint inner tint
            rectCtx.fillStyle = 'rgba(59, 130, 246, 0.08)';
            rectCtx.fillRect(rx, ry, rw, rh);
            rectCtx.restore();
            
            // 3. Draw visual tile scan grid overlap preview!
            drawGridPreview(scaleX, scaleY);
        }
        
        // 4. Render active gantry scanning tiles (if a scan is running)
        drawActiveGrid();
    }

    function drawGridPreview(scaleX, scaleY) {
        if (!currentRoi) return;
        
        // Read FOV size from Settings panel directly
        const fovX = parseFloat(document.getElementById('setTileFovX').value) || 10.0;
        const fovY = parseFloat(document.getElementById('setTileFovY').value) || 7.5;
        const overlapPct = parseFloat(document.getElementById('setOverlap').value) || 28;
        
        const overlapFraction = overlapPct / 100;
        const stepX = fovX * (1 - overlapFraction);
        const stepY = fovY * (1 - overlapFraction);
        
        const cols = Math.ceil(currentRoi.w / stepX) + 1;
        const rows = Math.ceil(currentRoi.h / stepY) + 1;
        
        rectCtx.save();
        rectCtx.strokeStyle = 'rgba(16, 185, 129, 0.4)'; // Neon green
        rectCtx.lineWidth = 1;
        rectCtx.setLineDash([4, 4]);
        
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                // Calculate physical corner coords
                const tx = currentRoi.x + col * stepX;
                const ty = currentRoi.y + row * stepY;
                
                // Project to canvas pixels
                const px = tx * scaleX;
                const py = ty * scaleY;
                const pw = fovX * scaleX;
                const ph = fovY * scaleY;
                
                rectCtx.strokeRect(px, py, pw, ph);
            }
        }
        rectCtx.restore();
        
        // Overlay total count
        rectCtx.fillStyle = '#ffffff';
        rectCtx.font = '600 11px sans-serif';
        rectCtx.shadowColor = '#000000';
        rectCtx.shadowBlur = 4;
        rectCtx.fillText(`Grid: ${rows} x ${cols} = ${rows * cols} tiles`, 12, 24);
    }

    function drawActiveGrid() {
        if (activeGridRows === 0 || activeGridCols === 0 || !bedMeta || !currentRoi) return;
        
        const w = rectCanvas.width;
        const h = rectCanvas.height;
        const scaleX = w / bedMeta.physical_width;
        const scaleY = h / bedMeta.physical_height;

        const fovX = parseFloat(document.getElementById('setTileFovX').value) || 10.0;
        const fovY = parseFloat(document.getElementById('setTileFovY').value) || 7.5;
        const overlapPct = parseFloat(document.getElementById('setOverlap').value) || 28;
        
        const overlapFraction = overlapPct / 100;
        const stepX = fovX * (1 - overlapFraction);
        const stepY = fovY * (1 - overlapFraction);
        
        // Colors mapping
        const STATES = {
            pending:      { fill: 'rgba(255,255,255,0.02)', stroke: 'rgba(255,255,255,0.08)' },
            targeting:    { fill: 'rgba(88,166,255,0.3)',   stroke: '#58a6ff' },
            settling:     { fill: 'rgba(210,153,34,0.35)',  stroke: '#d29922' },
            capturing:    { fill: 'rgba(63,185,80,0.35)',   stroke: '#3fb950' },
            complete:     { fill: 'rgba(63,185,80,0.15)',   stroke: 'rgba(63,185,80,0.25)' },
            failed_focus: { fill: 'rgba(210,153,34,0.35)',  stroke: '#d29922' },
            failed_motor: { fill: 'rgba(248,81,73,0.35)',   stroke: '#f85149' },
        };

        rectCtx.save();
        for (let row = 0; row < activeGridRows; row++) {
            for (let col = 0; col < activeGridCols; col++) {
                const key = `${row}_${col}`;
                const status = activeScanTiles[key] || 'pending';
                const colors = STATES[status] || STATES.pending;
                
                const tx = currentRoi.x + col * stepX;
                const ty = currentRoi.y + row * stepY;
                
                const px = tx * scaleX;
                const py = ty * scaleY;
                const pw = fovX * scaleX;
                const ph = fovY * scaleY;
                
                // Draw tile image if complete and loaded
                if (status === 'complete' && completedTileImages[key] && completedTileImages[key].complete) {
                    rectCtx.drawImage(completedTileImages[key], px, py, pw, ph);
                    
                    // Faint border overlay
                    rectCtx.strokeStyle = 'rgba(63, 185, 80, 0.2)';
                    rectCtx.lineWidth = 1;
                    rectCtx.strokeRect(px, py, pw, ph);
                } else {
                    rectCtx.fillStyle = colors.fill;
                    rectCtx.fillRect(px, py, pw, ph);
                    
                    rectCtx.strokeStyle = colors.stroke;
                    rectCtx.lineWidth = status === 'targeting' || status === 'settling' ? 2 : 1;
                    rectCtx.strokeRect(px, py, pw, ph);
                }
            }
        }
        rectCtx.restore();
    }

    return { init };
})();
