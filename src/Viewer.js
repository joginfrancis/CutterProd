/**
 * ============================================================================
 *                       G-CODE VISUALIZER (CANVAS)
 * ============================================================================
 * 
 * This module draws the "Map" of what the machine is going to do. It takes text
 * (G-code) and turns it into a picture on the screen.
 * 
 * THE BIG MATH PROBLEM (Coordinate Mapping):
 * 1. Machine World:
 *    - Origin (0,0) is at the BOTTOM-Left.
 *    - +Y goes UP.
 *    - Units are in Millimeters (mm).
 * 
 * 2. Computer Screen World (HTML Canvas):
 *    - Origin (0,0) is at the TOP-Left.
 *    - +Y goes DOWN.
 *    - Units are in Pixels (px).
 * 
 * HOW WE SOLVE IT:
 * We create two mapping functions 'mapX' and 'mapY' that act as translators.
 * [Machine X,Y] ---> [Scale] ---> [Flip Y] ---> [Offset] ---> [Screen Pixels]
 * 
 * VISUAL CUES:
 * - Solid Blue Lines: G1 (Cutting/Pen Down) - The machine is working.
 * - Dashed Grey Lines: G0 (Travel/Pen Up) - The machine is moving to a new spot.
 * - Dashed Box: Represents the physical size of the machine bed (230x310mm).
 * ============================================================================
 */

/**
 * @file Viewer.js
 * @description VISUALIZER
 * 
 * This module draws the G-code path on the HTML5 Canvas. 
 * 
 * CHALLENGE:
 * - Machine coordinates (Standard Cartesian): (0,0) is Bottom-Left. Y increases UP. 
 * - Computer Screen coordinates (Canvas): (0,0) is Top-Left. Y increases DOWN. 
 * 
 * We have to "map" (convert) every point from Machine Space to Screen Space.
 */

/**
 * Renders the trajectory path on the canvas.
 * @param {string} gcode - Preamble text (for legacy/gcode file compatibility).
 * @param {string} canvasId - HTML ID of the <canvas> element.
 * @param {string} containerId - HTML ID of the parent div (for sizing).
 * @param {number} stepsPerMM - Steps per mm (used for legacy gcode scaling).
 * @param {number} activePathIndex - Index of the last executed path segment (for animation).
 * @param {Uint8Array[]} [packets] - Binary MicroSegment packets from SvgConverter.
 */
export function renderGCode(gcode, canvasId = 'gcodeCanvas', containerId = 'canvasContainer', stepsPerMM = 1.0, activePathIndex = -1, packets = null) {
    const canvas = document.getElementById(canvasId);
    const container = document.getElementById(containerId);
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');

    // --- 1. Setup Dimensions ---
    const bedW = parseFloat(document.getElementById('bedWidthInput')?.value) || 960; // Machine Width (mm)
    const bedH = parseFloat(document.getElementById('bedHeightInput')?.value) || 770; // Machine Height (mm)
    const gantryW = parseFloat(document.getElementById('gantryWidthInput')?.value) || 210; // Gantry Width (mm)
    const gantryH = parseFloat(document.getElementById('gantryHeightInput')?.value) || 180; // Gantry Height (mm)

    // Make the canvas match the size of its container div.
    // When the panel is hidden (display:none), getBoundingClientRect returns 0×0.
    // In that case, keep the canvas's current size (or set a sensible default)
    // so live-cutting renders are preserved and visible when the tab is opened.
    const rect = container.getBoundingClientRect();
    if (rect.width >= 10 && rect.height >= 10) {
        canvas.width  = rect.width;
        canvas.height = rect.height;
    } else if (canvas.width < 10 || canvas.height < 10) {
        // First render ever while hidden — use a default
        canvas.width  = 960;
        canvas.height = 640;
    }
    // else: canvas retains its previous size from the last visible render

    // --- 2. Parse G-Code ---
    // We need to turn text lines ("G1 X10 Y20") into number objects ({x:10, y:20}).
    const lines = gcode.split('\n');
    const paths = [];
    let cur = { x: 0, y: 0 }; // Current pen position (starts at 0,0)
    let isPenDown = false; // Track pen state based on relative Z changes
    
    let currentShapeId = null;
    let currentMethod = 'thru_cut';

    lines.forEach(line => {
        const rawLine = line.trim();
        if (rawLine.startsWith('; SHAPE_START')) {
            const idMatch = rawLine.match(/id=([\w-]+)/);
            const methodMatch = rawLine.match(/method=([\w_]+)/);
            if (idMatch) currentShapeId = idMatch[1];
            if (methodMatch) currentMethod = methodMatch[1];
        } else if (rawLine.startsWith('; SHAPE_END')) {
            currentShapeId = null;
            currentMethod = 'thru_cut';
        }

        // Remove comments (text after ';') and whitespace
        line = line.split(';')[0].trim().toUpperCase();
        if (!line) return;

        // --- NEW: Trajectory Format ---
        // Format: move <count> <ids...> <steps...> <sps...> or mseg <dx> <dy> <dz> <da> <interval> <flags>
        const isMoveCommand = line.toLowerCase().startsWith('move') || line.toLowerCase().startsWith('mseg');
        if (isMoveCommand || (!line.startsWith('G') && !line.startsWith('M') && (line.includes(',') || line.includes(' ')))) {
            if (line.startsWith('X Y Z') || line.startsWith('XYZ X Y Z') || line.startsWith('ENABLE')) return; // Skip Header/Commands

            const parts = line.split(/[\s,]+/);
            
            if (parts.length > 0 && parts[0].toUpperCase() === 'MSEG') {
                const dx = parseInt(parts[1]) || 0;
                const dy = parseInt(parts[2]) || 0;
                const dz = parseInt(parts[3]) || 0;
                const da = parseInt(parts[4]) || 0;
                const interval = parseInt(parts[5]) || 0;
                const flags = parseInt(parts[6]) || 0;

                const axisSteps = (inputId, fallback) => {
                    const v = parseFloat(document.getElementById(inputId)?.value);
                    return (isNaN(v) || v <= 0) ? fallback : v;
                };

                const stepsPerMM_X = axisSteps('xStepsPerMM', 160);
                const stepsPerMM_Y = axisSteps('yStepsPerMM', 160);

                const mmX = dx / stepsPerMM_X;
                const mmY = dy / stepsPerMM_Y;

                if (dz > 0) isPenDown = true;
                else if (dz < 0) isPenDown = false;

                const isMove = !isPenDown;
                const next = { x: cur.x + mmX, y: cur.y + mmY };

                paths.push({
                    type: isMove ? 'move' : 'cut',
                    from: { ...cur },
                    to: { ...next },
                    shapeId: currentShapeId,
                    method: currentMethod
                });
                cur = next;
                return;
            }

            if (parts.length > 0 && parts[0].toUpperCase() === 'MOVE') {
                const count = parseInt(parts[1]);
                if (isNaN(count) || parts.length < 2 + count * 2) return;
                
                // Get configured IDs to map back to axes
                const idX = parseInt(document.getElementById('xRs485Id')?.value) || 3;
                const idY = parseInt(document.getElementById('yRs485Id')?.value) || 2;
                const idZ = parseInt(document.getElementById('zRs485Id')?.value) || 1;
                
                // Get Steps/MM to convert back to physical millimeters for the canvas
                const axisSteps = (inputId, fallback) => {
                    const v = parseFloat(document.getElementById(inputId)?.value);
                    return (isNaN(v) || v <= 0) ? fallback : v;
                };

                const stepsPerMM_X = axisSteps('xStepsPerMM', 160);
                const stepsPerMM_Y = axisSteps('yStepsPerMM', 160);

                let dx = 0, dy = 0, zVal = 0;
                
                for (let i = 0; i < count; i++) {
                    const id = parseInt(parts[2 + i]);
                    const steps = parseInt(parts[2 + count + i]);
                    
                    if (id === idX) dx = steps / stepsPerMM_X;
                    else if (id === idY) dy = steps / stepsPerMM_Y;
                    else if (id === idZ) zVal = steps;
                }
                
                if (zVal > 0) isPenDown = true;  // Positive Z means moving Down
                else if (zVal < 0) isPenDown = false; // Negative Z means moving Up
                
                const isMove = !isPenDown;
                const next = { x: cur.x + dx, y: cur.y + dy };
                
                paths.push({
                    type: isMove ? 'move' : 'cut',
                    from: { ...cur },
                    to: { ...next },
                    shapeId: currentShapeId,
                    method: currentMethod
                });
                cur = next;
                return;
            }

            // Legacy fallback
            if (parts.length > 0 && parts[0].toUpperCase() === 'XYZ') {
                parts.shift(); // Remove the "xyz" prefix
            }

            if (parts.length >= 7 && !isNaN(parseFloat(parts[0]))) {
                // xyz values are RELATIVE deltas in steps
                const dx = parseFloat(parts[0]) / stepsPerMM;
                const dy = parseFloat(parts[1]) / stepsPerMM;
                const zVal = parseFloat(parts[2]); // Relative Z change
                
                if (zVal > 0) isPenDown = true;  // Positive Z means moving Down
                else if (zVal < 0) isPenDown = false; // Negative Z means moving Up
                
                const isMove = !isPenDown;
                const next = { x: cur.x + dx, y: cur.y + dy };
                
                paths.push({
                    type: isMove ? 'move' : 'cut',
                    from: { ...cur },
                    to: { ...next }
                });
                cur = next;
            }
            return;
        }

        // --- LEGACY: G-Code Format ---
        const isMove = line.startsWith('G0') || line.startsWith('G1');
        if (isMove) {
            // Use Regex to find numbers after X and Y
            const xMatch = line.match(/X([-+]?\d*\.?\d+)/);
            const yMatch = line.match(/Y([-+]?\d*\.?\d+)/);
            
            const next = { ...cur };
            if (xMatch) next.x = parseFloat(xMatch[1]) / stepsPerMM;
            if (yMatch) next.y = parseFloat(yMatch[1]) / stepsPerMM;

            paths.push({
                type: line.startsWith('G0') ? 'move' : 'cut',
                from: { ...cur },
                to: { ...next },
                shapeId: currentShapeId,
                method: currentMethod
            });
            cur = next; // Update current position
        }
    });

    // --- 3. Decode binary packets (primary path source for SVG jobs) ---
    if (packets && packets.length > 0) {
        const axisSteps = (inputId, fallback) => {
            const v = parseFloat(document.getElementById(inputId)?.value);
            return (isNaN(v) || v <= 0) ? fallback : v;
        };

        const spmX = axisSteps('xStepsPerMM', 160);
        const spmY = axisSteps('yStepsPerMM', 160);

        let pkCur = { x: 0, y: 0 };
        let pkPenDown = false;

        for (const pkt of packets) {
            if (pkt.length < 22) continue;
            const view = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
            const magic = view.getUint8(0);
            if (magic !== 0xAB) continue;

            const dx = view.getInt32(1,  true);
            const dy = view.getInt32(5,  true);
            const dz = view.getInt32(9,  true);
            // da ignored for 2D display

            if (dz > 0) pkPenDown = true;
            else if (dz < 0) pkPenDown = false;

            const mmX = dx / spmX;
            const mmY = dy / spmY;
            const next = { x: pkCur.x + mmX, y: pkCur.y + mmY };

            paths.push({
                type: pkPenDown ? 'cut' : 'move',
                from: { ...pkCur },
                to:   { ...next },
                shapeId: null,
                method: 'thru_cut'
            });
            pkCur = next;
        }
        // Advance cur to final packet position for gantry rendering
        cur = pkCur;
    }

    // --- 4. Calculate viewport bounds (always show full bed for spatial context) ---
    // Fixed to the full bed so the user can always see where the path sits on the material.
    const minX = 0, maxX = bedW;
    const minY = 0, maxY = bedH;

    const padding = 40; // px
    const availableW = canvas.width - padding * 2;
    const availableH = canvas.height - padding * 2;
    const dataW = bedW;
    const dataH = bedH;
    const scale = Math.min(availableW / dataW, availableH / dataH);

    // Center the bounding box in the canvas
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const canvasCenterX = canvas.width / 2;
    const canvasCenterY = canvas.height / 2;

    // --- 4. Coordinate Mapper Functions ---
    // Machine space uses the real hardware frame:
    // origin at bottom-right, +X left, +Y up.
    const mapX = (x) => canvasCenterX + (centerX - x) * scale;
    const mapY = (y) => canvasCenterY + (centerY - y) * scale;

    // --- 5. Draw! ---
    ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear screen

    // Draw Bed Border
    ctx.setLineDash([10, 5]); // Dashed line
    ctx.strokeStyle = '#cbd5e1'; // Light grey
    ctx.lineWidth = 1;
    
    // Left edge of the bed in canvas coordinates after X inversion
    const bedX_canvas = mapX(bedW); 
    const bedY_canvas = mapY(bedH); 
    
    ctx.strokeRect(bedX_canvas, bedY_canvas, bedW * scale, bedH * scale);
    
    // Draw Labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px ui-monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`0,0 (BR)`, mapX(0), mapY(0) + 15); // Label Origin
    ctx.textAlign = 'left';
    ctx.fillText(`${bedW}x${bedH}mm`, mapX(bedW), mapY(bedH) - 5); // Label Size

    // Draw The Path
    ctx.lineCap = 'round';

    paths.forEach((p, idx) => {
        const startX = mapX(p.from.x);
        const startY = mapY(p.from.y);
        const endX = mapX(p.to.x);
        const endY = mapY(p.to.y);

        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        
        const isExecuted = activePathIndex >= 0 && idx <= activePathIndex;
        
        if (p.type === 'move') {
            // G0: Rapid Move (Pen Up) -> Grey/Light Blue Dashed Line
            ctx.lineWidth = 2;
            ctx.strokeStyle = isExecuted ? 'rgba(59, 130, 246, 0.45)' : '#d1d5db'; 
            ctx.setLineDash([5, 5]);
            ctx.stroke();
        } else {
            // G1: Cut Move (Pen Down) -> color based on method
            let strokeColor = '#3b82f6'; // default blue
            let dotColor = '#ff6600'; // default orange
            
            if (isExecuted) {
                strokeColor = '#10b981'; // green when executed
                dotColor = '#10b981';
            } else {
                if (p.method === 'crease') {
                    strokeColor = '#f59e0b'; // amber/orange for crease
                    dotColor = '#d97706';
                } else if (p.method === 'off_base') {
                    strokeColor = '#8b5cf6'; // purple for off base
                    dotColor = '#7c3aed';
                } else {
                    strokeColor = '#3b82f6'; // blue for thru cut
                    dotColor = '#2563eb';
                }
            }

            ctx.strokeStyle = strokeColor; 
            ctx.lineWidth = isExecuted ? 3 : 2;
            ctx.setLineDash([]);
            ctx.stroke();

            // VISUALIZE SAMPLING POINTS
            ctx.fillStyle = dotColor; 
            ctx.beginPath();
            ctx.arc(endX, endY, isExecuted ? 2.0 : 3.0, 0, 2 * Math.PI);
            ctx.fill();
        }
    });

    // --- Interactive Selection (Click to select shape) ---
    // Remove old listener if exists
    if (canvas._clickHandler) {
        canvas.removeEventListener('click', canvas._clickHandler);
    }
    
    canvas._clickHandler = (e) => {
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        // Point-to-segment distance helper
        const distToSegmentSq = (px, py, x1, y1, x2, y2) => {
            const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
            if (l2 === 0) return (px - x1) * (px - x1) + (py - y1) * (py - y1);
            let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
            t = Math.max(0, Math.min(1, t));
            const projX = x1 + t * (x2 - x1);
            const projY = y1 + t * (y2 - y1);
            return (px - projX) * (px - projX) + (py - projY) * (py - projY);
        };

        const hitRadiusSq = 100; // 10px radius
        let clickedPath = null;
        let minDistSq = Infinity;

        for (const p of paths) {
            if (p.type === 'cut' && p.shapeId) {
                const startX = mapX(p.from.x);
                const startY = mapY(p.from.y);
                const endX = mapX(p.to.x);
                const endY = mapY(p.to.y);
                
                const dSq = distToSegmentSq(mouseX, mouseY, startX, startY, endX, endY);
                if (dSq < hitRadiusSq && dSq < minDistSq) {
                    minDistSq = dSq;
                    clickedPath = p;
                }
            }
        }

        if (clickedPath) {
            const event = new CustomEvent('shapeClicked', { 
                detail: { shapeId: clickedPath.shapeId, method: clickedPath.method } 
            });
            canvas.dispatchEvent(event);
        }
    };
    
    canvas.addEventListener('click', canvas._clickHandler);

    // Draw Gantry Footprint
    if (paths.length > 0) {
        // Gantry is centered on the current tool position (cur) or the active path position
        let gantryCenter = cur;
        // Top-right in machine space becomes top-left in canvas space after X inversion.
        const gantryRight_machine = gantryCenter.x + gantryW / 2;
        const gantryTop_machine = gantryCenter.y + gantryH / 2;

        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)'; // Premium translucent red/coral
        ctx.lineWidth = 1.5;

        const gantryX_canvas = mapX(gantryRight_machine);
        const gantryY_canvas = mapY(gantryTop_machine);

        ctx.strokeRect(gantryX_canvas, gantryY_canvas, gantryW * scale, gantryH * scale);

        // Draw gantry fill (very light glassmorphic red)
        ctx.fillStyle = 'rgba(239, 68, 68, 0.04)';
        ctx.fillRect(gantryX_canvas, gantryY_canvas, gantryW * scale, gantryH * scale);

        // Draw Knife / Tool center dot
        ctx.fillStyle = '#ef4444'; // Bright Red
        ctx.beginPath();
        ctx.arc(mapX(gantryCenter.x), mapY(gantryCenter.y), 4, 0, 2 * Math.PI);
        ctx.fill();

        // Draw gantry labels
        ctx.fillStyle = '#ef4444';
        ctx.font = '9px ui-monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`Gantry (${gantryW}x${gantryH}mm)`, mapX(gantryCenter.x), mapY(gantryTop_machine) - 5);
        ctx.fillText("Knife (Center)", mapX(gantryCenter.x), mapY(gantryCenter.y) - 8);

        ctx.restore();
    }

    // Empty State
    if (paths.length === 0) {
        ctx.fillStyle = '#9ca3af';
        ctx.textAlign = 'center';
        ctx.setLineDash([]);
        ctx.fillText("No paths found", canvas.width/2, canvas.height/2);
    }
}
