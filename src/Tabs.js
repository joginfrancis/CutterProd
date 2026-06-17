/**
 * @file Tabs.js
 * @description TAB NAVIGATION
 *
 * Handles switching between the main views:
 * 1. Trajectory Preview (G-code Canvas)
 * 2. SVG Preview
 * 3. Data Editor
 * 4. Draw (CanvasEditor)
 *
 * Uses the hidden-class technique — all panels exist simultaneously,
 * CSS controls visibility.
 */

import { renderGCode } from './Viewer.js';

/**
 * Initializes tab logic.
 * @param {Function} getState - Returns the current application state object.
 * @param {object}   drawBridge - { activate(), deactivate() }
 */
export function setupTabs(getState, drawBridge = null) {

    window.switchTab = function(tabName) {

        // 1. Update tab button active state
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        const activeTab = Array.from(document.querySelectorAll('.tab'))
            .find(t => t.innerText.toLowerCase().includes(tabName.split('-')[0]));
        if (activeTab) activeTab.classList.add('active');

        // 2. Hide all panels
        document.querySelectorAll('.view-panel').forEach(v => v.classList.add('hidden'));

        // 3. Always hide draw palette unless we are on draw tab
        const palette = document.getElementById('drawPalette');
        if (palette) palette.classList.add('hidden');

        // 4. Deactivate draw editor when leaving the tab
        if (drawBridge && tabName !== 'draw') {
            drawBridge.deactivate();
        }

        // 5. Show the requested panel
        if (tabName === 'gcode-preview') {
            document.getElementById('gcodePreview').classList.remove('hidden');
            const state = getState();
            const hasPaths = (state.binaryPackets && state.binaryPackets.length > 0) || (state.gcode && state.gcode.length > 0);
            if (hasPaths) {
                document.getElementById('emptyState').classList.add('hidden');
                document.getElementById('canvasContainer').classList.remove('hidden');
                setTimeout(() => renderGCode(state.gcode || '', 'gcodeCanvas', 'canvasContainer', state.stepsPerMM, -1, state.binaryPackets), 10);
            } else {
                document.getElementById('emptyState').classList.remove('hidden');
                document.getElementById('canvasContainer').classList.add('hidden');
            }
        }

        if (tabName === 'svg-preview') {
            document.getElementById('svgPreview').classList.remove('hidden');
        }

        if (tabName === 'editor') {
            document.getElementById('gcodeEditor').classList.remove('hidden');
        }

        if (tabName === 'draw') {
            document.getElementById('drawPanel').classList.remove('hidden');
            if (palette) palette.classList.remove('hidden');
            if (drawBridge) {
                setTimeout(() => drawBridge.activate(), 10);
            }
        }
    };
}