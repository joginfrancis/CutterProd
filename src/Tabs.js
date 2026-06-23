/**
 * @file Tabs.js
 * @description TAB NAVIGATION
 *
 * Handles switching between the sub-tabs inside Prepare mode:
 * 1. Vector Draw Editor (CanvasEditor)
 * 2. SVG Preview
 * 3. Data Editor
 * 
 * Visibility is controlled via CSS classes ('hidden' and 'active').
 */

import { renderGCode } from './Viewer.js';

/**
 * Initializes tab logic.
 * @param {Function} getState - Returns the current application state object.
 * @param {object}   drawBridge - { activate(), deactivate() }
 */
export function setupTabs(getState, drawBridge = null) {

    window.switchTab = function(tabName) {
        // 1. Update sub-tab button active state
        document.querySelectorAll('.sub-tabs .tab').forEach(t => t.classList.remove('active'));
        
        const tabKeyword = tabName.split('-')[0]; // e.g. 'draw', 'svg', 'editor', 'gcode'
        const activeTab = Array.from(document.querySelectorAll('.sub-tabs .tab'))
            .find(t => t.innerText.toLowerCase().includes(tabKeyword));
        if (activeTab) activeTab.classList.add('active');

        // 2. Hide all view panels
        document.querySelectorAll('.view-panel').forEach(v => v.classList.add('hidden'));

        // 3. Deactivate draw editor when leaving the draw tab
        if (drawBridge && tabName !== 'draw') {
            drawBridge.deactivate();
        }

        // 4. Show the requested panel and handle its contents
        if (tabName === 'gcode-preview') {
            const previewEl = document.getElementById('gcodePreview');
            if (previewEl) previewEl.classList.remove('hidden');
            
            const state = getState();
            const hasPaths = (state.binaryPackets && state.binaryPackets.length > 0) || (state.gcode && state.gcode.length > 0);
            const emptyState = document.getElementById('emptyState');
            const canvasContainer = document.getElementById('canvasContainer');
            
            if (hasPaths) {
                if (emptyState) emptyState.classList.add('hidden');
                if (canvasContainer) canvasContainer.classList.remove('hidden');
                setTimeout(() => {
                    renderGCode(state.gcode || '', 'gcodeCanvas', 'canvasContainer', state.stepsPerMM, -1, state.binaryPackets);
                }, 10);
            } else {
                if (emptyState) emptyState.classList.remove('hidden');
                if (canvasContainer) canvasContainer.classList.add('hidden');
            }
        }

        if (tabName === 'svg-preview') {
            const svgPreviewEl = document.getElementById('svgPreview');
            if (svgPreviewEl) svgPreviewEl.classList.remove('hidden');
        }

        if (tabName === 'editor') {
            const editorEl = document.getElementById('gcodeEditor');
            if (editorEl) {
                editorEl.classList.remove('hidden');
                const state = getState();
                if (window.canvasEditor && window.canvasEditor.shapes.length > 0) {
                    editorEl.value = window.canvasEditor.exportAsSVG();
                    state.gcode = editorEl.value;
                }
            }
        }

        if (tabName === 'draw') {
            const drawPanelEl = document.getElementById('drawPanel');
            if (drawPanelEl) drawPanelEl.classList.remove('hidden');
            if (drawBridge) {
                setTimeout(() => drawBridge.activate(), 10);
            }
        }
    };
}