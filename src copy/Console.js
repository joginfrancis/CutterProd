/**
 * ============================================================================
 *                       UI LOGGING SYSTEM (CONSOLE)
 * ============================================================================
 * 
 * This module provides a centralized way to display messages to the user within
 * the application's interface (the black scrolling box), similar to a terminal.
 * 
 * FEATURES:
 * 1. Visual Feedback: It's the primary way the user knows what's happening.
 *    - "Connecting..."
 *    - "Job Finished"
 *    - "Error: File too large"
 * 2. Color Coding: Messages are styled based on their importance:
 *    - White: General Info
 *    - Green: Success / Connection established
 *    - Red: Errors / Disconnections
 *    - Dim Grey: Technical data (outgoing commands)
 * 3. Auto-Scroll: Automatically jumps to the bottom so the latest message is
 *    always visible.
 * 
 * USAGE:
 * Import 'log' and call it anywhere: log("Hello World", "success");
 * ============================================================================
 */

/**
 * @file Console.js
 * @description ON-SCREEN LOGGER
 * 
 * Takes messages and displays them in the scrolling black box on the UI.
 * This is crucial for debugging and letting the user know what the machine is doing.
 */

const consoleOutput = document.getElementById('consoleOutput');

/**
 * Appends a message to the on-screen console log.
 * 
 * @param {string} msg - The message text.
 * @param {string} [type='info'] - The log type, which determines the color (CSS class).
 *                                 Options: 'info' (white), 'success' (green), 'error' (red), 'tx' (dim grey).
 */
export function log(msg, type = 'info') {
    const line = document.createElement('div');
    line.className = `console-line log-${type}`;
    
    // Add timestamp [10:30:05]
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    
    consoleOutput.appendChild(line);
    
    // Auto-scroll to the bottom so the newest message is visible
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

/**
 * Clears the console output.
 */
export function clearConsole() {
    consoleOutput.innerHTML = '';
    log('Console cleared.', 'info');
}