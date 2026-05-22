/**
 * ============================================================================
 *                       VIEW NAVIGATION (TABS)
 * ============================================================================
 * 
 * This module controls the switching between different "Screens" or "Views"
 * within the single-page application.
 * 
 * MECHANISM:
 * We don't actually load new HTML pages. Instead, we have all 3 panels loaded
 * simultaneously in the background. We simply toggle a CSS class ".hidden"
 * to show or hide them.
 * 
 * THE VIEWS:
 * 1. G-Code Preview:
 *    - The default view.
 *    - Shows the HTML5 Canvas where the G-code path is drawn visually.
 *    - Handles the "Empty State" (Drag & Drop Prompt) vs the "Viewer" (Canvas).
 * 
 * 2. SVG Preview:
 *    - Shows the raw SVG file exactly as the browser renders it.
 *    - Useful for debugging "Why does my SVG look weird?".
 * 
 * 3. Editor:
 *    - A simple text area showing the raw G-code text.
 *    - Allows the user to manually edit code before sending.
 * ============================================================================
 */

/**
 * @file Tabs.js
 * @description TAB NAVIGATION
 * 
 * This simple module handles switching between the 3 main views:
 * 1. G-Code Preview (Canvas)
 * 2. SVG Preview (Raw SVG image)
 * 3. Editor (Text Area)
 * 
 * It uses the "Hidden Class" technique:
 * All views exist on the page at once, but we use CSS (.hidden { display: none; })
 * to show only one at a time.
 */

import { renderGCode } from './Viewer.js';

/**
 * Initializes the Tab Logic.
 * 
 * @param {Function} getCurrentGCode - A function to get the latest G-code 
 *                                     from the main state (so we can re-render it).
 */
export function setupTabs(getCurrentGCode) {
    
    // We attach this function to the global 'window' object so 
    // HTML elements can call it like <div onclick="switchTab(...)">
    window.switchTab = function(tabName) {
        
        // 1. Update the Tab Buttons (Make the clicked one "active")
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        
        // Find the tab button that matches the name (fuzzy match)
        const activeTab = Array.from(document.querySelectorAll('.tab')).find(t => t.innerText.toLowerCase().includes(tabName.split('-')[0]));
        if(activeTab) activeTab.classList.add('active');

        // 2. Hide ALL Panels first
        document.querySelectorAll('.view-panel').forEach(v => v.classList.add('hidden'));
        
        // 3. Show the requested Panel
        if (tabName === 'gcode-preview') {
            document.getElementById('gcodePreview').classList.remove('hidden');
            
            // If we have G-code, draw it!
            const state = getCurrentGCode(); // Actually returns full state now
            if (state.gcode && state.gcode.length > 0) {
                document.getElementById('emptyState').classList.add('hidden');
                document.getElementById('canvasContainer').classList.remove('hidden');
                // Small delay to ensure the div is visible before drawing (needed for correct size calc)
                setTimeout(() => renderGCode(state.gcode, 'gcodeCanvas', 'canvasContainer', state.stepsPerMM), 10);
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
    };
}