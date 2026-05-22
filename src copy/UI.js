/**
 * ============================================================================
 *                       USER INTERFACE (VISUAL FEEDBACK)
 * ============================================================================
 * 
 * This module is responsible for changing the "Look and Feel" of the page
 * based on what the software is doing.
 * 
 * RESPONSIBILITIES:
 * 1. Status Badge (Top Right):
 *    - Green: Connected to Machine.
 *    - Red: Disconnected (Internet lost or ESP32 off).
 * 
 * 2. User Count:
 *    - Shows how many people are currently controlling the machine.
 *    - Helps avoid conflicts in a classroom setting.
 * 
 * 3. Start/Stop Button:
 *    - "Start Cutting" (Green) -> When idle.
 *    - "Stop Cutting" (Red)    -> When running a job.
 *    - Disabled (Grey)         -> When disconnected.
 * ============================================================================
 */

/**
 * @file UI.js
 * @description UI UPDATES
 * 
 * This module handles visual feedback for the user.
 * It strictly changes the "Look" of the page (colors, text, badges)
 * based on the application state.
 */

const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const statusDot = statusBadge.querySelector('.status-dot');
const btnStart = document.getElementById('btnStart');
const userCount = document.getElementById('userCount');

/**
 * Updates the Connection Badge (Top Right).
 * Green = Connected, Red = Disconnected.
 * 
 * @param {boolean} isConnected - True if WebSocket is open.
 */
export function updateStatus(isConnected) {
    if (isConnected) {
        statusText.textContent = "Connected";
        statusBadge.style.backgroundColor = "#a7f3d0"; // Green bg
        statusBadge.style.color = "#064e3b";           // Dark Green text
        statusDot.style.backgroundColor = "#10b981";   // Bright Green dot
        btnStart.disabled = false; // Enable Start button
    } else {
        statusText.textContent = "Disconnected";
        statusBadge.style.backgroundColor = "#fca5a5"; // Red bg
        statusBadge.style.color = "#7f1d1d";           // Dark Red text
        statusDot.style.backgroundColor = "#ef4444";   // Bright Red dot
        btnStart.disabled = true;  // Disable Start button (safety)
    }
}

/**
 * Updates the small text showing how many people are looking at the page.
 * Useful if multiple students try to connect to one machine.
 * 
 * @param {number} count - Number of active WebSocket connections.
 */
export function updateUserCount(count) {
    const text = count === 1 ? 'user' : 'users';
    userCount.textContent = `(${count} ${text})`;
}

/**
 * Toggles the Big Action Button between "Start Cutting" (Green) and "Stop" (Red).
 * 
 * @param {boolean} isSending - True if a job is running.
 */
export function setStartButtonState(isSending) {
    if (isSending) {
        btnStart.textContent = "Stop Cutting";
        btnStart.classList.remove('btn-start');
        btnStart.classList.add('btn-stop');
    } else {
        btnStart.textContent = "Start Cutting";
        btnStart.classList.remove('btn-stop');
        btnStart.classList.add('btn-start');
    }
}