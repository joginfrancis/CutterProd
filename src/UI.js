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
const btnPause = document.getElementById('btnPause');
const btnStop = document.getElementById('btnStop');
const userCount = document.getElementById('userCount');

/**
 * Updates the Connection Badge (Top Right) and Console Drawer Checklist.
 * Green = Connected, Red = Disconnected.
 * 
 * @param {boolean} isConnected - True if WebSocket is open.
 */
export function updateStatus(isConnected) {
    const isSimMode = document.getElementById('simModeCheckbox')?.checked;
    const connIndicator = document.querySelector('#activityConnection .status-circle-indicator');
    
    if (isConnected) {
        statusText.textContent = "Connected";
        statusBadge.style.backgroundColor = "rgba(16, 185, 129, 0.15)";
        statusBadge.style.borderColor = "rgba(16, 185, 129, 0.25)";
        statusBadge.style.color = "#a7f3d0";           // Light Green text
        statusDot.style.backgroundColor = "#10b981";   // Bright Green dot
        if (btnStart) btnStart.disabled = false; // Enable Start button
        
        if (connIndicator) {
            connIndicator.className = 'status-circle-indicator connected';
        }
    } else {
        statusText.textContent = "Disconnected";
        statusBadge.style.backgroundColor = "rgba(239, 68, 68, 0.15)";
        statusBadge.style.borderColor = "rgba(239, 68, 68, 0.25)";
        statusBadge.style.color = "#fca5a5";           // Light Red text
        statusDot.style.backgroundColor = "#ef4444";   // Bright Red dot
        if (btnStart) btnStart.disabled = !isSimMode;  // Disable Start button (safety) unless in simulation mode
        
        if (connIndicator) {
            connIndicator.className = 'status-circle-indicator disconnected';
        }
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
    if (userCount) {
        userCount.textContent = `(${count} ${text})`;
    }
}

/**
 * Toggles the Big Action Buttons in Run Mode between "Start Cutting", "Pause", and "Stop".
 * 
 * @param {boolean} isSending - True if a job is running.
 * @param {boolean} isPaused - True if a job is paused.
 */
export function setStartButtonState(isSending, isPaused = false) {
    if (isPaused) {
        if (btnStart) {
            btnStart.textContent = "Resume Job";
            btnStart.classList.remove('btn-stop');
            btnStart.classList.add('btn-start');
            btnStart.style.display = 'block';
            btnStart.disabled = false;
        }
        if (btnPause) {
            btnPause.style.display = 'none';
        }
        if (btnStop) {
            btnStop.style.display = 'block';
        }
    } else if (isSending) {
        if (btnStart) {
            btnStart.style.display = 'none';
        }
        if (btnPause) {
            btnPause.style.display = 'block';
            btnPause.disabled = false;
            btnPause.textContent = "Pause Job";
        }
        if (btnStop) {
            btnStop.style.display = 'block';
        }
    } else {
        if (btnStart) {
            btnStart.textContent = "Start Cutting";
            btnStart.classList.remove('btn-stop');
            btnStart.classList.add('btn-start');
            btnStart.style.display = 'block';
        }
        if (btnPause) {
            btnPause.style.display = 'none';
        }
        if (btnStop) {
            btnStop.style.display = 'none';
        }
    }
}