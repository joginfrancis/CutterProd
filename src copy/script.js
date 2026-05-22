/**
 * ============================================================================
 *                       MAIN CONTROLLER (THE BRAIN)
 * ============================================================================
 * 
 * This file is the central nervous system of the web application. It connects
 * the muscles (Connection), the eyes (Viewer), and the skin (UI) together.
 * 
 * CORE RESPONSIBILITIES:
 * 1. Application State:
 *    Keeps track of "What is happening right now?"
 *    - Is a job running?
 *    - Is the machine connected?
 *    - What code is loaded?
 * 
 * 2. The "Send-Wait-Send" Loop (Job Execution):
 *    Streaming G-code to a microcontroller isn't like downloading a file. 
 *    We can't send it all at once because the Arduino has very little memory.
 *    
 *    The Protocol:
 *    [Browser] sends Line 1 ---> [ESP32]
 *    [Browser] waits...
 *    [ESP32] executes Line 1 ---> sends "Ack" (Okay, done)
 *    [Browser] receives "Ack" ---> sends Line 2
 * 
 * 3. Event Wiring:
 *    - Listens for button clicks (Start/Stop).
 *    - Listens for drag-and-drop file uploads.
 *    - Listens for manual command typing.
 * ============================================================================
 */

import { log, clearConsole } from './Console.js';
import { updateStatus, setStartButtonState } from './UI.js';
import { MachineConnection } from './Connection.js';
import { setupTabs } from './Tabs.js';
import { renderGCode } from './Viewer.js';
import { handleFile } from './FileHandler.js';

/**
 * @file script.js
 * @description MAIN CONTROLLER
 * 
 * This is the "brain" of the application. It brings together all the separate
 * modules (UI, Connection, Files) to make the application work.
 * 
 * CORE LOGIC:
 * 1. It maintains the "State" of the application (is it sending? is it connected?).
 * 2. It handles the "Job Loop": 
 *    - User clicks Start -> Split G-code into lines -> Add to Queue.
 *    - Send Line 1 -> Wait for "Ack" from Machine -> Send Line 2...
 */

// --- Global State ---
// We keep all important variables in one place so it's easy to track what's happening.
const state = {
    gcodeQueue: [],      // Array holding the lines of G-code waiting to be sent
    isSending: false,    // Flag: to check, Are we currently running a job?
    gcode: '',           // The full text of the loaded G-code file
    currentFile: null,   // Holds the raw File object to allow re-conversion
    stepsPerMM: 1.0,     // Conversion factor for Viewer canvas
    lastSentCmd: null,   // Tracks the last sent trajectory line
    currentLine: null,   // Tracks the exact string currently being sent
    wasInterrupted: false, // Flags if the job was stopped midway
    isWaitingForReady: false, // Flag to wait for Pico's "ready" when buffer is full
    resendTimeout: null  // Tracks the timeout for resending commands to prevent spam
};

// --- DOM Elements ---
// References to HTML elements we need to interact with
const editor = document.getElementById('gcodeEditor');
const cmdInput = document.getElementById('cmdInput');
const btnStart = document.getElementById('btnStart');
const dropZone = document.getElementById('dropZone');

// --- Modal Elements ---
const configModal = document.getElementById('configModal');
const btnSettings = document.getElementById('btnSettings');
const btnCloseModal = document.getElementById('btnCloseModal');
const segmentLengthInput = document.getElementById('segmentLengthInput');
const segmentLengthSlider = document.getElementById('segmentLengthSlider');
const cuttingSpeedInput = document.getElementById('cuttingSpeedInput');
const cuttingSpeedSlider = document.getElementById('cuttingSpeedSlider');

// --- Connection Setup ---
// Initialize the WebSocket connection. We provide "callbacks" here.
// Callbacks are functions that run automatically when specific events happen.
const connection = new MachineConnection({
    // When the machine says "I received the command" (Ack), we send the next one.
    onAck: sendNextLine,
    
    // When the machine says "nope" (Buffer Full), pause sending and wait for "ready"
    onNope: () => {
        if (state.isSending) {
            state.isWaitingForReady = true;
        }
    },
    
    // When the machine is ready after a buffer full, resume sending
    onReady: () => {
        if (state.isSending && state.isWaitingForReady && state.currentLine) {
            if (state.resendTimeout) return;
            // Delay sending by 250ms to allow the Pico buffer to actually process and clear slots,
            // preventing a spammy infinite 'nope' / 'ready' loop.
            state.resendTimeout = setTimeout(() => {
                state.resendTimeout = null;
                if (state.isSending && state.isWaitingForReady) {
                    state.isWaitingForReady = false;
                    connection.send(state.currentLine);
                }
            }, 250);
        }
    },
    
    // If the connection drops mid-job, we must stop everything for safety.
    onDisconnect: stopJob
});

// --- Job Control Logic ---

/**
 * START JOB
 * Called when the user clicks "Start Cutting".
 * It prepares the G-code and starts the sending loop.
 */
function startJob() {
    const code = editor.value; // Get code directly from the text area
    if (!code) {
        log('No G-Code to send.', 'error');
        return;
    }

    // 1. Prepare the Queue
    // We split the text by "newline" (\n) to get individual commands.
    // We also "trim" whitespace and remove empty lines.
    state.gcodeQueue = code.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    if (state.gcodeQueue.length === 0) return;

    // --- SAFE RETRACT INJECTION ---
    // If the machine was stopped mid-job, it might still have the pen down.
    // We inject a pure vertical lift at its last known position before starting.
    if (state.wasInterrupted) {
        // Calculate Z stepsPerMM from per-axis inputs
        const zMotorSteps = parseFloat(document.getElementById('zMotorSteps')?.value) || 200;
        const zMicrosteps = parseFloat(document.getElementById('zMicrosteps')?.value) || 32;
        const zMmPerRev   = parseFloat(document.getElementById('zMmPerRev')?.value)   || 8;
        const zStepsPerMM = (zMotorSteps * zMicrosteps) / zMmPerRev || 80;

        // Assume zUp is 5mm, scaled to steps
        const zUpStep = Math.round(5 * zStepsPerMM);
        
        // Z-axis RS485 ID
        const idZ = parseInt(document.getElementById('zRs485Id')?.value) || 1;
        
        // Default Z lift speed
        const cuttingSpeedInput = document.getElementById('cuttingSpeedInput');
        const feedRate = cuttingSpeedInput ? parseFloat(cuttingSpeedInput.value) : 30;
        const stepVz = Math.abs(Math.round(feedRate * zStepsPerMM));
        
        // Inject a pure vertical lift
        // Negative Z means "Up" in the relative coordinate system
        const retractCmd = `move 1 ${idZ} -${zUpStep} ${stepVz}`;
        
        state.gcodeQueue.unshift(retractCmd);
        log(`Injected Safe Retract (Z-Up)`, 'info');
    }
    
    state.wasInterrupted = false;

    log(`Starting Job: ${state.gcodeQueue.length} lines.`, 'success');
    
    // 2. Update State
    state.isSending = true;
    setStartButtonState(true); // Visual change (Turn button Red/Stop)

    // 3. Kickoff
    sendNextLine();
}

/**
 * STOP JOB
 * Called by user or on error. Clears the queue immediately.
 */
function stopJob() {
    if (!state.isSending) return; // Prevent duplicate logs if already stopped
    
    state.isSending = false;
    state.gcodeQueue = []; // Delete all remaining commands
    state.wasInterrupted = true; // Mark that it was stopped mid-way
    if (state.resendTimeout) {
        clearTimeout(state.resendTimeout);
        state.resendTimeout = null;
    }
    
    log('Job Stopped. Position saved for safe retract on restart.', 'error');
    setStartButtonState(false); // Turn button back to Green/Start
}

/**
 * SEND NEXT LINE
 * The "Heartbeat" of the job.
 * 
 * Logic:
 * 1. Check if we are still supposed to be sending.
 * 2. If there are lines left in the queue:
 *    - Take the first one out (shift).
 *    - Send it to the machine.
 *    - Wait. (The 'onAck' callback will trigger this function again).
 * 3. If no lines left:
 *    - We are done!
 */
function sendNextLine() {
    if (!state.isSending) return;

    if (state.gcodeQueue.length > 0) {
        state.currentLine = state.gcodeQueue.shift(); // Remove first item from array
        
        // Track the last physical position sent
        if (state.currentLine.toLowerCase().startsWith('move')) {
            state.lastSentCmd = state.currentLine;
        }

        connection.send(state.currentLine);
        log(`> ${state.currentLine}`, 'tx'); 
    } else {
        finishJob();
    }
}

/**
 * FINISH JOB
 * Clean up after the last command is sent.
 */
function finishJob() {
    state.isSending = false;
    log('Job Complete.', 'success');
    setStartButtonState(false);
}

// --- Event Listeners ---

// 1. Start/Stop Button Logic
btnStart.addEventListener('click', () => {
    if (state.isSending) {
        stopJob();
    } else {
        startJob();
    }
});

// 2. Manual Command Input (The text box at the bottom)
const cmdHistory = [];
let cmdHistoryIndex = -1;

function handleManualSend() {
    const cmd = cmdInput.value.trim();
    if (!cmd) return;

    cmdHistory.push(cmd);
    cmdHistoryIndex = cmdHistory.length;

    // Special command to clear the screen
    if (cmd.toLowerCase() === 'clear' || cmd.toLowerCase() === '/clear') {
        clearConsole();
        cmdInput.value = '';
        return;
    }

    connection.send(cmd, true); // true = Log this as a manual command
    cmdInput.value = '';
}

// Wire up the manual input buttons/keys
document.getElementById('btnClear').addEventListener('click', clearConsole);
document.getElementById('btnRun').addEventListener('click', handleManualSend);

// Quick Actions
const btnToggleMotors = document.getElementById('btnToggleMotors');
if (btnToggleMotors) {
    btnToggleMotors.addEventListener('click', () => {
        const isEnabled = btnToggleMotors.dataset.enabled === 'true';
        if (isEnabled) {
            connection.send('enable all 0', true);
            btnToggleMotors.dataset.enabled = 'false';
            btnToggleMotors.textContent = 'Enable Motors';
        } else {
            connection.send('enable all 1', true);
            btnToggleMotors.dataset.enabled = 'true';
            btnToggleMotors.textContent = 'Disable Motors';
        }
    });
}

const btnPingAll = document.getElementById('btnPingAll');
if (btnPingAll) {
    btnPingAll.addEventListener('click', () => {
        connection.send('ping all', true);
    });
}

const btnPingNode = document.getElementById('btnPingNode');
const pingNodeId = document.getElementById('pingNodeId');
if (btnPingNode && pingNodeId) {
    btnPingNode.addEventListener('click', () => {
        const id = pingNodeId.value.trim();
        if (id) {
            connection.send(`ping ${id}`, true);
        } else {
            log('Please enter a Node ID to ping.', 'error');
        }
    });
}

cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        handleManualSend();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault(); // Prevent cursor from moving to start
        if (cmdHistory.length > 0 && cmdHistoryIndex > 0) {
            cmdHistoryIndex--;
            cmdInput.value = cmdHistory[cmdHistoryIndex];
        }
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (cmdHistory.length > 0 && cmdHistoryIndex < cmdHistory.length - 1) {
            cmdHistoryIndex++;
            cmdInput.value = cmdHistory[cmdHistoryIndex];
        } else {
            cmdHistoryIndex = cmdHistory.length;
            cmdInput.value = '';
        }
    }
});

// 3. Reconnect on Badge Click or Connect Button
// If user clicks the "Disconnected" red badge, try to reconnect.
document.getElementById('statusBadge').addEventListener('click', () => connection.connect());
document.getElementById('btnConnect').addEventListener('click', () => {
    if (connection.connected) {
        connection.disconnect();
    } else {
        connection.connect();
    }
});

// 4. Sync Editor changes
// When user types in the editor, update our global variable so the preview knows.
editor.addEventListener('input', () => {
    state.gcode = editor.value;
});

// --- Initialization ---

// Setup the Tab clicking logic (Preview vs Editor)
setupTabs(() => state);

// Handle Window Resize
// If the window size changes, we need to redraw the canvas so it doesn't look stretched.
window.addEventListener('resize', () => {
    if (state.gcode && !document.getElementById('canvasContainer').classList.contains('hidden')) {
         requestAnimationFrame(() => renderGCode(state.gcode, 'gcodeCanvas', 'canvasContainer', state.stepsPerMM));
    }
});

// --- File Handling Setup ---

// Callback: What to do when a file is processed and ready?
const onGCodeReady = (newGCode, stepsPerMM = 1.0) => {
    state.gcode = newGCode;
    state.stepsPerMM = stepsPerMM;
    editor.value = newGCode;
    state.wasInterrupted = false; // Reset interruption flag on new file
    state.lastSentCmd = null; // Clear last known position
};

// Handle "Open File" button
document.getElementById('fileInput').addEventListener('change', (e) => {
    state.currentFile = e.target.files[0];
    handleFile(state.currentFile, onGCodeReady, window.switchTab);
});

// Helper: compute steps/unit from 3 axis inputs
function getAxisSteps(motorId, microId, distId, fallback) {
    const m  = parseFloat(document.getElementById(motorId)?.value) || 200;
    const mi = parseFloat(document.getElementById(microId)?.value) || 1;
    const d  = parseFloat(document.getElementById(distId)?.value)  || 1;
    const v  = (m * mi) / d;
    return (isNaN(v) || v <= 0) ? fallback : v;
}

const updateAxisLabels = () => {
    const axes = [
        { label: 'xStepsLabel', m: 'xMotorSteps', mi: 'xMicrosteps', d: 'xMmPerRev',  fb: 160,  unit: 'steps/mm' },
        { label: 'yStepsLabel', m: 'yMotorSteps', mi: 'yMicrosteps', d: 'yMmPerRev',  fb: 160,  unit: 'steps/mm' },
        { label: 'zStepsLabel', m: 'zMotorSteps', mi: 'zMicrosteps', d: 'zMmPerRev',  fb: 800,  unit: 'steps/mm' },
        { label: 'aStepsLabel', m: 'aMotorSteps', mi: 'aMicrosteps', d: 'aDegPerRev', fb: 8.88, unit: 'steps/°'  },
    ];
    axes.forEach(({ label, m, mi, d, fb, unit }) => {
        const el = document.getElementById(label);
        if (el) el.textContent = `= ${getAxisSteps(m, mi, d, fb).toFixed(2)} ${unit}`;
    });
};

const retriggerConversion = () => {
    updateAxisLabels();
    if (state.currentFile && state.currentFile.name.toLowerCase().endsWith('.svg')) {
        log('Re-calculating trajectory with new settings...', 'info');
        handleFile(state.currentFile, onGCodeReady, window.switchTab);
    }
};

// Slider sync
segmentLengthSlider.addEventListener('input', (e) => { segmentLengthInput.value = e.target.value; });
segmentLengthInput.addEventListener('input', (e) => { segmentLengthSlider.value = e.target.value; });
cuttingSpeedSlider.addEventListener('input', (e) => { cuttingSpeedInput.value = e.target.value; });
cuttingSpeedInput.addEventListener('input', (e) => { cuttingSpeedSlider.value = e.target.value; });

const maxStepsSlider = document.getElementById('maxStepsSlider');
const maxStepsInput = document.getElementById('maxStepsInput');
const maxSpeedSlider = document.getElementById('maxSpeedSlider');
const maxSpeedInput = document.getElementById('maxSpeedInput');

if (maxStepsSlider && maxStepsInput) {
    maxStepsSlider.addEventListener('input', (e) => { maxStepsInput.value = e.target.value; });
    maxStepsInput.addEventListener('input', (e) => { maxStepsSlider.value = e.target.value; });
}
if (maxSpeedSlider && maxSpeedInput) {
    maxSpeedSlider.addEventListener('input', (e) => { maxSpeedInput.value = e.target.value; });
    maxSpeedInput.addEventListener('input', (e) => { maxSpeedSlider.value = e.target.value; });
}

// Watch all config inputs for changes
[
    segmentLengthSlider, segmentLengthInput, cuttingSpeedSlider, cuttingSpeedInput,
    maxStepsSlider, maxStepsInput, maxSpeedSlider, maxSpeedInput,
    'xRs485Id','xMotorSteps','xMicrosteps','xMmPerRev',
    'yRs485Id','yMotorSteps','yMicrosteps','yMmPerRev',
    'zRs485Id','zMotorSteps','zMicrosteps','zMmPerRev',
    'aRs485Id','aMotorSteps','aMicrosteps','aDegPerRev',
].forEach(idOrEl => {
    const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
    if (el) {
        el.addEventListener('change', retriggerConversion);
        el.addEventListener('input',  updateAxisLabels);
    }
});

// Initialize labels on load
updateAxisLabels();

// Modal Logic
btnSettings.addEventListener('click', () => {
    configModal.classList.remove('hidden');
    // small delay to allow display:block to apply before animating opacity
    setTimeout(() => configModal.classList.add('visible'), 10);
});

const closeModal = () => {
    configModal.classList.remove('visible');
    setTimeout(() => configModal.classList.add('hidden'), 300); // match transition duration
};

btnCloseModal.addEventListener('click', closeModal);
configModal.addEventListener('click', (e) => {
    if (e.target === configModal) closeModal();
});

// Handle Drag & Drop
// We need to prevent the default browser behavior (which is opening the file in the tab)
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
    }, false);
});

// Visual cue when dragging over
dropZone.addEventListener('dragover', () => {
    document.querySelectorAll('.empty-state').forEach(el => el.classList.add('drag-over'));
});

dropZone.addEventListener('dragleave', () => {
    document.querySelectorAll('.empty-state').forEach(el => el.classList.remove('drag-over'));
});

// Handle the Drop
dropZone.addEventListener('drop', (e) => {
    document.querySelectorAll('.empty-state').forEach(el => el.classList.remove('drag-over'));
    state.currentFile = e.dataTransfer.files[0];
    handleFile(state.currentFile, onGCodeReady, window.switchTab);
});

// Connection requires a user gesture for WebSerial, so we don't auto-connect
// on page load anymore.

// ============================================================================
//  JOG CONTROL
// ============================================================================

/**
 * JOG STATE
 * We track a local "displayed" position so the user can see accumulated deltas.
 * This is NOT the machine's actual encoder position — it's a dead-reckoning counter.
 */
const jogState = {
    step: 0.1,        // Current step size in mm
    posX: 0,
    posY: 0,
    posZ: 0,
    posA: 0,
};

const jogModal = document.getElementById('jogModal');
const btnJog   = document.getElementById('btnJog');

/** Open / close helpers (same fade pattern as config modal) */
function openJogModal() {
    jogModal.classList.remove('hidden');
    setTimeout(() => jogModal.classList.add('visible'), 10);
    // Bind keyboard jogging while modal is open
    window.addEventListener('keydown', handleJogKey);
}

function closeJogModal() {
    jogModal.classList.remove('visible');
    setTimeout(() => jogModal.classList.add('hidden'), 300);
    window.removeEventListener('keydown', handleJogKey);
}

btnJog.addEventListener('click', openJogModal);
document.getElementById('btnCloseJog').addEventListener('click', closeJogModal);
jogModal.addEventListener('click', (e) => { if (e.target === jogModal) closeJogModal(); });

/** Step-size pill buttons */
document.querySelectorAll('.jog-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.jog-step-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        jogState.step = parseFloat(btn.dataset.step);
    });
});

/**
 * SEND JOG
 * Builds and sends a `jog <dx_mm> <dy_mm> <dz_mm> <da_deg>` command.
 * The Pico firmware is expected to interpret this as a relative move.
 *
 * @param {number} dx - X delta in mm
 * @param {number} dy - Y delta in mm
 * @param {number} dz - Z delta in mm
 * @param {number} da - A delta in degrees
 */
function sendJog(dx, dy, dz, da = 0) {
    if (!connection.connected) {
        log('Jog: Not connected to machine.', 'error');
        return;
    }

    // 1. Get current scaling factors from UI
    const xStepsPerMM = getAxisSteps('xMotorSteps', 'xMicrosteps', 'xMmPerRev', 160);
    const yStepsPerMM = getAxisSteps('yMotorSteps', 'yMicrosteps', 'yMmPerRev', 160);
    const zStepsPerMM = getAxisSteps('zMotorSteps', 'zMicrosteps', 'zMmPerRev', 800);
    const aStepsPerDeg = getAxisSteps('aMotorSteps', 'aMicrosteps', 'aDegPerRev', 8.88);
    const feedRate     = parseFloat(document.getElementById('cuttingSpeedInput')?.value) || 30;

    // Get RS485 IDs
    const idX = parseInt(document.getElementById('xRs485Id')?.value) || 3;
    const idY = parseInt(document.getElementById('yRs485Id')?.value) || 2;
    const idZ = parseInt(document.getElementById('zRs485Id')?.value) || 1;
    const idA = parseInt(document.getElementById('aRs485Id')?.value) || 4;

    // 2. Calculate relative steps
    // Note: Z-axis convention is positive for DOWN, so we negate dz (Up is positive)
    const relX = Math.round(dx * xStepsPerMM);
    const relY = Math.round(dy * yStepsPerMM);
    const relZ = Math.round(-dz * zStepsPerMM);
    const relA = Math.round(da * aStepsPerDeg);

    if (relX === 0 && relY === 0 && relZ === 0 && relA === 0) return;

    // 3. Calculate velocities in steps/sec (absolute)
    let stepVx = Math.abs(Math.round(feedRate * xStepsPerMM));
    let stepVy = Math.abs(Math.round(feedRate * yStepsPerMM));
    let stepVz = Math.abs(Math.round(feedRate * zStepsPerMM));

    // Calculate duration for synchronous motion
    let duration = 0;
    if (stepVx > 0 && relX !== 0) duration = Math.abs(relX) / stepVx;
    else if (stepVy > 0 && relY !== 0) duration = Math.abs(relY) / stepVy;
    else if (stepVz > 0 && relZ !== 0) duration = Math.abs(relZ) / stepVz;

    let stepVa = 0;
    if (relA !== 0) {
        if (duration > 0) {
            stepVa = Math.abs(relA) / duration;
        } else {
            stepVa = aStepsPerDeg * 360; 
            duration = Math.abs(relA) / stepVa;
        }
        stepVa = Math.max(1, Math.round(stepVa));
    }

    if (duration > 0) {
        if (relX !== 0) stepVx = Math.max(1, Math.round(Math.abs(relX) / duration));
        if (relY !== 0) stepVy = Math.max(1, Math.round(Math.abs(relY) / duration));
        if (relZ !== 0) stepVz = Math.max(1, Math.round(Math.abs(relZ) / duration));
    }

    let ids = [];
    let steps = [];
    let sps = [];
    
    if (relX !== 0) { ids.push(idX); steps.push(relX); sps.push(stepVx); }
    if (relY !== 0) { ids.push(idY); steps.push(relY); sps.push(stepVy); }
    if (relZ !== 0) { ids.push(idZ); steps.push(relZ); sps.push(stepVz); }
    if (relA !== 0) { ids.push(idA); steps.push(relA); sps.push(stepVa); }

    // 4. Build command string: "move <count> <ids> <steps> <sps>"
    const cmd = `move ${ids.length} ${ids.join(' ')} ${steps.join(' ')} ${sps.join(' ')}`;
    connection.send(cmd, true);

    // Update local dead-reckoning position display (in mm/deg)
    jogState.posX += dx;
    jogState.posY += dy;
    jogState.posZ += dz;
    jogState.posA += da;
    document.getElementById('jogPosX').textContent = jogState.posX.toFixed(2);
    document.getElementById('jogPosY').textContent = jogState.posY.toFixed(2);
    document.getElementById('jogPosZ').textContent = jogState.posZ.toFixed(2);
    document.getElementById('jogPosA').textContent = jogState.posA.toFixed(2);
}

// D-pad and Z buttons
document.getElementById('jogXPlus') .addEventListener('click', () => sendJog( jogState.step, 0, 0, 0));
document.getElementById('jogXMinus').addEventListener('click', () => sendJog(-jogState.step, 0, 0, 0));
document.getElementById('jogYPlus') .addEventListener('click', () => sendJog(0,  jogState.step, 0, 0));
document.getElementById('jogYMinus').addEventListener('click', () => sendJog(0, -jogState.step, 0, 0));
document.getElementById('jogZPlus') .addEventListener('click', () => sendJog(0, 0,  jogState.step, 0));
document.getElementById('jogZMinus').addEventListener('click', () => sendJog(0, 0, -jogState.step, 0));
document.getElementById('jogAPlus') .addEventListener('click', () => sendJog(0, 0, 0,  jogState.step));
document.getElementById('jogAMinus').addEventListener('click', () => sendJog(0, 0, 0, -jogState.step));

// Home button — sends the same 'home' command as "Go to Zero"
document.getElementById('jogHome').addEventListener('click', () => {
    if (!connection.connected) { log('Jog: Not connected.', 'error'); return; }
    connection.send('home', true);
    // Reset dead-reckoning position to zero after homing
    jogState.posX = 0; jogState.posY = 0; jogState.posZ = 0; jogState.posA = 0;
    document.getElementById('jogPosX').textContent = '0.00';
    document.getElementById('jogPosY').textContent = '0.00';
    document.getElementById('jogPosZ').textContent = '0.00';
    document.getElementById('jogPosA').textContent = '0.00';
});

// Reset position display
document.getElementById('jogResetPos').addEventListener('click', () => {
    jogState.posX = 0; jogState.posY = 0; jogState.posZ = 0; jogState.posA = 0;
    document.getElementById('jogPosX').textContent = '0.00';
    document.getElementById('jogPosY').textContent = '0.00';
    document.getElementById('jogPosZ').textContent = '0.00';
    document.getElementById('jogPosA').textContent = '0.00';
});

/**
 * KEYBOARD JOG HANDLER
 * Arrow keys → X/Y, PageUp/PageDown → Z, Home → zero.
 * Only active when the jog modal is open.
 */
function handleJogKey(e) {
    // Don't steal keys from text inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const keyMap = {
        'ArrowRight': () => sendJog( jogState.step, 0, 0),
        'ArrowLeft':  () => sendJog(-jogState.step, 0, 0),
        'ArrowUp':    () => sendJog(0,  jogState.step, 0),
        'ArrowDown':  () => sendJog(0, -jogState.step, 0),
        'PageUp':     () => sendJog(0, 0,  jogState.step, 0),
        'PageDown':   () => sendJog(0, 0, -jogState.step, 0),
        '[':          () => sendJog(0, 0, 0, -jogState.step),
        ']':          () => sendJog(0, 0, 0,  jogState.step),
        'Home':       () => document.getElementById('jogHome').click(),
    };

    if (keyMap[e.key]) {
        e.preventDefault();
        keyMap[e.key]();
    }
}