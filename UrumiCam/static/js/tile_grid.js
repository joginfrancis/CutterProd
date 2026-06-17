/**
 * ============================================================================
 *  URUMICAM — TILE GRID RENDERER
 * ============================================================================
 * Canvas-based tile grid with colour-coded states, dashed ROI overlay,
 * and MANDATORY settling pulse animation.
 *
 * Tile Colour States:
 *   pending      — transparent, neutral border
 *   targeting    — blue fill, blue border
 *   settling     — amber fill, amber border, PULSING ANIMATION
 *   capturing    — green fill, green border
 *   complete     — green fill, faint border
 *   failed_focus — amber fill, amber border, "!F" label
 *   failed_motor — red fill, red border, "!M" label
 * ============================================================================
 */

const TileGrid = (() => {
    // Colour definitions per tile state
    const COLORS = {
        pending:      { fill: 'rgba(255,255,255,0.03)', stroke: 'rgba(255,255,255,0.08)', label: null },
        targeting:    { fill: 'rgba(88,166,255,0.25)',   stroke: '#58a6ff',                label: null },
        settling:     { fill: 'rgba(210,153,34,0.3)',    stroke: '#d29922',                label: null },
        capturing:    { fill: 'rgba(63,185,80,0.3)',     stroke: '#3fb950',                label: null },
        complete:     { fill: 'rgba(63,185,80,0.15)',    stroke: 'rgba(63,185,80,0.3)',    label: null },
        failed_focus: { fill: 'rgba(210,153,34,0.3)',    stroke: '#d29922',                label: '!F' },
        failed_motor: { fill: 'rgba(248,81,73,0.3)',     stroke: '#f85149',                label: '!M' },
    };

    let canvas = null;
    let ctx = null;
    let container = null;
    let emptyState = null;
    let tiles = {};         // Map: "row_col" -> tile data
    let gridRows = 0;
    let gridCols = 0;
    let roi = null;         // ROI bounding box data
    let animFrame = null;
    let pulsePhase = 0;
    let stitchedImg = null; // Stitched mosaic image for Method 1
    let mosaicEdgesImg = null; // Stitched mosaic edges overlay for Method 1
    
    let bedBgMeta = null;
    let bedBgImg = null;
    let bedEdgesImg = null;

    function init() {
        canvas = document.getElementById('tileCanvas');
        ctx = canvas.getContext('2d');
        container = document.getElementById('gridContainer');
        emptyState = document.getElementById('gridEmptyState');

        // Wire WebSocket events
        WS.on('tile_update', (data) => {
            const key = `${data.row}_${data.col}`;
            tiles[key] = data;

            // Track grid dimensions
            gridRows = Math.max(gridRows, data.row + 1);
            gridCols = Math.max(gridCols, data.col + 1);

            if (emptyState) emptyState.classList.add('hidden');
            requestRender();
        });

        WS.on('roi_overlay', (data) => {
            roi = data;
            requestRender();
        });

        WS.on('scan_progress', (data) => {
            document.getElementById('tileCount').textContent = `${data.completed} / ${data.total}`;
        });

        WS.on('scan_complete', (data) => {
            if (data.mosaic_path) {
                let url = data.mosaic_path.replace(/\\/g, '/');
                const idx = url.indexOf('scans/');
                if (idx !== -1) {
                    url = '/' + url.slice(idx);
                } else {
                    url = '/scans/' + url;
                }
                
                const img = new Image();
                img.onload = () => {
                    stitchedImg = img;
                    requestRender();
                };
                img.src = url;
            }
            
            if (data.mosaic_edges_path) {
                let url = data.mosaic_edges_path.replace(/\\/g, '/');
                const idx = url.indexOf('scans/');
                if (idx !== -1) {
                    url = '/' + url.slice(idx);
                } else {
                    url = '/scans/' + url;
                }
                
                const img = new Image();
                img.onload = () => {
                    mosaicEdgesImg = img;
                    requestRender();
                };
                img.src = url;
            }
        });

        // Handle resize
        const resizeObserver = new ResizeObserver(() => {
            sizeCanvas();
            requestRender();
        });
        resizeObserver.observe(container);

        sizeCanvas();
        startAnimationLoop();
    }

    function sizeCanvas() {
        const rect = container.getBoundingClientRect();
        canvas.width = rect.width * devicePixelRatio;
        canvas.height = rect.height * devicePixelRatio;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    }

    function startAnimationLoop() {
        function loop() {
            pulsePhase = (Date.now() % 1500) / 1500;
            render();
            animFrame = requestAnimationFrame(loop);
        }
        loop();
    }

    function requestRender() {
        // Render happens in animation loop
    }

    function render() {
        if (!ctx) return;

        const w = canvas.width / devicePixelRatio;
        const h = canvas.height / devicePixelRatio;

        ctx.clearRect(0, 0, w, h);

        let offsetX, offsetY, tileW, tileH, gridW, gridH, gap;

        // ── PHYSICAL BED BACKGROUND MAPPING (Method 2) ──
        if (bedBgMeta && bedBgImg && bedBgImg.complete) {
            const imgAspect = bedBgMeta.physical_width / bedBgMeta.physical_height;
            const canvasAspect = w / h;
            
            let drawW = w, drawH = h, drawX = 0, drawY = 0;
            if (canvasAspect > imgAspect) {
                drawW = h * imgAspect; drawX = (w - drawW) / 2;
            } else {
                drawH = w / imgAspect; drawY = (h - drawH) / 2;
            }
            
            // Draw bed photo and neon edges
            ctx.drawImage(bedBgImg, drawX, drawY, drawW, drawH);
            if (bedEdgesImg && bedEdgesImg.complete) {
                ctx.drawImage(bedEdgesImg, drawX, drawY, drawW, drawH);
            }
            
            if (gridRows === 0 || gridCols === 0) return;

            // Map physical coordinates if ROI is known
            if (roi && roi.w && roi.h) {
                const scaleX = drawW / bedBgMeta.physical_width;
                const scaleY = drawH / bedBgMeta.physical_height;
                
                offsetX = drawX + (roi.x * scaleX);
                offsetY = drawY + (roi.y * scaleY);
                gridW = roi.w * scaleX;
                gridH = roi.h * scaleY;
                
                // Allow tiles to be non-square rectangles based on physical FOV mapping
                tileW = (gridW / gridCols) * 0.95;
                tileH = (gridH / gridRows) * 0.95;
                gap = (gridW / gridCols) * 0.05; // horizontal gap approximation
            } else {
                // Fallback if ROI is missing but grid exists
                offsetX = drawX; offsetY = drawY; gridW = drawW; gridH = drawH;
                tileW = (gridW / gridCols) * 0.95; tileH = (gridH / gridRows) * 0.95; gap = 0;
            }
        } 
        // ── STANDARD ABSTRACT CENTERING ──
        else {
            if (gridRows === 0 || gridCols === 0) return;
            const pad = 20;
            gap = 2;
            const tW = Math.max(4, (w - pad * 2 - gap * (gridCols - 1)) / gridCols);
            const tH = Math.max(4, (h - pad * 2 - gap * (gridRows - 1)) / gridRows);
            const size = Math.min(tW, tH, 60);
            tileW = size;
            tileH = size;

            gridW = gridCols * tileW + (gridCols - 1) * gap;
            gridH = gridRows * tileH + (gridRows - 1) * gap;
            offsetX = (w - gridW) / 2;
            offsetY = (h - gridH) / 2;
        }

        // Draw stitched mosaic image if loaded (Method 1)
        if (stitchedImg && stitchedImg.complete) {
            ctx.drawImage(stitchedImg, offsetX, offsetY, gridW, gridH);
            
            if (mosaicEdgesImg && mosaicEdgesImg.complete) {
                ctx.drawImage(mosaicEdgesImg, offsetX, offsetY, gridW, gridH);
            }
            
            // Draw grid borders lightly on top
            ctx.save();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.lineWidth = 1;
            for (let row = 0; row < gridRows; row++) {
                for (let col = 0; col < gridCols; col++) {
                    const x = offsetX + col * (gridW / gridCols);
                    const y = offsetY + row * (gridH / gridRows);
                    ctx.strokeRect(x, y, tileW, tileH);
                }
            }
            ctx.restore();
            return;
        }

        // Draw ROI bounding box (dashed)
        if (roi && !bedBgMeta) {
            ctx.save();
            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = 'rgba(188, 140, 255, 0.5)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(offsetX - 4, offsetY - 4, gridW + 8, gridH + 8);
            ctx.restore();
        }

        // Draw tiles
        for (let row = 0; row < gridRows; row++) {
            for (let col = 0; col < gridCols; col++) {
                const key = `${row}_${col}`;
                const tile = tiles[key];
                const status = tile ? tile.status : 'pending';
                const colors = COLORS[status] || COLORS.pending;

                const x = offsetX + col * (gridW / gridCols);
                const y = offsetY + row * (gridH / gridRows);

                // ── SETTLING ANIMATION (MANDATORY) ──
                if (status === 'settling') {
                    const pulse = Math.sin(pulsePhase * Math.PI * 2) * 0.5 + 0.5;
                    const alpha = 0.15 + pulse * 0.35;
                    const borderAlpha = 0.4 + pulse * 0.6;

                    ctx.fillStyle = `rgba(210, 153, 34, ${alpha})`;
                    ctx.fillRect(x, y, tileW, tileH);

                    ctx.strokeStyle = `rgba(210, 153, 34, ${borderAlpha})`;
                    ctx.lineWidth = 2 + pulse;
                    ctx.strokeRect(x - 1, y - 1, tileW + 2, tileH + 2);

                    // Pulse ring
                    const ringSize = pulse * 6;
                    ctx.strokeStyle = `rgba(210, 153, 34, ${0.3 * (1 - pulse)})`;
                    ctx.lineWidth = 1;
                    ctx.strokeRect(x - ringSize, y - ringSize, tileW + ringSize * 2, tileH + ringSize * 2);
                } else {
                    // Standard tile rendering
                    ctx.fillStyle = colors.fill;
                    ctx.fillRect(x, y, tileW, tileH);

                    ctx.strokeStyle = colors.stroke;
                    ctx.lineWidth = status === 'targeting' || status === 'capturing' ? 2 : 1;
                    ctx.strokeRect(x, y, tileW, tileH);
                }

                // Failure labels
                if (colors.label && tileW >= 16) {
                    ctx.fillStyle = colors.stroke;
                    ctx.font = `bold ${Math.min(10, tileW * 0.4)}px ${getComputedStyle(document.body).getPropertyValue('--font-mono')}`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(colors.label, x + tileW / 2, y + tileH / 2);
                }
            }
        }
    }

    function setBedBackground(meta, bedUrl, edgesUrl) {
        bedBgMeta = meta;
        if (bedUrl) {
            bedBgImg = new Image();
            bedBgImg.onload = requestRender;
            bedBgImg.src = bedUrl;
        }
        if (edgesUrl) {
            bedEdgesImg = new Image();
            bedEdgesImg.onload = requestRender;
            bedEdgesImg.src = edgesUrl;
        }
        
        if (emptyState) emptyState.classList.add('hidden');
        requestRender();
    }

    function reset() {
        tiles = {};
        gridRows = 0;
        gridCols = 0;
        roi = null;
        stitchedImg = null;
        mosaicEdgesImg = null;
        if (emptyState) emptyState.classList.remove('hidden');
        document.getElementById('tileCount').textContent = '0 / 0';
    }

    return { init, reset, setBedBackground };
})();
