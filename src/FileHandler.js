/**
 * ============================================================================
 *                       FILE IMPORT & PROCESSING
 * ============================================================================
 * 
 * This module acts as the "Receptionist" for files. It decides what to do with
 * files dropped onto the page or selected by the user.
 * 
 * PIPELINE:
 * 1. Detection: Is it a .gcode file or an .svg file?
 * 
 * 2. G-CODE Path (Simple):
 *    - Just reads the text content.
 *    - Sends it directly to the machine.
 * 
 * 3. SVG Path (Complex):
 *    We must prepare the vector graphic for the physical constraints of the plotter.
 *    
 *    A. Unit Normalization:
 *       SVGs can be in pixels, inches, cm, mm, etc. We try to convert everything
 *       to millimeters (mm) to match the machine.
 *       
 *    B. Scaling (Auto-Fit):
 *       If the drawing is 500mm wide but the bed is only 230mm, we automatically
 *       shrink the drawing to fit safely within the margins.
 *       
 *    C. Centering:
 *       We calculate the offsets needed to place the drawing exactly in the
 *       middle of the bed.
 *       
 *    D. Coordinate Flip:
 *       Computer screens have (0,0) at the Top-Left.
 *       CNC machines usually have (0,0) at the Bottom-Left.
 *       We have to mathematically flip the Y-axis so the drawing isn't upside down.
 * 
 *    E. Conversion:
 *       Finally, we pass all these parameters to 'SvgConverter.js' to get the G-code.
 * ============================================================================
 */

/**
 * @file FileHandler.js
 * @description FILE IMPORT LOGIC
 * 
 * Handles loading files from the computer.
 * - If it's a G-Code file: Just load the text.
 * - If it's an SVG file: We have to do a lot of math to convert it to G-code.
 */

import SvgConverter from './SvgConverter.js?v=5';
import { log } from './Console.js';

/**
 * Process an uploaded file (SVG or GCode).
 * 
 * @param {File} file - The file object from Input or Drag/Drop.
 * @param {Function} onGCodeReady - Callback to save the new GCode.
 * @param {Function} onSwitchTab - Callback to change the view.
 */
export async function handleFile(file, onGCodeReady, onSwitchTab, urumiMeta = null) {
    if (!file) return;
    log(`Loading ${file.name}...`, 'info');
    
    try {
        const text = await file.text();

        // --- CASE 1: SVG FILE ---
        if (file.name.toLowerCase().endsWith('.svg')) {
            
            // 1. Parse the XML
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'image/svg+xml');
            const svg = doc.querySelector('svg');

            // 2. Show the raw SVG in the "SVG Preview" tab
            if (svg) {
                // Force it to fit the preview window
                svg.style.width = '100%';
                svg.style.height = '100%';
                
                const svgPreview = document.getElementById('svgPreview');
                svgPreview.innerHTML = ''; 
                svgPreview.appendChild(svg);
            }

            // 3. Determine Dimensions (Complex!)
            // SVGs can use mm, cm, in, px, or no units at all.
            // We try to find the "Real World" size of the drawing.
            const bedW = parseFloat(document.getElementById('bedWidthInput')?.value) || 960;
            const bedH = parseFloat(document.getElementById('bedHeightInput')?.value) || 770;
            let w_mm = 0, h_mm = 0;
            let viewbox = [0, 0, 0, 0];

            if(svg) {
                const wAttr = svg.getAttribute('width');
                const hAttr = svg.getAttribute('height');
                const vbAttr = svg.getAttribute('viewBox');

                if (vbAttr) {
                    viewbox = vbAttr.split(/[ ,]+/).map(parseFloat);
                }
                
                // Helper to convert strings like "10in" to mm
                const parseToMM = (str) => {
                    if (!str) return 0;
                    const val = parseFloat(str);
                    if (isNaN(val)) return 0;
                    if (str.endsWith('mm')) return val;
                    if (str.endsWith('cm')) return val * 10;
                    if (str.endsWith('in')) return val * 25.4;
                    if (str.endsWith('pt')) return val * (25.4 / 72);
                    if (str.endsWith('pc')) return val * (25.4 / 6);
                    if (str.endsWith('px')) return val * 0.264583;
                    return val; // Assume mm if no unit provided
                };

                w_mm = parseToMM(wAttr);
                h_mm = parseToMM(hAttr);

                // Fallback: If width/height are missing, use ViewBox width/height
                if (w_mm === 0 && viewbox.length === 4) w_mm = viewbox[2];
                if (h_mm === 0 && viewbox.length === 4) h_mm = viewbox[3];
            }

            // --- SCALING & MAPPING LOGIC ---
            let scale = 1.0;
            let finalOffsetX = 0;
            let finalOffsetY = 0;
            let finalW = 0;
            let finalH = 0;

            let vbW = viewbox.length === 4 ? viewbox[2] : w_mm;
            let vbH = viewbox.length === 4 ? viewbox[3] : h_mm;
            if (vbW === 0) vbW = w_mm;
            if (vbH === 0) vbH = h_mm;

            if (urumiMeta) {
                // Direct physical mapping from UrumiCam bed scanner
                scale = 1.0 / urumiMeta.dots_per_mm;

                // The machine's physical origin is bottom-right, so camera-space
                // X and Y must both be mirrored into machine-space.
                finalOffsetX = urumiMeta.physical_width;
                finalOffsetY = urumiMeta.physical_height;

                finalW = urumiMeta.physical_width;
                finalH = urumiMeta.physical_height;
                log(`Direct visual alignment loaded: ${finalW.toFixed(1)}x${finalH.toFixed(1)}mm gantry bed at origin`, 'success');
            } else {
                const isCanvas = svg.getAttribute('data-source') === 'canvas';

                // 1. Calculate initial scale (Unit Conversion)
                scale = (vbW > 0) ? (w_mm / vbW) : 1.0;

                const margin = 10; // 10mm safety margin
                let currentW = vbW * scale;
                let currentH = vbH * scale;

                // 2. Auto-Fit (Scale Down)
                if (!isCanvas && (currentW > (bedW - margin) || currentH > (bedH - margin))) {
                    const scaleW = (bedW - margin) / currentW;
                    const scaleH = (bedH - margin) / currentH;
                    const fitScale = Math.min(scaleW, scaleH);
                    scale *= fitScale;
                    log(`Scaled down to fit bed (${(fitScale * 100).toFixed(0)}%)`, 'info');
                }

                // 3. Centering
                finalW = vbW * scale;
                finalH = vbH * scale;

                let offsetX = 0;
                let offsetY = 0;

                if (!isCanvas) {
                    offsetX = (bedW - finalW) / 2;
                    offsetY = (bedH - finalH) / 2;
                }

                const vbMinX = viewbox.length === 4 ? viewbox[0] : 0;
                const vbMinY = viewbox.length === 4 ? viewbox[1] : 0;
                
                // Align to center or leave at 0,0 for Canvas
                if (isCanvas) {
                    // The draw canvas is authored in a bottom-left logical space,
                    // but the machine's real origin is bottom-right.
                    finalOffsetX = bedW;
                    finalOffsetY = bedH;
                } else {
                    // Normalize standard SVGs to 0,0 and then shift to centered offsetX
                    finalOffsetX = offsetX - (vbMinX * scale);
                    finalOffsetY = offsetY - (vbMinY * scale);
                }
            }

            // Read inversion checkboxes
            let invertXElement = document.getElementById('invertXCheckbox');
            let flipX = invertXElement ? invertXElement.checked : false;
            
            let invertYElement = document.getElementById('invertYCheckbox');
            let flipY = invertYElement ? invertYElement.checked : false;

            // Canvas SVGs and UrumiCam Captures:
            // Both need the machine's true bottom-right origin, so force both flips.
            // The inversion checkboxes apply only to externally-loaded SVG files.
            const isCanvasSrc = !urumiMeta && svg && svg.getAttribute('data-source') === 'canvas';
            if (isCanvasSrc || urumiMeta) {
                flipX = true;
                flipY = true;
            }


            try {
                // Get segment length from UI
                const segInput = document.getElementById('segmentLengthInput');
                let segLength = segInput ? parseFloat(segInput.value) : 1.0;
                if (isNaN(segLength) || segLength < 0.1) segLength = 0.1;

                // Calculate per-axis steps using the formula: (motorSteps * microsteps) / distPerRev
                const axisSteps = (mId, miId, dId, fallback) => {
                    const m  = parseFloat(document.getElementById(mId)?.value)  || 200;
                    const mi = parseFloat(document.getElementById(miId)?.value) || 1;
                    const d  = parseFloat(document.getElementById(dId)?.value)  || 1;
                    const v  = (m * mi) / d;
                    return (isNaN(v) || v <= 0) ? fallback : v;
                };

                const stepsPerMM_X = axisSteps('xMotorSteps','xMicrosteps','xMmPerRev',  160);
                const stepsPerMM_Y = axisSteps('yMotorSteps','yMicrosteps','yMmPerRev',  160);
                const stepsPerMM_Z = axisSteps('zMotorSteps','zMicrosteps','zMmPerRev',  800);
                const stepsPerDeg_A = axisSteps('aMotorSteps','aMicrosteps','aDegPerRev', 92.44);

                const cuttingSpeedInput = document.getElementById('cuttingSpeedInput');
                const cuttingSpeed = cuttingSpeedInput ? parseFloat(cuttingSpeedInput.value) : 30;

                const idX = parseInt(document.getElementById('xRs485Id')?.value) || 3;
                const idY = parseInt(document.getElementById('yRs485Id')?.value) || 2;
                const idZ = parseInt(document.getElementById('zRs485Id')?.value) || 1;
                const idA = parseInt(document.getElementById('aRs485Id')?.value) || 4;

                const maxStepsInput = document.getElementById('maxStepsInput');
                const maxSteps = maxStepsInput ? parseInt(maxStepsInput.value) : 30000;
                
                const maxSpeedInput = document.getElementById('maxSpeedInput');
                const maxSpeed = maxSpeedInput ? parseInt(maxSpeedInput.value) : 30000;

                // flipX/flipY are resolved above (with canvas-source override),
                // so do NOT re-read them here — they shadow the corrected values.

                // Run the conversion!
                const converter = new SvgConverter({
                    flipX: flipX,
                    flipY: flipY,
                    feedRate: cuttingSpeed, 
                    maxSteps: maxSteps,
                    maxSpeed: maxSpeed,
                    scale: scale,
                    offsetX: finalOffsetX,
                    offsetY: finalOffsetY,
                    segmentLength: segLength,
                    stepsPerMM_X: stepsPerMM_X,
                    stepsPerMM_Y: stepsPerMM_Y,
                    stepsPerMM_Z: stepsPerMM_Z,
                    stepsPerDeg_A: stepsPerDeg_A,
                    idX: idX,
                    idY: idY,
                    idZ: idZ,
                    idA: idA,
                    bedW: bedW,
                    bedH: bedH,
                    docW: finalW,
                    docH: finalH
                });
                const result = converter.convert(text);
                
                onGCodeReady(result, stepsPerMM_X);
                log(`Converted (Size: ${finalW.toFixed(1)}x${finalH.toFixed(1)}mm)`, 'success');
                onSwitchTab('gcode-preview');
            } catch (err) {
                log(`Conversion Error: ${err.message}`, 'error');
            }

        } else {
            // --- CASE 2: G-CODE FILE ---
            // Simple: just read the text and use it.
            // Wrap in the same {preamble, packets} envelope (no binary packets).
            onGCodeReady({ preamble: text.split('\n').filter(l => l.trim()), packets: [] });
            log('G-Code loaded.', 'success');
            onSwitchTab('gcode-preview');
        }
    } catch (err) {
        log(`File Read Error: ${err.message}`, 'error');
    }
}
