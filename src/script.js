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
import { handleFile } from './FileHandler.js?v=5';
import { CanvasEditor } from './CanvasEditor.js?v=12';
import { analyzeDrawing, buildSVG } from './DrawingVectorizer.js?v=6';
import { packMicrosegment } from './BinaryUtils.js';

/**
 * Canonical per-axis resolution fallbacks — these MUST match the firmware's
 * machine config (Urumi-Fw/pipeline/stages/config.py): X/Y 160 steps/mm,
 * Z 400 steps/mm, A 120 steps/deg. Used only when the Settings inputs are
 * empty; the UI Settings remain the live source of truth. Centralised here so
 * the three places that previously hard-coded mismatched defaults (80 / 800 /
 * 92.44) can no longer drift. (Assessment R3 / fix F3.)
 */
const DEFAULT_STEPS = { X: 160, Y: 160, Z: 400, A: 103 };

/**
 * stampSeq — copies a 26-byte MicroSegment packet, stamps the rolling
 * sequence number into byte [22], and recomputes the CRC-8.
 * Mirrors host/serialise.py:stamp_seq().
 */
function stampSeq(packet, seq) {
    const buf = new Uint8Array(26);
    buf.set(packet);
    buf[22] = seq & 0xFF;
    // Recompute CRC over bytes [0..24]
    let crc = 0;
    for (let i = 0; i < 25; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x01) ? ((crc >> 1) ^ 0x8C) : (crc >> 1);
        }
    }
    buf[25] = crc & 0xFF;
    return buf;
}


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
    gcode: '',           // Display text of the loaded file (preamble lines joined)
    preamble: [],        // Text setup commands before the binary stream
    binaryPackets: [],   // Pre-built Uint8Array[] from the converter
    currentFile: null,   // Holds the raw File object to allow re-conversion
    stepsPerMM: 1.0,     // Conversion factor for Viewer canvas
    lastSentCmd: null,   // Tracks the last sent trajectory line
    currentLine: null,   // Tracks the exact string currently being sent
    wasInterrupted: false, // Flags if the job was stopped midway
    isWaitingForReady: false, // Flag to wait for Pico's "ready" when buffer is full
    resendTimeout: null, // Tracks the timeout for resending commands to prevent spam
    simulatedPathIndex: -1, // Tracks executed path index in simulation and live runs
    suctionMode: 'auto', // Suction mode: 'auto' or 'manual'
    suctionZones: [false, false, false, false, false, false], // Manual selection status for the 6 zones
    suctionAutoActiveZones: [], // Automated active zones calculated from the drawing
    suctionLastSignature: null, // Last suction/servo state actually sent to hardware
    suctionControlEnabled: false, // Master gate: only send suction commands when enabled
    activeRunType: null, // 'job', 'jog', 'park', or null
    parkEnabled: localStorage.getItem('parkEnabled') === 'true', // Whether gantry should park after job finishes
    parkX: parseFloat(localStorage.getItem('parkX')) || 0, // X park coordinate in mm
    parkY: parseFloat(localStorage.getItem('parkY')) || 0, // Y park coordinate in mm
    isParking: false, // Internal flag to track when the machine is executing the park move
    isPaused: false, // Internal flag to track when the machine is paused for a tool change
    pendingPackets: [],      // Array holding binary packets to send
    base: 0,                 // Go-Back-N oldest unacknowledged packet index
    nextSend: 0,             // Go-Back-N next packet to send
    isBinaryStreaming: false, // Flag: are we currently streaming binary segments?
    lastProgressTime: 0,     // Timestamp of last progress (ACK)
    crcErrors: 0,            // Consecutive CRC errors counter
    nacksCount: 0,           // Total NACKs count
    retriesCount: 0,         // Total Go-Back-N retries count
    goBackTimeout: null,     // Timeout handle for Go-Back-N wait
    isGoBackWaiting: false,  // Is waiting for Go-Back-N settle/backpressure
    stallChecker: null,      // Interval handle for stall detection
    isWaitingForDrain: false, // Are we waiting for the Pico buffer to drain?
    statusPollInterval: null, // Interval handle for status polling
    simTimeout: null,         // Simulation timeout handle
    expectedPktSeq: 0,       // Expected Pico ACK sequence number (F1)
    isWaitingForBuffer: false // Is waiting for buffer space to clear (F4)
};

let wakeLock = null; // Global reference for the Screen Wake Lock API

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
    // When the machine ACK's a binary packet.
    onAck: (seq) => {
        if (!state.isSending) return;

        // Reject stale skip-ACKs that arrive after a Go-Back-N rewind has settled.
        // During rewind, the Pico skip-ACKs the remaining in-flight window. Those
        // stale skip-ACKs will have seq numbers below our updated expectedPktSeq.
        // Advancing by one per valid ACK is exactly what sender.py does and keeps
        // base aligned with the firmware's expectedSeq. (F1)
        if (state.isGoBackWaiting || seq < state.expectedPktSeq) {
            return;
        }

        // Accept the valid ACK and update expected sequence count
        state.expectedPktSeq = seq + 1;

        if (state.base < state.pendingPackets.length) {
            updatePositionFromPacket(state.pendingPackets[state.base]);
            state.base++;
        }
        state.lastProgressTime = Date.now();
        state.crcErrors = 0; // Reset consecutive CRC errors on progress

        // Render path in viewer (works even if tab is hidden)
        if (state.base - 1 > state.simulatedPathIndex) {
            state.simulatedPathIndex = state.base - 1;
            updateViewer();
        }

        // V2 progress tracking
        if (typeof updateExecutionProgress === 'function') {
            updateExecutionProgress();
        }

        // Send next window
        sendWindow();
    },

    // When the machine says "nope" (Buffer Full) or has a CRC error
    onNack: (reason) => {
        if (!state.isSending) return;

        // Already rewinding — any further NACKs in this window are stale; the
        // pending go-back will resend everything from `base`. (Fix F1.)
        if (state.isGoBackWaiting) return;

        state.nacksCount++;
        if (reason === 0x03) { // NACK_BAD_MAGIC
            log('FATAL: Pico reported bad magic - aborting.', 'error');
            stopJob();
            return;
        }

        if (reason === 0x01) { // NACK_CRC
            state.crcErrors++;
            if (state.crcErrors > 20) {
                log('FATAL: 20 consecutive CRC errors - aborting.', 'error');
                stopJob();
                return;
            }
            log(`CRC Error (reason 0x01). Rewinding to base ${state.base}...`, 'warning');
            goBack(reason, 5); // 5ms settle delay
        } else if (reason === 0x02) { // NACK_FULL (buffer full backpressure)
            if (state.isWaitingForBuffer) return; // Already waiting
            log(`Buffer Full NACK (reason 0x02). Waiting for buffer space...`, 'info');
            state.isWaitingForBuffer = true;

            // Send status query to check buffer immediately
            connection.send('status');
            if (!state.statusPollInterval) {
                state.statusPollInterval = setInterval(() => {
                    if (state.isSending && state.isWaitingForBuffer) {
                        connection.send('status');
                    }
                }, 100); // Poll status every 100ms
            }

            goBack(reason, 50); // 50ms backpressure delay
        }
    },

    // When a text command is acknowledged (e.g. 'ok', 'ack', 'seq reset')
    onAckText: () => {
        if (state.isSending && !state.isBinaryStreaming && !state.isWaitingForDrain) {
            executeNextTextCommand();
        }
    },

    // When the machine is ready after buffer full (Pico signals buffer drained below watermark)
    onReady: () => {
        if (state.isSending && state.isWaitingForBuffer) {
            log('Pico signaled READY (buffer drained). Resuming transmission.', 'success');
            state.isWaitingForBuffer = false;
            if (state.statusPollInterval) {
                clearInterval(state.statusPollInterval);
                state.statusPollInterval = null;
            }
            sendWindow();
        }
    },
    // When the machine says nope (legacy text stream callback, ignored in binary streaming)
    onNope: () => { },

    // If the connection drops mid-job, we must stop everything for safety.
    onDisconnect: stopJob
});

// Register a custom message listener to handle status responses
connection.addMessageListener((msg) => {
    if (msg.includes('state=') && msg.includes('buf=')) {
        handleStatusResponse(msg);
    }
});

// --- Job Control Logic ---

/**
 * Processes status messages from the Pico to monitor buffer drain.
 */
function handleStatusResponse(msg) {
    const match = msg.match(/buf=(\d+)\/(\d+)/);
    if (match) {
        const count = parseInt(match[1]);
        if (state.isWaitingForDrain) {
            log(`Pico execution buffer: ${count} segments remaining.`, 'info');
            if (count === 0) {
                state.isWaitingForDrain = false;
                log('Pico buffer empty. Execution finished physically.', 'success');
                if (state.statusPollInterval) {
                    clearInterval(state.statusPollInterval);
                    state.statusPollInterval = null;
                }

                // Now execute trailing commands or finish the job!
                if (state.gcodeQueue.length > 0) {
                    executeNextTextCommand();
                } else {
                    finishJob();
                }
            }
        } else if (state.isWaitingForBuffer) {
            // Watchdog (F4): resume when buffer drains below low-watermark (384/512)
            if (count < 384) {
                log(`Buffer drained to ${count}/512. Resuming transmission.`, 'success');
                state.isWaitingForBuffer = false;
                if (state.statusPollInterval) {
                    clearInterval(state.statusPollInterval);
                    state.statusPollInterval = null;
                }
                sendWindow();
            }
        }
    }
}

/**
 * Updates the Trajectory Preview canvas with the current simulatedPathIndex.
 * Works even when the Trajectory Preview tab is hidden by temporarily assigning
 * a minimum canvas size if the container's layout is collapsed (display:none gives 0×0).
 */
function updateViewer() {
    const container = document.getElementById('canvasContainer');
    const canvas    = document.getElementById('gcodeCanvas');
    if (!canvas || !container) return;

    // If the panel is hidden, getBoundingClientRect() returns 0. Use a fallback size
    // so the render still produces valid data that the user sees on switching tabs.
    const rect = container.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) {
        canvas.width  = 960;
        canvas.height = 640;
    }
    renderGCode(state.gcode, 'gcodeCanvas', 'canvasContainer', state.stepsPerMM, state.simulatedPathIndex, state.binaryPackets, null, { x: jogState.posX, y: jogState.posY });
}

/**
 * Updates the dead-reckoning position display by decoding a binary MicroSegment packet.
 */
function updatePositionFromPacket(packet) {
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const dx = view.getInt32(1, true);
    const dy = view.getInt32(5, true);
    const dz = view.getInt32(9, true);
    const da = view.getInt32(13, true);

    const xStepsPerMM = getAxisSteps('xStepsPerMM', DEFAULT_STEPS.X);
    const yStepsPerMM = getAxisSteps('yStepsPerMM', DEFAULT_STEPS.Y);
    const zStepsPerMM = getAxisSteps('zStepsPerMM', DEFAULT_STEPS.Z);
    const aStepsPerDeg = getAxisSteps('aStepsPerDeg', DEFAULT_STEPS.A);

    jogState.posX += dx / xStepsPerMM;
    jogState.posY += dy / yStepsPerMM;
    jogState.posZ += -dz / zStepsPerMM; // negative steps mean Up, so we negate
    jogState.posA += da / aStepsPerDeg;

    const posXText = jogState.posX.toFixed(2);
    const posYText = jogState.posY.toFixed(2);
    const posZText = jogState.posZ.toFixed(2);
    const posAText = jogState.posA.toFixed(2);

    const xEl = document.getElementById('jogPosX');
    const yEl = document.getElementById('jogPosY');
    const zEl = document.getElementById('jogPosZ');
    const aEl = document.getElementById('jogPosA');
    if (xEl) xEl.textContent = posXText;
    if (yEl) yEl.textContent = posYText;
    if (zEl) zEl.textContent = posZText;
    if (aEl) aEl.textContent = posAText;

    const hudX = document.getElementById('hudPosX');
    const hudY = document.getElementById('hudPosY');
    const hudZ = document.getElementById('hudPosZ');
    const hudA = document.getElementById('hudPosA');
    if (hudX) hudX.textContent = posXText;
    if (hudY) hudY.textContent = posYText;
    if (hudZ) hudZ.textContent = posZText;
    if (hudA) hudA.textContent = posAText;

    // V2: Sync Setup coordinates and bed graphic visualizer
    if (typeof updateSetupCoordinates === 'function') {
        updateSetupCoordinates();
    }
    if (typeof updateSetupBedVisualizer === 'function') {
        updateSetupBedVisualizer();
    }
}

/**
 * Rewinds transmission to base after a delay.
 */
function goBack(reason, delayMs) {
    if (state.goBackTimeout) {
        clearTimeout(state.goBackTimeout);
    }
    
    // Account for the in-flight packets that will be skip-ACKed by the Pico.
    // Advance the expected ACK sequence by the size of the skipped in-flight window.
    const inFlight = state.nextSend - state.base;
    if (inFlight > 0) {
        state.expectedPktSeq += (inFlight - 1);
    }
    state.nextSend = state.base;

    state.isGoBackWaiting = true;
    state.goBackTimeout = setTimeout(() => {
        state.goBackTimeout = null;
        state.isGoBackWaiting = false;
        if (state.isSending) {
            state.retriesCount++;
            sendWindow();
        }
    }, delayMs);
}

/**
 * Sends a sliding window of packets.
 */
function sendWindow() {
    if (!state.isSending || !state.isBinaryStreaming || state.isWaitingForBuffer) return;

    const isSimMode = document.getElementById('simModeCheckbox')?.checked;

    if (state.base >= state.pendingPackets.length) {
        log('Binary streaming block completed.', 'success');
        state.isBinaryStreaming = false;
        state.pendingPackets = [];
        executeNextTextCommand();
        return;
    }

    if (isSimMode) {
        simulateBinaryStreaming();
        return;
    }

    if (state.isGoBackWaiting) return;

    const WINDOW_SIZE = 16;
    while (state.nextSend < state.base + WINDOW_SIZE && state.nextSend < state.pendingPackets.length) {
        const packet = state.pendingPackets[state.nextSend];
        connection.send(packet);
        state.nextSend++;
    }

    if (!state.stallChecker) {
        state.lastProgressTime = Date.now();
        state.stallChecker = setInterval(checkStall, 1000);
    }
}

/**
 * Periodically checks for protocol stalls and forces a rewind if needed.
 */
function checkStall() {
    if (!state.isSending || !state.isBinaryStreaming) {
        if (state.stallChecker) {
            clearInterval(state.stallChecker);
            state.stallChecker = null;
        }
        return;
    }

    if (state.isGoBackWaiting) return;

    const timeSinceLastProgress = Date.now() - state.lastProgressTime;
    if (timeSinceLastProgress > 3000) {
        log(`Protocol stall detected (no ACK for 3s). Rewinding to base ${state.base}...`, 'warning');
        state.lastProgressTime = Date.now();
        state.nextSend = state.base;
        state.retriesCount++;
        sendWindow();
    }
}

/**
 * Simulates binary streaming when Sim Mode is enabled.
 */
function simulateBinaryStreaming() {
    if (state.simTimeout) return;

    const simulateNext = () => {
        if (!state.isSending || !state.isBinaryStreaming) {
            state.simTimeout = null;
            return;
        }

        if (state.base < state.pendingPackets.length) {
            const packet = state.pendingPackets[state.base];
            updatePositionFromPacket(packet);

            state.base++;
            state.nextSend = state.base;
            state.lastProgressTime = Date.now();

            if (state.base - 1 > state.simulatedPathIndex) {
                state.simulatedPathIndex = state.base - 1;
                updateViewer();
            }

            // V2 progress tracking
            if (typeof updateExecutionProgress === 'function') {
                updateExecutionProgress();
            }

            state.simTimeout = setTimeout(simulateNext, 50);
        } else {
            state.simTimeout = null;
            log('Binary streaming block completed (simulated).', 'success');
            state.isBinaryStreaming = false;
            state.pendingPackets = [];
            executeNextTextCommand();
        }
    };

    state.simTimeout = setTimeout(simulateNext, 50);
}

/**
 * START JOB
 * Called when the user clicks "Start Cutting".
 * It prepares the G-code and starts the sending loop.
 */
function startJob() {
    if (!state.preamble.length && !state.binaryPackets?.length) {
        log('No trajectory loaded. Please load an SVG or G-code file first.', 'error');
        return;
    }

    // Build queue: preamble text commands + binary stream sentinel
    state.gcodeQueue = state.preamble
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith(';'));

    // Inject binary stream sentinel after preamble if packets exist
    if (state.binaryPackets && state.binaryPackets.length > 0) {
        state.gcodeQueue.push('__BINARY_STREAM__');
    }

    if (state.gcodeQueue.length === 0) {
        log('No commands to send.', 'error');
        return;
    }

    state.activeRunType = 'job';

    // --- SUCTION BED INJECTION (before __BINARY_STREAM__ sentinel) ---
    if (shouldRunSuction()) {
        const suctionCommands = buildSuctionCommandSequence(true);
        const sentinelIdx = state.gcodeQueue.indexOf('__BINARY_STREAM__');
        if (sentinelIdx > -1) {
            state.gcodeQueue.splice(sentinelIdx, 0, ...suctionCommands);
        } else {
            state.gcodeQueue.unshift(...suctionCommands);
        }
        state.suctionLastSignature = suctionCommands.join('|');
        log(`Injected Suction Settings: ${suctionCommands.join(' | ')}`, 'info');
    }

    // --- SAFE RETRACT INJECTION (binary packet prepended to binaryPackets) ---
    if (state.wasInterrupted && state.binaryPackets?.length) {
        const zStepsPerMM = getAxisSteps('zStepsPerMM', DEFAULT_STEPS.Z);
        const zUpStep = Math.round(5 * zStepsPerMM);
        const feedRate = parseFloat(document.getElementById('cuttingSpeedInput')?.value) || 22;
        const stepVz = Math.max(1, Math.round(feedRate * zStepsPerMM));
        const interval = Math.max(1, Math.min(Math.round(150_000_000 / stepVz), 150_000_000));
        const retractPkt = stampSeq(packMicrosegment(0, 0, -zUpStep, 0, interval, 0x01, 0), 0);
        state.binaryPackets = [retractPkt, ...state.binaryPackets];
        log(`Injected Safe Retract (Z-Up) as binary packet`, 'info');
    }

    state.wasInterrupted = false;
    state.simulatedPathIndex = -1;
    state.isParking = false;

    log(`Starting Job: ${state.gcodeQueue.length} lines.`, 'success');

    // 2. Update State
    state.isSending = true;
    setStartButtonState(true); // Visual change (Turn button Red/Stop)

    // F6: Request Wake Lock to prevent browser from throttling JS/WebSerial
    if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen')
            .then(lock => { wakeLock = lock; log('Wake Lock active.', 'info'); })
            .catch(err => log('Wake Lock blocked (requires HTTPS or localhost).', 'warning'));
    }

    // 3. Kickoff
    executeNextTextCommand();
}

function resumeJob() {
    state.isPaused = false;
    state.isSending = true;
    setStartButtonState(true, false);
    log('▶️ Resuming job...', 'success');
    if (state.isBinaryStreaming) {
        sendWindow();
    } else {
        executeNextTextCommand();
    }
}

function pauseJob() {
    if (!state.isSending || state.isPaused) return;
    state.isSending = false;
    state.isPaused = true;
    setStartButtonState(false, true);
    log('⏸️ Job Paused. Pico motion stopped. Click Resume to continue.', 'warning');
    if (connection.connected) {
        connection.send('stop', true);
    }
    if (typeof updateExecutionProgress === 'function') {
        updateExecutionProgress();
    }
}

/**
 * STOP JOB
 * Called by user or on error. Clears the queue immediately.
 */
function stopJob() {
    if (!state.isSending && !state.isPaused) return; // Prevent duplicate logs if already stopped

    const hadActiveRun = shouldRunSuction();
    state.activeRunType = null;
    state.isSending = false;
    state.isPaused = false;
    state.gcodeQueue = []; // Delete all remaining commands
    state.wasInterrupted = true; // Mark that it was stopped mid-way

    // Clear all timers and intervals
    if (state.resendTimeout) {
        clearTimeout(state.resendTimeout);
        state.resendTimeout = null;
    }
    if (state.goBackTimeout) {
        clearTimeout(state.goBackTimeout);
        state.goBackTimeout = null;
    }
    if (state.stallChecker) {
        clearInterval(state.stallChecker);
        state.stallChecker = null;
    }
    if (state.statusPollInterval) {
        clearInterval(state.statusPollInterval);
        state.statusPollInterval = null;
    }
    if (state.simTimeout) {
        clearTimeout(state.simTimeout);
        state.simTimeout = null;
    }
    
    // F6: Release Wake Lock
    if (wakeLock) {
        wakeLock.release().then(() => { wakeLock = null; });
    }
    state.isBinaryStreaming = false;
    state.isWaitingForDrain = false;
    state.isGoBackWaiting = false;
    state.isWaitingForBuffer = false;

    // Send stop command to machine immediately
    if (connection.connected) {
        connection.send('stop', true);
    }

    // Shut off suction immediately for safety and power efficiency
    if (connection.connected && (hadActiveRun || state.suctionLastSignature !== 'OFF')) {
        sendSuctionCommands(false, false);
    }
    updateSuctionUI();

    log('Job Stopped. Position saved for safe retract on restart. Suction deactivated.', 'error');
    setStartButtonState(false); // Turn button back to Green/Start
}

/**
 * GENERATE PARK COMMANDS
 * Calculates relative step motions to travel from current dead-reckoning position
 * to the user's customized park coordinates, ensuring a safe Z retraction first.
 */
function generateParkCommands() {
    const cmds = [];

    const xStepsPerMM = getAxisSteps('xStepsPerMM', DEFAULT_STEPS.X);
    const yStepsPerMM = getAxisSteps('yStepsPerMM', DEFAULT_STEPS.Y);
    const zStepsPerMM = getAxisSteps('zStepsPerMM', DEFAULT_STEPS.Z);
    const feedRate = parseFloat(document.getElementById('cuttingSpeedInput')?.value) || 22;

    // Step 1: Ensure Z-axis is retracted to a safe height (5mm above bed)
    const zTarget = 5;
    if (jogState.posZ < zTarget) {
        const dz = zTarget - jogState.posZ;
        const relZ = Math.round(-dz * zStepsPerMM); // positive dz (Up) -> negative Z steps
        if (relZ !== 0) {
            const stepVz = Math.max(1, Math.round(feedRate * zStepsPerMM));
            const interval = Math.max(1, Math.min(Math.round(150_000_000 / stepVz), 150_000_000));
            cmds.push(packMicrosegment(0, 0, relZ, 0, interval, 0x01, 0));
            jogState.posZ = zTarget;
        }
    }

    // Step 2: Traverse X and Y to the park coordinates
    const dx = state.parkX - jogState.posX;
    const dy = state.parkY - jogState.posY;
    const relX = Math.round(dx * xStepsPerMM);
    const relY = Math.round(dy * yStepsPerMM);

    if (relX !== 0 || relY !== 0) {
        const maxAbsStep = Math.max(Math.abs(relX), Math.abs(relY));
        const spu = maxAbsStep === Math.abs(relX) ? xStepsPerMM : yStepsPerMM;
        const speed = feedRate * spu;
        const interval = Math.max(1, Math.min(Math.round(150_000_000 / speed), 150_000_000));
        cmds.push(packMicrosegment(relX, relY, 0, 0, interval, 0, 0));
    }

    return cmds;
}

/**
 * PARK NOW
 * Manually commands the gantry to travel to the park position coordinates immediately.
 */
function parkNow() {
    if (!connection.connected && !document.getElementById('simModeCheckbox')?.checked) {
        log('Park: Not connected to machine.', 'error');
        return;
    }

    log('Moving gantry to park position...', 'info');
    const pkts = generateParkCommands();
    if (pkts && pkts.length > 0) {
        // Stamp seq numbers and stream directly
        state.activeRunType = 'park';
        state.binaryPackets = pkts;
        state.gcodeQueue = ['__BINARY_STREAM__'];
        state.isSending = true;
        setStartButtonState(true);
        executeNextTextCommand();
        log('Park sequence initiated.', 'success');
    } else {
        log('Gantry is already at the park position.', 'info');
    }
}

/**
 * EXECUTE NEXT TEXT COMMAND
 * Sends the next non-motion or setup command sequentially.
 */
function executeNextTextCommand() {
    if (!state.isSending) return;

    if (state.gcodeQueue.length > 0) {
        const nextCmd = state.gcodeQueue[0];

    // When we hit a __BINARY_STREAM__ sentinel, launch the binary pipeline
        if (nextCmd === '__BINARY_STREAM__') {
            state.gcodeQueue.shift();
            startBinaryStreaming(state.binaryPackets);
            return;
        }

        if (nextCmd === '__JOG_BINARY_STREAM__') {
            state.gcodeQueue.shift();
            startBinaryStreaming(state.jogPackets);
            return;
        }

        // WAIT_MS:<ms> sentinel — pause before sending the next command.
        // Used after 'enable all 1' so the Pico finishes its enable sequence
        // before we send suction/stream commands (avoids "Command queue full").
        if (nextCmd.startsWith('WAIT_MS:')) {
            state.gcodeQueue.shift();
            const ms = parseInt(nextCmd.split(':')[1]) || 200;
            setTimeout(() => { if (state.isSending) executeNextTextCommand(); }, ms);
            return;
        }

        state.currentLine = state.gcodeQueue.shift();

        if (state.currentLine === 'PAUSE_FOR_TOOL_CHANGE') {
            log('⏸️ PAUSED FOR TOOL CHANGE. Please change the tool, then click Resume Job.', 'warning');
            state.isSending = false;
            state.isPaused = true;
            setStartButtonState(false, true);
            return;
        }

        const isSimMode = document.getElementById('simModeCheckbox')?.checked;
        if (isSimMode) {
            log(`[SIM] ${state.currentLine}`, 'tx');
            setTimeout(() => {
                if (!state.isSending) return;
                log('PICO: ok', 'success');
                executeNextTextCommand();
            }, 50);
        } else {
            connection.send(state.currentLine);
            log(`> ${state.currentLine}`, 'tx');
        }
    } else {
        if (state.parkEnabled && !state.isParking) {
            state.isParking = true;
            log('Job trajectory completed. Initiating Gantry Park sequence...', 'info');
            const parkCmds = generateParkCommands();
            if (parkCmds && parkCmds.length > 0) {
                state.gcodeQueue.push(...parkCmds);
                executeNextTextCommand();
                return;
            }
        }

        state.isParking = false;

        const isSimMode = document.getElementById('simModeCheckbox')?.checked;
        if (isSimMode || !connection.connected) {
            finishJob();
        } else {
            log('Waiting for Pico motion buffer to drain...', 'info');
            state.isWaitingForDrain = true;
            connection.send('status');
            state.statusPollInterval = setInterval(() => {
                if (state.isSending && state.isWaitingForDrain) {
                    connection.send('status');
                } else {
                    clearInterval(state.statusPollInterval);
                    state.statusPollInterval = null;
                }
            }, 250);
        }
    }
}

/**
 * START BINARY STREAMING
 * Takes a pre-built Uint8Array[] and starts Go-Back-N transmission.
 * @param {Uint8Array[]} packets - Pre-built 26-byte binary packets from SvgConverter.
 */
function startBinaryStreaming(packets) {
    if (!packets || packets.length === 0) {
        log('Binary stream: no packets to send.', 'warning');
        executeNextTextCommand();
        return;
    }

    // Stamp rolling sequence numbers (0..255 wrap)
    state.pendingPackets = packets.map((pkt, i) => stampSeq(pkt, i & 0xFF));

    state.base = 0;
    state.nextSend = 0;
    state.expectedPktSeq = 0;
    state.isBinaryStreaming = true;
    state.lastProgressTime = Date.now();
    state.crcErrors = 0;

    log(`Starting binary stream of ${state.pendingPackets.length} segments...`, 'info');

    const isSimMode = document.getElementById('simModeCheckbox')?.checked;
    if (isSimMode) {
        simulateBinaryStreaming();
    } else {
        connection.send('seqreset');
        sendWindow();
    }
}

/**
 * FINISH JOB
 * Clean up after the last command is sent.
 */
function finishJob() {
    const completedRunType = state.activeRunType;
    const hadActiveRun = shouldRunSuction();
    state.isSending = false;
    state.activeRunType = null;
    state.isWaitingForBuffer = false;

    // Jobs always finish with suction off; jog/park can restore manual suction state.
    const shouldRestoreManualSuction = completedRunType !== 'job' && shouldRunSuction();
    if (connection.connected) {
        if (shouldRestoreManualSuction || hadActiveRun || state.suctionLastSignature !== 'OFF') {
            sendSuctionCommands(false, shouldRestoreManualSuction);
        }
    }
    updateSuctionUI();

    if (completedRunType === 'jog') {
        log('Jog move complete.', 'success');
    } else if (completedRunType === 'park') {
        log('Park sequence complete.', 'success');
    } else {
        log('Job Complete. Suction deactivated.', 'success');
    }
    
    // F6: Release Wake Lock
    if (wakeLock) {
        wakeLock.release().then(() => { wakeLock = null; });
    }
    
    setStartButtonState(false);
    if (typeof updateExecutionProgress === 'function') {
        updateExecutionProgress();
    }
}

// --- Event Listeners ---

// Wake Lock Re-Acquisition on Tab Visibility Change
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.isSending) {
        try {
            if (!wakeLock) {
                wakeLock = await navigator.wakeLock.request('screen');
                log('Wake Lock re-acquired.', 'info');
            }
        } catch (err) {
            log('Wake Lock re-request failed: ' + err.message, 'warning');
        }
    }
});

// --- Panel Toggle Logic ---
const suctionPanelHeader = document.getElementById('suctionPanelHeader');
const suctionPanelBody = document.getElementById('suctionPanelBody');
const suctionPanelToggle = document.getElementById('suctionPanelToggle');

if (suctionPanelHeader && suctionPanelBody) {
    suctionPanelHeader.addEventListener('click', (e) => {
        // Prevent toggle if clicking on the status text or other interactive elements
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;

        if (suctionPanelBody.style.display === 'none') {
            suctionPanelBody.style.display = 'flex';
            if (suctionPanelToggle) suctionPanelToggle.style.transform = 'rotate(180deg)';
        } else {
            suctionPanelBody.style.display = 'none';
            if (suctionPanelToggle) suctionPanelToggle.style.transform = 'rotate(0deg)';
        }
    });
}

const parkPanelHeader = document.getElementById('parkPanelHeader');
const parkPanelBody = document.getElementById('parkPanelBody');
const parkPanelToggle = document.getElementById('parkPanelToggle');

if (parkPanelHeader && parkPanelBody) {
    parkPanelHeader.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.closest('label')) return;

        if (parkPanelBody.style.display === 'none') {
            parkPanelBody.style.display = 'flex';
            if (parkPanelToggle) parkPanelToggle.style.transform = 'rotate(180deg)';
        } else {
            parkPanelBody.style.display = 'none';
            if (parkPanelToggle) parkPanelToggle.style.transform = 'rotate(0deg)';
        }
    });
}

// Move To & Park UI Bindings
const moveToX = document.getElementById('moveToX');
const moveToY = document.getElementById('moveToY');
const moveToZ = document.getElementById('moveToZ');
const moveToA = document.getElementById('moveToA');
const btnMoveModeAbs = document.getElementById('btnMoveModeAbs');
const btnMoveModeRel = document.getElementById('btnMoveModeRel');
const btnMoveToGo = document.getElementById('btnMoveToGo');

let isMoveModeAbsolute = true;

if (btnMoveModeAbs && btnMoveModeRel) {
    btnMoveModeAbs.addEventListener('click', () => {
        isMoveModeAbsolute = true;
        btnMoveModeAbs.classList.add('active');
        btnMoveModeRel.classList.remove('active');
    });
    btnMoveModeRel.addEventListener('click', () => {
        isMoveModeAbsolute = false;
        btnMoveModeRel.classList.add('active');
        btnMoveModeAbs.classList.remove('active');
    });
}

if (btnMoveToGo) {
    btnMoveToGo.addEventListener('click', () => {
        const mx = parseFloat(moveToX.value) || 0;
        const my = parseFloat(moveToY.value) || 0;
        const mz = parseFloat(moveToZ.value) || 0;
        const ma = parseFloat(moveToA.value) || 0;

        let dx = 0, dy = 0, dz = 0, da = 0;

        if (isMoveModeAbsolute) {
            dx = mx - jogState.posX;
            dy = my - jogState.posY;
            dz = mz - jogState.posZ;
            da = ma - jogState.posA;
        } else {
            dx = mx;
            dy = my;
            dz = mz;
            da = ma;
        }

        sendJog(dx, dy, dz, da);
    });
}

const parkModeCheckbox = document.getElementById('parkModeCheckbox');
const parkStatusText = document.getElementById('parkStatusText');
const btnSetParkCurrent = document.getElementById('btnSetParkCurrent');
const btnParkNow = document.getElementById('btnParkNow');

if (parkModeCheckbox) {
    parkModeCheckbox.checked = state.parkEnabled;
    if (parkStatusText) parkStatusText.textContent = state.parkEnabled ? 'ON' : 'OFF';

    parkModeCheckbox.addEventListener('change', () => {
        state.parkEnabled = parkModeCheckbox.checked;
        localStorage.setItem('parkEnabled', state.parkEnabled);
        if (parkStatusText) parkStatusText.textContent = state.parkEnabled ? 'ON' : 'OFF';
        log(`Park Mode ${state.parkEnabled ? 'Enabled' : 'Disabled'}`, 'success');
    });
}

if (btnSetParkCurrent) {
    btnSetParkCurrent.addEventListener('click', () => {
        state.parkX = Math.round(jogState.posX * 100) / 100;
        state.parkY = Math.round(jogState.posY * 100) / 100;
        
        if (moveToX) moveToX.value = state.parkX;
        if (moveToY) moveToY.value = state.parkY;
        if (moveToZ) moveToZ.value = Math.round(jogState.posZ * 100) / 100;
        if (moveToA) moveToA.value = Math.round(jogState.posA * 100) / 100;

        localStorage.setItem('parkX', state.parkX);
        localStorage.setItem('parkY', state.parkY);

        log(`Pulled current coordinates for Move/Park. (Park X=${state.parkX}, Y=${state.parkY})`, 'success');
    });
}

if (btnParkNow) {
    btnParkNow.addEventListener('click', () => {
        parkNow();
    });
}

// Macros UI Bindings
const macrosGrid = document.getElementById('macrosGrid');
const macroModal = document.getElementById('macroModal');
const btnCloseMacroModal = document.getElementById('btnCloseMacroModal');
const btnSaveMacro = document.getElementById('btnSaveMacro');
const macroNameInput = document.getElementById('macroNameInput');
const macroCommandInput = document.getElementById('macroCommandInput');

let customMacros = JSON.parse(localStorage.getItem('customMacros') || '[]');

function renderMacros() {
    if (!macrosGrid) return;
    
    macrosGrid.innerHTML = '';
    
    // Default Macros
    const defaultMacros = [
        { name: 'Ping All', cmd: 'pingall', isPrompt: false },
        { name: 'Ping ID', cmd: 'ping', isPrompt: true }
    ];

    const allMacros = [...defaultMacros, ...customMacros];

    allMacros.forEach((macro, index) => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-outline macro-btn';
        btn.textContent = macro.name;
        
        btn.addEventListener('click', () => {
            let finalCmd = macro.cmd;
            if (macro.isPrompt) {
                const arg = prompt(`Enter argument for ${macro.name}:`);
                if (arg === null || arg === '') return;
                finalCmd = `${macro.cmd} ${arg}`;
            }
            
            log(`Macro Executed: ${macro.name}`, 'info');
            if (connection.connected) {
                connection.sendLine(finalCmd);
            } else {
                log(`Cannot execute ${macro.name}, not connected.`, 'error');
            }
        });

        // Add right-click to delete custom macros
        if (index >= defaultMacros.length) {
            btn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (confirm(`Delete custom macro "${macro.name}"?`)) {
                    customMacros.splice(index - defaultMacros.length, 1);
                    localStorage.setItem('customMacros', JSON.stringify(customMacros));
                    renderMacros();
                }
            });
            btn.title = "Right-click to delete";
        }

        macrosGrid.appendChild(btn);
    });

    // Add Button
    const btnAdd = document.createElement('button');
    btnAdd.className = 'btn btn-outline macro-btn';
    btnAdd.style.borderStyle = 'dashed';
    btnAdd.style.color = 'var(--text-muted)';
    btnAdd.textContent = '+ Add';
    btnAdd.addEventListener('click', () => {
        macroNameInput.value = '';
        macroCommandInput.value = '';
        macroModal.classList.remove('hidden');
    });
    macrosGrid.appendChild(btnAdd);
}

if (macroModal && btnCloseMacroModal && btnSaveMacro) {
    btnCloseMacroModal.addEventListener('click', () => {
        macroModal.classList.add('hidden');
    });

    btnSaveMacro.addEventListener('click', () => {
        const name = macroNameInput.value.trim();
        const cmd = macroCommandInput.value.trim();
        if (name && cmd) {
            customMacros.push({ name, cmd, isPrompt: false });
            localStorage.setItem('customMacros', JSON.stringify(customMacros));
            macroModal.classList.add('hidden');
            renderMacros();
            log(`Saved custom macro: ${name}`, 'success');
        } else {
            alert('Please enter both a name and a command.');
        }
    });
}

// Initial render
renderMacros();

// 1. Start/Stop Button Logic
btnStart.addEventListener('click', () => {
    if (state.isSending) {
        stopJob();
    } else if (state.isPaused) {
        resumeJob();
    } else {
        startJob();
    }
});

const btnPause = document.getElementById('btnPause');
if (btnPause) {
    btnPause.addEventListener('click', () => {
        if (state.isSending) {
            pauseJob();
        }
    });
}

const btnStop = document.getElementById('btnStop');
if (btnStop) {
    btnStop.addEventListener('click', () => {
        stopJob();
    });
}

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
        const motorsIndicator = document.querySelector('#activityMotors .status-circle-indicator');
        if (isEnabled) {
            connection.send('disable all', true);
            btnToggleMotors.dataset.enabled = 'false';
            btnToggleMotors.textContent = 'Enable Motors';
            if (motorsIndicator) {
                motorsIndicator.className = 'status-circle-indicator disabled';
            }
        } else {
            connection.send('enable all', true);
            btnToggleMotors.dataset.enabled = 'true';
            btnToggleMotors.textContent = 'Disable Motors';
            if (motorsIndicator) {
                motorsIndicator.className = 'status-circle-indicator enabled';
            }
        }
    });
}

const btnPingAll = document.getElementById('btnPingAll');
if (btnPingAll) {
    btnPingAll.addEventListener('click', async () => {
        if (!connection.connected) {
            log('Ping All: Not connected to machine.', 'error');
            return;
        }

        // Disable button during the ping process to prevent spamming
        btnPingAll.disabled = true;
        const originalText = btnPingAll.textContent;
        btnPingAll.textContent = 'Pinging...';

        log('Starting sequential Ping All (Nodes 1 to 4)...', 'info');
        const nodes = [1, 2, 3, 4];

        for (const node of nodes) {
            if (!connection.connected) {
                log('Ping All: Connection lost.', 'error');
                break;
            }

            log(`Sending: ping ${node}`, 'info');
            connection.send(`ping ${node}`, true);

            // Wait for response or timeout (e.g. 1.5 seconds)
            await new Promise((resolve) => {
                let resolved = false;
                const timeout = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        log(`Node ${node} ping timeout (no response).`, 'warning');
                        connection.removeMessageListener(listener);
                        resolve();
                    }
                }, 1500); // 1.5 second timeout is robust for WebSerial

                const listener = (msg) => {
                    const lowerMsg = msg.toLowerCase();
                    // We look for a response matching this node, e.g. "pong 1", "pong", "ok", "ack" or direct acknowledgment
                    if (lowerMsg.includes('pong') || lowerMsg.includes('ack') || lowerMsg.includes('ok') || lowerMsg.includes(`ping ${node}`)) {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeout);
                            connection.removeMessageListener(listener);
                            log(`Node ${node} responded.`, 'success');
                            // Small delay before next ping for visual clarity
                            setTimeout(resolve, 200);
                        }
                    }
                };
                connection.addMessageListener(listener);
            });
        }

        log('Ping All sequence completed.', 'success');
        btnPingAll.disabled = false;
        btnPingAll.textContent = originalText;
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

// 3. Reconnect/Disconnect on Status Badge Click (Toggles connection)
document.getElementById('statusBadge').addEventListener('click', () => {
    state.suctionLastSignature = null;
    if (connection.connected) {
        connection.disconnect();
    } else {
        connection.connect();
    }
});

// 4. Sync Editor changes
// When user types in the Raw SVG editor, update our global variable and synchronise to the canvas in real-time
editor.addEventListener('input', () => {
    state.gcode = editor.value;
    if (canvasEditor) {
        canvasEditor.importSVG(editor.value);
    }
    state.suctionAutoActiveZones = calculateActiveZones(state.gcode, state.binaryPackets);
    updateSuctionUI();
});

// --- File Handling Setup ---

// Callback: What to do when a file is processed and ready?
// result: { preamble: string[], packets: Uint8Array[] }
function onGCodeReady(result, stepsPerMM = 1.0) {
    // Accept either the new {preamble, packets} object or a legacy plain string
    if (typeof result === 'string') {
        result = { preamble: result.split('\n').filter(l => l.trim()), packets: [] };
    }
    state.preamble = result.preamble || [];
    state.binaryPackets = result.packets || [];
    state.gcode = state.preamble.join('\n');
    state.stepsPerMM = stepsPerMM;
    editor.value = state.gcode + (state.binaryPackets.length > 0
        ? `\n; [${state.binaryPackets.length} binary MicroSegment packets ready]` : '');
    const setupArea = document.getElementById('setupInstructionsText');
    if (setupArea) {
        let instructions = [];
        if (state.preamble && state.preamble.length > 0) {
            instructions.push("; Preamble Commands");
            instructions.push(...state.preamble);
            instructions.push("");
        }
        if (state.binaryPackets && state.binaryPackets.length > 0) {
            instructions.push("; Motion Microsegments (mseg <dx> <dy> <dz> <da> <interval> <flags>)");
            state.binaryPackets.forEach((pkt) => {
                const view = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
                const dx = view.getInt32(1, true);
                const dy = view.getInt32(5, true);
                const dz = view.getInt32(9, true);
                const da = view.getInt32(13, true);
                const interval = view.getUint32(17, true);
                const flags = view.getUint8(21);
                instructions.push(`mseg ${dx} ${dy} ${dz} ${da} ${interval} ${flags}`);
            });
        }
        setupArea.value = instructions.join('\n');
    }
    state.wasInterrupted = false;
    state.lastSentCmd = null;

    // Automatically calculate bed zones where shapes are active
    state.suctionAutoActiveZones = calculateActiveZones(state.gcode, state.binaryPackets);
    updateSuctionUI();

    // Enable start button if connected or in simulation mode
    const isSim = document.getElementById('simModeCheckbox')?.checked;
    if (connection.connected || isSim) {
        btnStart.disabled = false;
    }

    // V2: Update progress tracker and activity checklist
    if (typeof updateExecutionProgress === 'function') {
        updateExecutionProgress();
    }
    const runActiveFile = document.getElementById('runActiveFileLabel');
    if (runActiveFile) {
        runActiveFile.textContent = state.currentFile ? state.currentFile.name : 'Drawn Shapes';
    }
    const activityFileDot = document.querySelector('#activityFile .status-circle-indicator');
    if (activityFileDot) {
        activityFileDot.className = 'status-circle-indicator loaded';
    }

    // Automatically transition to the Prepare tab
    switchMode('setup');
    if (window.switchSetupTab) {
        window.switchSetupTab('image');
    }
}

// --- Initialization ---

// ── Draw Canvas Editor Setup ─────────────────────────────────────────────────
// The CanvasEditor needs the same viewport metrics that Viewer computes so that
// its machine-mm ↔ canvas-px transforms match exactly. We keep a shared live
// object and update it whenever the draw tab opens.
const drawViewState = { scale: 1, offsetX: 0, offsetY: 0, bedW: 960, bedH: 770 };

const drawCanvasEl = document.getElementById('drawCanvas');
const drawContainer = document.getElementById('drawCanvasContainer');
let canvasEditor = null;

if (drawCanvasEl) {
    canvasEditor = new CanvasEditor(drawCanvasEl, drawViewState);
    window.canvasEditor = canvasEditor;
    canvasEditor.onChange = () => {
        updatePropertiesInspector();
        if (editor) {
            editor.value = canvasEditor.exportAsSVG();
            state.gcode = editor.value;
        }
    };
    canvasEditor.onToolChange = (toolName) => {
        document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.remove('active'));
        const btn = document.querySelector(`.draw-tool-btn[data-tool="${toolName}"]`);
        if (btn) btn.classList.add('active');
    };
}

// Recompute viewport metrics (mirrors the Viewer math)
let hasInitializedView = false;
function updateDrawViewMetrics() {
    const bedW = parseFloat(document.getElementById('bedWidthInput')?.value) || 960;
    const bedH = parseFloat(document.getElementById('bedHeightInput')?.value) || 770;

    if (!drawContainer || !drawCanvasEl) return;
    const rect = drawContainer.getBoundingClientRect();
    
    let resized = false;
    if (drawCanvasEl.width !== rect.width) { drawCanvasEl.width = rect.width; resized = true; }
    if (drawCanvasEl.height !== rect.height) { drawCanvasEl.height = rect.height; resized = true; }

    if (!hasInitializedView || resized) {
        const padding = 40;
        const availW = drawCanvasEl.width - padding * 2;
        const availH = drawCanvasEl.height - padding * 2;
        const scale = Math.min(availW / bedW, availH / bedH);

        const offsetX = drawCanvasEl.width / 2 - (bedW / 2) * scale;
        const offsetY = drawCanvasEl.height / 2 + (bedH / 2) * scale;

        Object.assign(drawViewState, { scale, offsetX, offsetY, bedW, bedH });
        hasInitializedView = true;
    } else {
        drawViewState.bedW = bedW;
        drawViewState.bedH = bedH;
    }
}

// Draw bridge passed to Tabs so it can activate/deactivate editor on tab switch
const drawBridge = {
    activate() {
        updateDrawViewMetrics();
        if (canvasEditor) {
            canvasEditor.activate();
            canvasEditor.draw();
        }
    },
    deactivate() {
        if (canvasEditor) canvasEditor.deactivate();
    }
};

// Add listener for Method Toggle
document.querySelectorAll('.method-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const method = e.currentTarget.dataset.value;

        // Update UI active state
        document.querySelectorAll('.method-toggle-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');

        // Update hidden input for compatibility
        const hiddenInput = document.getElementById('drawShapeMethod');
        if (hiddenInput) hiddenInput.value = method;

        if (canvasEditor) canvasEditor.setCurrentMethod(method);
    });
});




// Keyboard shortcuts for tools (only when draw panel is visible)
window.addEventListener('keydown', e => {
    if (!document.getElementById('drawPanel') ||
        document.getElementById('drawPanel').classList.contains('hidden')) return;
    if (document.activeElement.tagName === 'INPUT' ||
        document.activeElement.tagName === 'TEXTAREA') return;
    const map = { 'v': 'select', 'p': 'pencil', 'l': 'line', 'r': 'rect', 'e': 'circle', 'x': 'eraser', 'b': 'bezier' };
    const tool = map[e.key.toLowerCase()];
    if (tool) {
        selectDrawTool(tool);
    }
    // Ctrl+Z undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && canvasEditor) {
        if (canvasEditor.shapes.length > 0) {
            canvasEditor.shapes.pop();
            canvasEditor.draw();
        }
    }
    // Ctrl+G group
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'g' && canvasEditor) {
        e.preventDefault();
        canvasEditor.groupNodes();
    }
    // Ctrl+Shift+G ungroup
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'g' && canvasEditor) {
        e.preventDefault();
        canvasEditor.ungroupNodes();
    }
});

function selectDrawTool(toolName) {
    if (canvasEditor) canvasEditor.setTool(toolName);
    document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.draw-tool-btn[data-tool="${toolName}"]`);
    if (btn) btn.classList.add('active');
    // Eraser radius options are only relevant while the eraser is active
    const eraserOpts = document.getElementById('eraserOptions');
    if (eraserOpts) eraserOpts.classList.toggle('hidden', toolName !== 'eraser');
}

// Wire all palette tool buttons
document.querySelectorAll('.draw-tool-btn').forEach(btn => {
    btn.addEventListener('click', () => selectDrawTool(btn.dataset.tool));
});

// Stroke width
const drawStrokeInput = document.getElementById('drawStrokeWidth');
if (drawStrokeInput) {
    drawStrokeInput.addEventListener('input', () => {
        if (canvasEditor) canvasEditor.setStrokeWidth(parseFloat(drawStrokeInput.value) || 1.5);
    });
}

// Eraser radius
const drawEraserInput = document.getElementById('drawEraserRadius');
if (drawEraserInput) {
    drawEraserInput.addEventListener('input', () => {
        if (canvasEditor) canvasEditor.setEraserRadius(parseFloat(drawEraserInput.value) || 5);
    });
}

// Clear All
document.getElementById('btnDrawClear')?.addEventListener('click', () => {
    if (canvasEditor) {
        canvasEditor.clearAll();
        // Re-draw bed background
        drawBridge.activate();
    }
});

// Skeletonize
document.getElementById('btnDrawSkeletonize')?.addEventListener('click', () => {
    if (canvasEditor) {
        log('Skeletonizing drawn shapes...', 'info');
        canvasEditor.skeletonize();
        log('Skeletonization complete.', 'success');
    }
});

// Undo
document.getElementById('btnDrawUndo')?.addEventListener('click', () => {
    if (canvasEditor && canvasEditor.shapes.length > 0) {
        canvasEditor.shapes.pop();
        canvasEditor.draw();
    }
});

// Group / Ungroup Buttons
document.getElementById('btnDrawGroup')?.addEventListener('click', () => {
    if (canvasEditor) canvasEditor.groupNodes();
});

document.getElementById('btnDrawUngroup')?.addEventListener('click', () => {
    if (canvasEditor) canvasEditor.ungroupNodes();
});

// Send to Cutter – exports canvas drawing (if Draw is active) or reads Raw SVG text,
// then processes the G-Code trajectory and switches to Run workspace
function sendToCutter() {
    const activeTab = document.querySelector('.sub-tabs .tab.active');
    const isDrawActive = activeTab ? activeTab.innerText.trim().toLowerCase().includes('draw') : true;

    let svgText = '';
    if (isDrawActive) {
        if (!canvasEditor || !canvasEditor.hasShapes) {
            log('No drawn shapes to send.', 'error');
            return;
        }
        svgText = canvasEditor.exportAsSVG();
    } else {
        svgText = document.getElementById('gcodeEditor').value;
        if (!svgText.trim()) {
            log('No raw SVG code to send.', 'error');
            return;
        }
    }

    const virtualFile = new File([svgText], 'canvas_drawing.svg', { type: 'image/svg+xml' });
    log('Converting SVG to trajectory...', 'info');
    handleFile(virtualFile, onGCodeReady, window.switchTab);
}

document.getElementById('btnSendToCutter')?.addEventListener('click', sendToCutter);
document.getElementById('btnDrawSend')?.addEventListener('click', sendToCutter);

// Import SVG to CanvasEditor triggers
const triggerDrawImport = () => {
    document.getElementById('drawFileInput')?.click();
};
document.getElementById('btnDrawImport')?.addEventListener('click', triggerDrawImport);
document.getElementById('dtImport')?.addEventListener('click', triggerDrawImport);

// Vision Integration (Capture image with phone / PeerJS WebRTC)
let peer = null;
let peerConnection = null;

const visionQrModal = document.getElementById('visionQrModal');

function closeVisionModal() {
    if (!visionQrModal) return;
    visionQrModal.classList.remove('visible');
    setTimeout(() => visionQrModal.classList.add('hidden'), 250);

    // Tear down the WebRTC session — the next open starts a fresh peer + new QR
    try { if (peerConnection) peerConnection.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    peerConnection = null;
    peer = null;
}

document.getElementById('btnCloseVisionModal')?.addEventListener('click', closeVisionModal);
visionQrModal?.addEventListener('click', (e) => {
    if (e.target === visionQrModal) closeVisionModal();
});

// ── Vision: manual 4-corner crop + perspective flatten (pure JS, no heavy libs) ─
const PAPER_SIZES = {
    A4:     { w: 210, h: 297 },
    A3:     { w: 297, h: 420 },
    A5:     { w: 148, h: 210 },
    Letter: { w: 216, h: 279 },
};

let visionSourceImg = null;  // original received photo

function getSelectedPaperMM() {
    const sel = document.getElementById('visionPaperSize')?.value || 'A4';
    if (sel === 'custom') {
        const w = parseFloat(document.getElementById('visionPaperW')?.value) || 210;
        const h = parseFloat(document.getElementById('visionPaperH')?.value) || 297;
        return { w, h };
    }
    return PAPER_SIZES[sel] || PAPER_SIZES.A4;
}

// Order 4 points as [top-left, top-right, bottom-right, bottom-left].
function _orderCorners(pts) {
    const bySum  = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
    return [bySum[0], byDiff[0], bySum[3], byDiff[3]]; // tl, tr, br, bl
}

// ── Interactive crop overlay (Google-Docs / CamScanner style, canvas-rendered) ─
// cropCorners: [tl, tr, br, bl] in IMAGE-NATURAL pixel coordinates.
// The photo is drawn onto the canvas with a view transform (zoom + pan), so the
// image, handles and loupe all share ONE coordinate space — no letterboxing skew.
let cropCorners   = null;
let _activeCorner = -1;
let _cropRO       = null;
let _isPanning    = false;
let _lastPan      = null;
// view: screenPx = imgPx * (baseScale * z) + offset
const cropView = { z: 1, ox: 0, oy: 0, baseScale: 1, boxW: 0, boxH: 0 };

// ── PC-side page detector: OpenCV GrabCut in a Web Worker, pre-fills cropper corners ──
let _detWorker = null, _detSeq = 0;
const _detPending = {};
function getDetectWorker() {
    if (_detWorker) return _detWorker;
    try {
        _detWorker = new Worker('vision-detect-worker.js');
        _detWorker.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'result' && _detPending[m.id]) { _detPending[m.id](m); delete _detPending[m.id]; }
        };
        _detWorker.onerror = () => { _detWorker = null; };
    } catch (e) { _detWorker = null; }
    return _detWorker;
}
// Returns Promise<[{x,y}×4] in image-natural px> or null. Detection runs off-thread.
function detectPageCorners(img, timeoutMs = 9000) {
    return new Promise((resolve) => {
        const wk = getDetectWorker();
        if (!wk) return resolve(null);
        const procW = 320, nw = img.naturalWidth, nh = img.naturalHeight;
        const ph = Math.max(1, Math.round(procW * nh / nw));
        const c = document.createElement('canvas'); c.width = procW; c.height = ph;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0, procW, ph);
        const imgData = cx.getImageData(0, 0, procW, ph);
        const id = ++_detSeq;
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        _detPending[id] = (m) => {
            if (!m.valid || !m.quad) return finish(null);
            const sx = nw / procW, sy = nh / ph;
            finish(m.quad.map(p => ({ x: Math.max(0, Math.min(nw, p[0]*sx)), y: Math.max(0, Math.min(nh, p[1]*sy)) })));
        };
        setTimeout(() => { delete _detPending[id]; finish(null); }, timeoutMs);
        wk.postMessage({ id, data: imgData.data.buffer, w: procW, h: ph }, [imgData.data.buffer]);
    });
}

let _hintFadeTimer = null;
function showVisionPreview(img, detectedCorners) {
    visionSourceImg = img;
    // Swap connect → crop state: widen the modal so the canvas flexes to fill it
    document.querySelector('.vision-modal')?.classList.add('cropping');
    const hint = document.getElementById('visionCropHint');
    if (hint) {
        hint.classList.remove('faded');
        clearTimeout(_hintFadeTimer);
        _hintFadeTimer = setTimeout(() => hint.classList.add('faded'), 4500);
    }

    const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
    // Use phone-detected page corners when valid (4 points inside the image), else a default rectangle
    const valid = Array.isArray(detectedCorners) && detectedCorners.length === 4 &&
        detectedCorners.every(p => p && isFinite(p.x) && isFinite(p.y) &&
            p.x >= 0 && p.x <= nw && p.y >= 0 && p.y <= nh);
    cropCorners = valid
        ? detectedCorners.map(p => ({ x: p.x, y: p.y }))
        : [
            { x: nw * 0.15, y: nh * 0.15 }, { x: nw * 0.85, y: nh * 0.15 },
            { x: nw * 0.85, y: nh * 0.85 }, { x: nw * 0.15, y: nh * 0.85 },
        ];
    bindCropPointer();
    fitCropView();
    if (!_cropRO) { _cropRO = new ResizeObserver(() => { fitCropView(); }); _cropRO.observe(document.getElementById('visionCropArea')); }

    const pill = document.getElementById('visionCropStatus');
    if (pill) {
        pill.textContent = valid
            ? '✓ Page auto-detected — fine-tune if needed'
            : 'Drag each corner to a paper edge';
        pill.style.color = valid ? '#10b981' : '#60a5fa';
    }
}

// Fit the whole photo into the canvas box at z=1 and centre it (retries until laid out).
let _cropFitRetries = 0;
function fitCropView() {
    const area = document.getElementById('visionCropArea');
    const boxW = area.clientWidth, boxH = area.clientHeight;
    if ((!boxW || !boxH) && _cropFitRetries < 60) { _cropFitRetries++; requestAnimationFrame(fitCropView); return; }
    _cropFitRetries = 0;
    if (!boxW || !boxH || !visionSourceImg) return;

    const nw = visionSourceImg.naturalWidth, nh = visionSourceImg.naturalHeight;
    cropView.boxW = boxW; cropView.boxH = boxH;
    cropView.baseScale = Math.min(boxW / nw, boxH / nh);
    cropView.z = 1;
    cropView.ox = (boxW - nw * cropView.baseScale) / 2;
    cropView.oy = (boxH - nh * cropView.baseScale) / 2;

    drawCropOverlay();
}

function _vs() { return cropView.baseScale * cropView.z; }         // current px-per-imgpx
function imgToScreen(p) { const s = _vs(); return { x: cropView.ox + p.x * s, y: cropView.oy + p.y * s }; }
function screenToImg(q) { const s = _vs(); return { x: (q.x - cropView.ox) / s, y: (q.y - cropView.oy) / s }; }

function drawCropOverlay() {
    if (!cropCorners || !visionSourceImg) return;
    const cv = document.getElementById('visionCropCanvas');
    const { boxW, boxH } = cropView;
    if (!boxW || !boxH) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(boxW * dpr); cv.height = Math.round(boxH * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, boxW, boxH);

    // Photo under the current view transform
    const s = _vs();
    ctx.drawImage(visionSourceImg, cropView.ox, cropView.oy,
        visionSourceImg.naturalWidth * s, visionSourceImg.naturalHeight * s);

    const d = cropCorners.map(imgToScreen);
    // Dim outside the quad
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, boxW, boxH);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.moveTo(d[0].x, d[0].y); d.slice(1).forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath(); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // Quad outline
    ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(d[0].x, d[0].y); d.slice(1).forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath(); ctx.stroke();
    // Handles
    d.forEach(p => {
        ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = '#3b82f6'; ctx.stroke();
        ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI); ctx.fillStyle = '#3b82f6'; ctx.fill();
    });
}

function _localXY(e) {
    const r = document.getElementById('visionCropCanvas').getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// Nearest corner handle within grab distance of a screen point, or -1.
function _hitCorner(q, radius = 22) {
    let nearest = -1, best = Infinity;
    cropCorners.forEach((c, i) => {
        const sp = imgToScreen(c);
        const dist = Math.hypot(sp.x - q.x, sp.y - q.y);
        if (dist < best) { best = dist; nearest = i; }
    });
    return best <= radius ? nearest : -1;
}

function bindCropPointer() {
    const cv = document.getElementById('visionCropCanvas');
    if (cv._cropBound) return; cv._cropBound = true;

    const down = (e) => {
        const q = _localXY(e);
        const hit = _hitCorner(q);
        if (hit >= 0) { _activeCorner = hit; }
        else { _isPanning = true; _lastPan = q; cv.style.cursor = 'grabbing'; }
        cv.setPointerCapture(e.pointerId);
        if (_activeCorner >= 0) updateLoupe(_activeCorner);
        e.preventDefault();
    };
    const move = (e) => {
        const q = _localXY(e);
        if (_activeCorner >= 0) {
            const p = screenToImg(q);
            const nw = visionSourceImg.naturalWidth, nh = visionSourceImg.naturalHeight;
            cropCorners[_activeCorner] = { x: Math.max(0, Math.min(nw, p.x)), y: Math.max(0, Math.min(nh, p.y)) };
            drawCropOverlay(); updateLoupe(_activeCorner); e.preventDefault();
        } else if (_isPanning) {
            cropView.ox += q.x - _lastPan.x; cropView.oy += q.y - _lastPan.y; _lastPan = q;
            clampCropPan(); drawCropOverlay(); e.preventDefault();
        } else {
            // Hover: magnify the corner under the pointer WITHOUT moving it,
            // so an already-perfect corner can be verified before touching it.
            const hover = _hitCorner(q);
            if (hover >= 0) { cv.style.cursor = 'pointer'; updateLoupe(hover); }
            else { cv.style.cursor = 'grab'; document.getElementById('visionLoupe').style.display = 'none'; }
        }
    };
    const up = () => {
        _activeCorner = -1; _isPanning = false; _lastPan = null;
        cv.style.cursor = 'grab';
        document.getElementById('visionLoupe').style.display = 'none';
    };
    const leave = () => {
        if (_activeCorner < 0 && !_isPanning) document.getElementById('visionLoupe').style.display = 'none';
    };

    const wheel = (e) => {
        e.preventDefault();
        const q = _localXY(e);
        const pim = screenToImg(q);
        const factor = Math.exp(-e.deltaY * 0.0015);
        cropView.z = Math.max(1, Math.min(8, cropView.z * factor));
        const s = _vs();
        cropView.ox = q.x - pim.x * s; cropView.oy = q.y - pim.y * s;
        clampCropPan(); drawCropOverlay();
    };

    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', leave);
    cv.addEventListener('wheel', wheel, { passive: false });
}

// Keep at least part of the image within the viewport.
function clampCropPan() {
    const s = _vs();
    const iw = visionSourceImg.naturalWidth * s, ih = visionSourceImg.naturalHeight * s;
    const { boxW, boxH } = cropView;
    const margin = 40;
    cropView.ox = Math.min(boxW - margin, Math.max(margin - iw, cropView.ox));
    cropView.oy = Math.min(boxH - margin, Math.max(margin - ih, cropView.oy));
}

// Magnifier bubble centred on a corner (shown on hover to verify, and while dragging).
function updateLoupe(cornerIdx = _activeCorner) {
    if (cornerIdx < 0 || !cropCorners) return;
    const loupe = document.getElementById('visionLoupe');
    const corner = cropCorners[cornerIdx];
    const size = 140, Z = 2;
    const ctx = loupe.getContext('2d');
    const s = _vs();
    const halfNat = (size / 2) / (s * Z); // natural px shown each side (tracks current zoom)

    // Corner role for the handle (cropCorners order = tl, tr, br, bl)
    const CORNER = [
        { name: 'Top-Left',     hx:  1, vy:  1 },
        { name: 'Top-Right',    hx: -1, vy:  1 },
        { name: 'Bottom-Right', hx: -1, vy: -1 },
        { name: 'Bottom-Left',  hx:  1, vy: -1 },
    ][cornerIdx] || { name: '', hx: 1, vy: 1 };
    const cx = size / 2, cy = size / 2, arm = 22;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, size / 2, 0, 2 * Math.PI); ctx.clip();
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(visionSourceImg, corner.x - halfNat, corner.y - halfNat, halfNat * 2, halfNat * 2, 0, 0, size, size);

    // L-shaped bracket oriented to the paper corner this handle represents
    ctx.strokeStyle = 'rgba(59,130,246,0.95)'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + CORNER.hx * arm, cy); ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + CORNER.vy * arm); ctx.stroke();
    // Snap point highlight
    ctx.beginPath(); ctx.arc(cx, cy, 4.5, 0, 2 * Math.PI);
    ctx.fillStyle = '#3b82f6'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.stroke();
    ctx.restore();

    // Corner label pill at the bottom of the bubble
    ctx.save();
    ctx.font = '600 12px Inter, system-ui, sans-serif';
    const label = CORNER.name;
    const tw = ctx.measureText(label).width, pad = 8, ph = 18, py = size - 26;
    ctx.fillStyle = 'rgba(59,130,246,0.92)';
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(cx - tw / 2 - pad, py, tw + pad * 2, ph, 9); ctx.fill(); }
    else ctx.fillRect(cx - tw / 2 - pad, py, tw + pad * 2, ph);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, py + ph / 2);
    ctx.restore();

    // Position bubble near the handle (screen space), clamped to the box
    const scr = imgToScreen(corner);
    let left = scr.x - size / 2;
    let top  = scr.y - size - 18;
    if (top < 0) top = scr.y + 18;
    left = Math.max(0, Math.min(cropView.boxW - size, left));
    top  = Math.max(0, Math.min(cropView.boxH - size, top));
    loupe.style.left = left + 'px';
    loupe.style.top  = top + 'px';
    loupe.style.display = 'block';
}

// Solve the 8-DOF homography mapping dst points -> src points (so src = H·dst).
function _solveHomography(dst, src) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
        const X = dst[i].x, Y = dst[i].y, u = src[i].x, v = src[i].y;
        A.push([X, Y, 1, 0, 0, 0, -X * u, -Y * u]); b.push(u);
        A.push([0, 0, 0, X, Y, 1, -X * v, -Y * v]); b.push(v);
    }
    // Gaussian elimination on the 8×8 system
    for (let c = 0; c < 8; c++) {
        let piv = c;
        for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
        [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
        const d = A[c][c] || 1e-9;
        for (let r = 0; r < 8; r++) {
            if (r === c) continue;
            const f = A[r][c] / d;
            for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
            b[r] -= f * b[c];
        }
    }
    const h = b.map((v, i) => v / (A[i][i] || 1e-9));
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function _applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

// Draw the source image mapped onto a destination triangle via affine transform.
function _drawTexTriangle(ctx, img, s, d) {
    const det = s[0].x * (s[1].y - s[2].y) + s[1].x * (s[2].y - s[0].y) + s[2].x * (s[0].y - s[1].y);
    if (Math.abs(det) < 1e-9) return;
    const id = 1 / det;
    const a = id * (d[0].x * (s[1].y - s[2].y) + d[1].x * (s[2].y - s[0].y) + d[2].x * (s[0].y - s[1].y));
    const b = id * (d[0].y * (s[1].y - s[2].y) + d[1].y * (s[2].y - s[0].y) + d[2].y * (s[0].y - s[1].y));
    const c = id * (d[0].x * (s[2].x - s[1].x) + d[1].x * (s[0].x - s[2].x) + d[2].x * (s[1].x - s[0].x));
    const e = id * (d[0].y * (s[2].x - s[1].x) + d[1].y * (s[0].x - s[2].x) + d[2].y * (s[1].x - s[0].x));
    const f = id * (d[0].x * (s[1].x * s[2].y - s[2].x * s[1].y) + d[1].x * (s[2].x * s[0].y - s[0].x * s[2].y) + d[2].x * (s[0].x * s[1].y - s[1].x * s[0].y));
    const g = id * (d[0].y * (s[1].x * s[2].y - s[2].x * s[1].y) + d[1].y * (s[2].x * s[0].y - s[0].x * s[2].y) + d[2].y * (s[0].x * s[1].y - s[1].x * s[0].y));
    // Inflate the clip triangle slightly outward from its centroid so adjacent
    // triangles overlap by ~0.5px — hides the anti-aliased seams between cells.
    const cx = (d[0].x + d[1].x + d[2].x) / 3, cy = (d[0].y + d[1].y + d[2].y) / 3;
    const grow = 0.6;
    const dd = d.map(p => {
        const vx = p.x - cx, vy = p.y - cy, len = Math.hypot(vx, vy) || 1;
        return { x: p.x + (vx / len) * grow, y: p.y + (vy / len) * grow };
    });
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dd[0].x, dd[0].y); ctx.lineTo(dd[1].x, dd[1].y); ctx.lineTo(dd[2].x, dd[2].y); ctx.closePath();
    ctx.clip();
    ctx.setTransform(a, b, c, e, f, g);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
}

// Crop along the current corners, perspective-flatten to the chosen paper, add to canvas.
// Crop + perspective-flatten the selected quad into an off-screen raster.
// Returns { out:<canvas>, paperW, paperH } in mm, or null on failure.
function flattenCroppedPage() {
    if (!visionSourceImg || !cropCorners) return null;
    const mm = getSelectedPaperMM();
    const [tl, tr, br, bl] = cropCorners;
    const quadW = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2;
    const quadH = (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2;
    const landscape = quadW > quadH;
    const paperW = landscape ? Math.max(mm.w, mm.h) : Math.min(mm.w, mm.h);
    const paperH = landscape ? Math.min(mm.w, mm.h) : Math.max(mm.w, mm.h);

    // Output raster ~12 px/mm (~305 DPI), capped — higher DPI = cleaner vectorization
    const maxPx = Math.min(4200, Math.round(Math.max(paperW, paperH) * 12));
    const outW = Math.round(maxPx * (paperW / Math.max(paperW, paperH)));
    const outH = Math.round(maxPx * (paperH / Math.max(paperW, paperH)));

    const dstRect = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
    const H = _solveHomography(dstRect, [tl, tr, br, bl]);

    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const ctx = out.getContext('2d');

    const N = 32; // finer tessellation → less warp softening
    const grid = [];
    for (let j = 0; j <= N; j++) {
        grid[j] = [];
        for (let i = 0; i <= N; i++) {
            const dx = (i / N) * outW, dy = (j / N) * outH;
            grid[j][i] = { d: { x: dx, y: dy }, s: _applyH(H, dx, dy) };
        }
    }
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i], e = grid[j + 1][i + 1];
            _drawTexTriangle(ctx, visionSourceImg, [a.s, b.s, c.s], [a.d, b.d, c.d]);
            _drawTexTriangle(ctx, visionSourceImg, [b.s, e.s, c.s], [b.d, e.d, c.d]);
        }
    }
    return { out, paperW, paperH };
}

// ── Extract Drawing: vectorize the flattened page, grouped by ink color ──────
let _extractResult = null;
let _extractFlat = null; // { out:<canvas>, paperW, paperH } — flattened page for reference underlay
const OP_OPTIONS = [
    { v: 'thru_cut', label: 'Cut' },
    { v: 'crease',   label: 'Crease' },
    { v: 'off_base', label: 'Off-base' },
    { v: 'draw',     label: 'Draw' },
    { v: 'ignore',   label: 'Ignore' },
];
// Remember the last operation chosen for a given color name (convenience default)
const _lastOpForColor = {};

// Fully automatic: flatten → vectorize → insert every detected color as its own
// selectable layer (original ink color, default 'Draw' operation) + a faint reference
// image, all aligned. Color→operation is reassigned afterwards by selecting a layer.
function runExtractDrawing() {
    if (!canvasEditor) return;
    const pill = document.getElementById('visionCropStatus');
    try {
        if (pill) { pill.textContent = 'Flattening…'; pill.style.color = '#fbbf24'; }
        const res = flattenCroppedPage();
        if (!res) return;
        if (pill) pill.textContent = 'Extracting drawing…';
        setTimeout(() => {
            try {
                _extractFlat = res;
                _extractResult = analyzeDrawing(res.out, res.paperW, res.paperH);
                if (!_extractResult.colors.length) {
                    if (pill) { pill.textContent = 'No distinct ink detected — re-crop tighter or improve lighting.'; pill.style.color = '#ef4444'; }
                    return;
                }
                insertExtracted(_extractResult, _extractFlat);
            } catch (err) {
                console.error('analyzeDrawing:', err);
                if (pill) { pill.textContent = 'Extraction failed.'; pill.style.color = '#ef4444'; }
            }
        }, 30);
    } catch (e) {
        console.error('runExtractDrawing:', e);
        if (pill) { pill.textContent = 'Extraction failed.'; pill.style.color = '#ef4444'; }
    }
}

function insertExtracted(result, flat) {
    // Default every detected color to Draw; the user assigns Cut/Crease per colour
    // afterwards (select the coloured layer → Cut/Score/Fold). Remember last choice.
    const assignments = {};
    result.colors.forEach((col, i) => { assignments[i] = _lastOpForColor[col.name] || 'draw'; });
    const svg = buildSVG(result, assignments);
    canvasEditor.importSVG(svg);
    // faint reference underlay, aligned to the placed page rectangle
    if (flat) {
        const bedW = canvasEditor.view?.bedW || 960, bedH = canvasEditor.view?.bedH || 770;
        const { out, paperW, paperH } = flat;
        const box = canvasEditor._lastImportBox;
        const ref = new Image();
        ref.onload = () => {
            const x = box ? box.x : (bedW - paperW) / 2, y = box ? box.y : (bedH - paperH) / 2;
            const w = box ? box.w : paperW, h = box ? box.h : paperH;
            canvasEditor.addImage(ref, x, y, w, h, { opacity: 0.25, background: true, name: 'Reference (flattened)' });
        };
        ref.src = out.toDataURL('image/png');
    }
    log(`Inserted ${result.colors.length} colour layer${result.colors.length === 1 ? '' : 's'} — select a layer to set Cut / Crease / Draw.`, 'success');
    if (window.switchTab) window.switchTab('draw');
    closeVisionModal();
}

document.getElementById('visionPaperSize')?.addEventListener('change', (e) => {
    document.getElementById('visionCustomSize').style.display = e.target.value === 'custom' ? 'flex' : 'none';
});
document.getElementById('btnVisionExtract')?.addEventListener('click', runExtractDrawing);

// Upload a saved image straight from the PC (same detect → crop → flatten flow)
document.getElementById('btnVisionUpload')?.addEventListener('click', () => {
    document.getElementById('visionUploadInput')?.click();
});
document.getElementById('visionUploadInput')?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const status = document.getElementById('visionStatusText');
    const qrContainer = document.getElementById('visionQrContainer');
    const img = new Image();
    img.onload = async () => {
        if (qrContainer) qrContainer.style.display = 'none';
        log('Image uploaded from PC.', 'success');
        if (status) { status.textContent = 'Detecting page…'; status.style.color = '#fbbf24'; }
        let corners = null;
        try { corners = await detectPageCorners(img); } catch (err) {}
        showVisionPreview(img, corners);
    };
    img.onerror = () => { if (status) { status.textContent = 'Could not read that image file.'; status.style.color = '#ef4444'; } };
    img.src = URL.createObjectURL(file);
});

// Back to the connect (QR / upload) state — used on modal open and "New photo"
function resetVisionToConnect() {
    document.querySelector('.vision-modal')?.classList.remove('cropping');
    const qrContainer = document.getElementById('visionQrContainer');
    if (qrContainer) qrContainer.style.display = 'flex';
    document.getElementById('visionLoupe').style.display = 'none';
    document.getElementById('visionExtractPanel')?.classList.add('hidden');
    _extractResult = null;
    _extractFlat = null;
    const pill = document.getElementById('visionCropStatus');
    if (pill) pill.textContent = '';
    visionSourceImg = null; cropCorners = null; _activeCorner = -1;
    _isPanning = false; cropView.z = 1; cropView.ox = 0; cropView.oy = 0;
}

document.getElementById('btnVisionNewPhoto')?.addEventListener('click', () => {
    resetVisionToConnect();
    // Peer stays alive — the same QR keeps working for another shot
    const status = document.getElementById('visionStatusText');
    if (status && peer && !peer.destroyed) {
        status.textContent = peerConnection && peerConnection.open
            ? 'Phone connected — send another photo, or upload from PC.'
            : 'Waiting for phone connection...';
        status.style.color = '#60a5fa';
    }
});

function initPeerConnection() {
    const statusText = document.getElementById('visionStatusText');
    const qrContainer = document.getElementById('visionQrContainer');
    
    if (!statusText || !qrContainer) return;
    
    statusText.textContent = "Connecting to PeerJS signalling...";
    statusText.style.color = "#fbbf24"; // warning orange/yellow
    
    // Initialize PeerJS
    try {
        peer = new Peer({
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun.cloudflare.com:3478' },
                    // Free TURN relay so a phone on 4G/other network can still connect
                    { urls: 'turn:openrelay.metered.ca:80',
                      username: 'openrelayproject', credential: 'openrelayproject' },
                    { urls: 'turn:openrelay.metered.ca:443',
                      username: 'openrelayproject', credential: 'openrelayproject' },
                    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                      username: 'openrelayproject', credential: 'openrelayproject' }
                ]
            }
        });
        
        peer.on('open', (id) => {
            statusText.textContent = "Waiting for phone connection...";
            statusText.style.color = "#60a5fa"; // blue info
            // Generate QR Code URL
            const mobileUrl = `https://joginfrancis.github.io/photoshare/mobile.html?id=${id}`;
            const encodedUrl = encodeURIComponent(mobileUrl);
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&data=${encodedUrl}`;
            
            qrContainer.innerHTML = `<img src="${qrUrl}" alt="Scan QR Code" style="width:180px; height:180px; display:block; border-radius: 4px;">`;
        });
        
        peer.on('connection', (conn) => {
            peerConnection = conn;
            statusText.textContent = "Phone connected! Ready to receive photo.";
            statusText.style.color = "#10b981"; // success green
            
            let fileMeta = null;
            let chunks = [];
            
            conn.on('data', (data) => {
                if (typeof data === 'string') {
                    try {
                        const msg = JSON.parse(data);
                        if (msg.type === 'meta') {
                            fileMeta = msg;
                            chunks = [];
                            statusText.textContent = `Receiving photo: ${msg.name}...`;
                            statusText.style.color = "#3b82f6"; // primary accent
                        } else if (msg.type === 'done') {
                            statusText.textContent = "Photo received!";
                            statusText.style.color = "#10b981"; // success green
                            // Reassemble chunks and show preview + paper controls
                            const blob = new Blob(chunks, { type: fileMeta.mime || 'image/jpeg' });
                            const img = new Image();
                            img.onload = async () => {
                                if (qrContainer) qrContainer.style.display = 'none';
                                log('Photo received from phone.', 'success');
                                statusText.textContent = 'Detecting page…';
                                statusText.style.color = '#fbbf24';
                                // Accurate detection on the PC (OpenCV GrabCut, off-thread)
                                let corners = null;
                                try { corners = await detectPageCorners(img); } catch (e) {}
                                // Fall back to phone-sent corners, else the cropper's default rectangle
                                if (!corners && Array.isArray(fileMeta?.corners)) corners = fileMeta.corners;
                                showVisionPreview(img, corners);
                            };
                            img.src = URL.createObjectURL(blob);
                        }
                    } catch (e) {
                        console.error('Error handling string connection data:', e);
                    }
                } else {
                    // Binary chunk
                    chunks.push(data);
                    const receivedBytes = chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
                    if (fileMeta && fileMeta.size) {
                        const pct = Math.round((receivedBytes / fileMeta.size) * 100);
                        statusText.textContent = `Receiving: ${pct}%`;
                    } else {
                        statusText.textContent = `Receiving chunk: ${(receivedBytes / 1024).toFixed(1)} KB`;
                    }
                }
            });
            
            conn.on('close', () => {
                statusText.textContent = "Phone disconnected.";
                statusText.style.color = "#ef4444"; // danger red
            });
        });
        
        peer.on('error', (err) => {
            console.error("PeerJS error:", err);
            statusText.textContent = `Error: ${err.type || 'Connection failed'}`;
            statusText.style.color = "#ef4444"; // danger red
        });
    } catch (e) {
        console.error("Failed to initialize PeerJS:", e);
        statusText.textContent = "Error: PeerJS failed to load.";
        statusText.style.color = "#ef4444";
    }
}

document.getElementById('dtVision')?.addEventListener('click', () => {
    if (!visionQrModal) return;

    resetVisionToConnect();
    visionQrModal.classList.remove('hidden');
    setTimeout(() => visionQrModal.classList.add('visible'), 10);

    if (!peer) {
        initPeerConnection();
    }
    getDetectWorker(); // preload OpenCV detector while the user scans/captures
});

// Load G-Code / Trajectory trigger
document.getElementById('dtLoadGCode')?.addEventListener('click', () => {
    document.getElementById('fileInput')?.click();
});

document.getElementById('drawFileInput')?.addEventListener('change', async (e) => {
    if (e.target.files.length === 0) return;
    const file = e.target.files[0];
    if (canvasEditor) {
        const text = await file.text();
        canvasEditor.importSVG(text);
        log('SVG imported into drawing editor.', 'success');
    }
    e.target.value = ''; // Reset
});

// Also re-draw bed bg whenever bed size changes
['bedWidthInput', 'bedHeightInput'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
        if (!document.getElementById('drawPanel')?.classList.contains('hidden')) {
            drawBridge.activate();
        }
    });
});

// Setup the Tab clicking logic (Preview vs Editor vs Draw)
setupTabs(() => state, drawBridge);



// Handle "Open File" button
document.getElementById('fileInput').addEventListener('change', (e) => {
    state.currentFile = e.target.files[0];
    handleFile(state.currentFile, onGCodeReady, window.switchTab);
});

// Helper: compute steps/unit from single input
function getAxisSteps(inputId, fallback) {
    const v = parseFloat(document.getElementById(inputId)?.value);
    return (isNaN(v) || v <= 0) ? fallback : v;
}

const retriggerConversion = () => {
    if (state.gcode && !document.getElementById('canvasContainer').classList.contains('hidden')) {
        renderGCode(state.gcode, 'gcodeCanvas', 'canvasContainer', state.stepsPerMM, -1, state.binaryPackets, null, { x: jogState.posX, y: jogState.posY });
    }
    if (state.gcode) {
        renderGCode(state.gcode, 'setupGcodeCanvas', 'setupGcodeCanvasContainer', state.stepsPerMM, -1, state.binaryPackets, state.suctionZones, { x: jogState.posX, y: jogState.posY });
    }
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

const junctionDeviationSlider = document.getElementById('junctionDeviationSlider');
const junctionDeviationInput = document.getElementById('junctionDeviationInput');

if (junctionDeviationSlider && junctionDeviationInput) {
    junctionDeviationSlider.addEventListener('input', (e) => { junctionDeviationInput.value = e.target.value; });
    junctionDeviationInput.addEventListener('input', (e) => { junctionDeviationSlider.value = e.target.value; });
}

// Watch all config inputs for changes
[
    segmentLengthSlider, segmentLengthInput, cuttingSpeedSlider, cuttingSpeedInput,
    junctionDeviationSlider, junctionDeviationInput,
    'bedWidthInput', 'bedHeightInput', 'gantryWidthInput', 'gantryHeightInput',
    'xRs485Id', 'xStepsPerMM', 'xMaxSpeed', 'xAcceleration',
    'yRs485Id', 'yStepsPerMM', 'yMaxSpeed', 'yAcceleration',
    'zRs485Id', 'zStepsPerMM', 'zMaxSpeed', 'zAcceleration',
    'aRs485Id', 'aStepsPerDeg', 'aMaxSpeed', 'aAcceleration',
].forEach(idOrEl => {
    const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
    if (el) {
        el.addEventListener('change', retriggerConversion);
    }
});

// Watch simulation mode checkbox
const simModeCheckbox = document.getElementById('simModeCheckbox');
if (simModeCheckbox) {
    simModeCheckbox.addEventListener('change', () => {
        updateStatus(connection.connected);
        if (simModeCheckbox.checked && state.gcode) {
            btnStart.disabled = false;
        }
    });
}

// No initial axis labels to update anymore

// Modal Logic
btnSettings.addEventListener('click', () => {
    configModal.classList.remove('hidden');

    // Reset active config tab to default (bed)
    document.querySelectorAll('.config-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.configTab === 'bed'));
    const bedSec = document.getElementById('cfgSectionBed');
    const motSec = document.getElementById('cfgSectionMotion');
    const matSec = document.getElementById('cfgSectionMatrix');
    if (bedSec) bedSec.classList.remove('hidden');
    if (motSec) motSec.classList.add('hidden');
    if (matSec) matSec.classList.add('hidden');

    // small delay to allow display:block to apply before animating opacity
    setTimeout(() => configModal.classList.add('visible'), 10);
});

// Config Modal Sub-tabs logic
document.querySelectorAll('.config-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.config-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const targetTab = btn.dataset.configTab;
        const bedSec = document.getElementById('cfgSectionBed');
        const motSec = document.getElementById('cfgSectionMotion');
        const matSec = document.getElementById('cfgSectionMatrix');
        if (bedSec) bedSec.classList.toggle('hidden', targetTab !== 'bed');
        if (motSec) motSec.classList.toggle('hidden', targetTab !== 'motion');
        if (matSec) matSec.classList.toggle('hidden', targetTab !== 'matrix');
    });
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
    stepLinear: 0.1,    // Current linear step size in mm
    stepRotary: 5,      // Current rotary step size in degrees
    posX: 0,
    posY: 0,
    posZ: 0,
    posA: 0,
};

// Keyboard jogging is bound dynamically inside switchMode()

/** Step-size pill buttons */
document.querySelectorAll('#linearStepBtns .jog-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#linearStepBtns .jog-step-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        jogState.stepLinear = parseFloat(btn.dataset.step);
    });
});
document.querySelectorAll('#rotaryStepBtns .jog-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#rotaryStepBtns .jog-step-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        jogState.stepRotary = parseFloat(btn.dataset.step);
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
    const isSimMode = document.getElementById('simModeCheckbox')?.checked;
    if (!connection.connected && !isSimMode) {
        log('Jog: Not connected to machine.', 'error');
        return;
    }

    // 1. Get current scaling factors from UI
    const xStepsPerMM = getAxisSteps('xStepsPerMM', DEFAULT_STEPS.X);
    const yStepsPerMM = getAxisSteps('yStepsPerMM', DEFAULT_STEPS.Y);
    const zStepsPerMM = getAxisSteps('zStepsPerMM', DEFAULT_STEPS.Z);
    const aStepsPerDeg = getAxisSteps('aStepsPerDeg', DEFAULT_STEPS.A);
    const feedRate = parseFloat(document.getElementById('cuttingSpeedInput')?.value) || 22;

    // 2. Calculate relative steps
    // Note: Z-axis convention is positive for DOWN, so we negate dz (Up is positive)
    const relX = Math.round(dx * xStepsPerMM);
    const relY = Math.round(dy * yStepsPerMM);
    const relZ = Math.round(-dz * zStepsPerMM);
    const relA = Math.round(da * aStepsPerDeg);

    if (relX === 0 && relY === 0 && relZ === 0 && relA === 0) return;

    // 3. Calculate interval for microsegment
    const maxAbsStep = Math.max(Math.abs(relX), Math.abs(relY), Math.abs(relZ), Math.abs(relA));
    let stepsPerUnitOfMaxAxis = 1.0;
    if (maxAbsStep === Math.abs(relX)) stepsPerUnitOfMaxAxis = xStepsPerMM;
    else if (maxAbsStep === Math.abs(relY)) stepsPerUnitOfMaxAxis = yStepsPerMM;
    else if (maxAbsStep === Math.abs(relZ)) stepsPerUnitOfMaxAxis = zStepsPerMM;
    else stepsPerUnitOfMaxAxis = aStepsPerDeg;

    const speed = feedRate * stepsPerUnitOfMaxAxis;
    const interval = Math.max(1, Math.min(Math.round(150_000_000 / speed), 150_000_000));

    const packet = packMicrosegment(relX, relY, relZ, relA, interval, 1, 0);

    if (isSimMode) {
        log(`[SIM JOG] dx:${dx} dy:${dy} dz:${dz} da:${da} (interval:${interval})`, 'info');
        updatePositionFromPacket(packet);
    } else {
        state.activeRunType = 'jog';
        state.isSending = true;
        // Update dead-reckoning position display using exact steps
        updatePositionFromPacket(packet);

        // Jogging should never run the suction bed.
        sendSuctionCommands(false, false);
        updateSuctionUI();

        // Use the robust executeNextTextCommand pipeline without destroying loaded SVGs
        state.jogPackets = [packet];
        state.gcodeQueue = ['enable all 1', 'WAIT_MS:200', '__JOG_BINARY_STREAM__'];

        executeNextTextCommand();
    }
}

// D-pad and Z buttons
document.getElementById('jogXPlus').addEventListener('click', () => sendJog(jogState.stepLinear, 0, 0, 0));
document.getElementById('jogXMinus').addEventListener('click', () => sendJog(-jogState.stepLinear, 0, 0, 0));
document.getElementById('jogYPlus').addEventListener('click', () => sendJog(0, jogState.stepLinear, 0, 0));
document.getElementById('jogYMinus').addEventListener('click', () => sendJog(0, -jogState.stepLinear, 0, 0));
document.getElementById('jogZPlus').addEventListener('click', () => sendJog(0, 0, jogState.stepLinear, 0));
document.getElementById('jogZMinus').addEventListener('click', () => sendJog(0, 0, -jogState.stepLinear, 0));
document.getElementById('jogAPlus').addEventListener('click', () => sendJog(0, 0, 0, jogState.stepRotary));
document.getElementById('jogAMinus').addEventListener('click', () => sendJog(0, 0, 0, -jogState.stepRotary));

/**
 * GO TO ZERO ("Home")
 * This firmware has NO homing cycle — there is no `home` command and no limit
 * switches. Origin is established purely by `setorigin`. So "Home" returns the
 * gantry to (0,0) with a safe Z-retract using binary MicroSegments (the same
 * pattern as park), then issues `setorigin` to zero the Pico's authoritative
 * position counter. Dead-reckoning converges to ~0 as the move is ACKed.
 * (Assessment R2 / fix F2.)
 */
function goToZero() {
    const isSimMode = document.getElementById('simModeCheckbox')?.checked;
    if (!connection.connected && !isSimMode) { log('Home: Not connected.', 'error'); return; }
    if (state.isSending) { log('Home: a move/job is already running.', 'warning'); return; }

    const xStepsPerMM = getAxisSteps('xStepsPerMM', DEFAULT_STEPS.X);
    const yStepsPerMM = getAxisSteps('yStepsPerMM', DEFAULT_STEPS.Y);
    const zStepsPerMM = getAxisSteps('zStepsPerMM', DEFAULT_STEPS.Z);
    const feedRate = parseFloat(document.getElementById('cuttingSpeedInput')?.value) || 22;

    const cmds = [];

    // Step 1: retract Z to a safe height (5 mm above bed) before traversing.
    const zTarget = 5;
    if (jogState.posZ < zTarget) {
        const relZ = Math.round(-(zTarget - jogState.posZ) * zStepsPerMM); // Up = negative Z steps
        if (relZ !== 0) {
            const stepVz = Math.max(1, Math.round(feedRate * zStepsPerMM));
            const interval = Math.max(1, Math.min(Math.round(150_000_000 / stepVz), 150_000_000));
            cmds.push(packMicrosegment(0, 0, relZ, 0, interval, 0x01, 0));
        }
    }

    // Step 2: traverse X/Y back to the origin.
    const relX = Math.round(-jogState.posX * xStepsPerMM);
    const relY = Math.round(-jogState.posY * yStepsPerMM);
    if (relX !== 0 || relY !== 0) {
        const maxAbsStep = Math.max(Math.abs(relX), Math.abs(relY));
        const spu = maxAbsStep === Math.abs(relX) ? xStepsPerMM : yStepsPerMM;
        const interval = Math.max(1, Math.min(Math.round(150_000_000 / (feedRate * spu)), 150_000_000));
        cmds.push(packMicrosegment(relX, relY, 0, 0, interval, 0, 0));
    }

    log('Home: returning to origin (0,0) then re-zeroing position...', 'info');
    state.activeRunType = 'jog';
    state.isSending = true;
    setStartButtonState(true, false);

    // Stream the move (if any) then `setorigin` to re-establish the firmware zero.
    if (cmds.length > 0) {
        state.binaryPackets = cmds;
        state.gcodeQueue = ['__BINARY_STREAM__', 'setorigin'];
    } else {
        state.gcodeQueue = ['setorigin'];
    }
    executeNextTextCommand();
}

// Home button — return to origin (0,0) and re-zero via setorigin.
document.getElementById('jogHome').addEventListener('click', goToZero);

// Reset position display
document.getElementById('jogResetPos').addEventListener('click', () => {
    jogState.posX = 0; jogState.posY = 0; jogState.posZ = 0; jogState.posA = 0;
    document.getElementById('jogPosX').textContent = '0.00';
    document.getElementById('jogPosY').textContent = '0.00';
    document.getElementById('jogPosZ').textContent = '0.00';
    document.getElementById('jogPosA').textContent = '0.00';
});

// Set Origin — declare current head position as machine zero (no movement)
document.getElementById('btnSetOrigin')?.addEventListener('click', () => {
    const isSimMode = document.getElementById('simModeCheckbox')?.checked;
    if (connection.connected) connection.send('setorigin');
    jogState.posX = 0; jogState.posY = 0; jogState.posZ = 0; jogState.posA = 0;
    document.getElementById('jogPosX').textContent = '0.00';
    document.getElementById('jogPosY').textContent = '0.00';
    document.getElementById('jogPosZ').textContent = '0.00';
    document.getElementById('jogPosA').textContent = '0.00';
    log(isSimMode && !connection.connected ? 'Origin set (simulation).' : 'Origin established at current position.', 'success');
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
        'ArrowRight': () => sendJog(jogState.step, 0, 0),
        'ArrowLeft': () => sendJog(-jogState.step, 0, 0),
        'ArrowUp': () => sendJog(0, jogState.step, 0),
        'ArrowDown': () => sendJog(0, -jogState.step, 0),
        'PageUp': () => sendJog(0, 0, jogState.step, 0),
        'PageDown': () => sendJog(0, 0, -jogState.step, 0),
        '[': () => sendJog(0, 0, 0, -jogState.step),
        ']': () => sendJog(0, 0, 0, jogState.step),
        'Home': () => document.getElementById('jogHome').click(),
    };

    if (keyMap[e.key]) {
        e.preventDefault();
        keyMap[e.key]();
    }
}

// ============================================================
//  SUCTION BED CONTROL LOGIC
// ============================================================

/**
 * Recalculates the active zones based on drawn paths or G-code commands.
 * Splits the machine bed (bedW x bedH) into a 2x3 grid.
 *
 * @param {string} gcode - Raw G-code or Trajectory queue text.
 * @param {Uint8Array[]} packets - Binary MicroSegment packets for SVG-driven jobs.
 * @returns {Array<number>} List of active zone IDs (1-6).
 */
function calculateActiveZones(gcode, packets = []) {
    const bedW = parseFloat(document.getElementById('bedWidthInput')?.value) || 960;
    const bedH = parseFloat(document.getElementById('bedHeightInput')?.value) || 770;

    const lines = gcode.split('\n');
    let cur = { x: 0, y: 0 };
    let isPenDown = false;

    const active = new Set();

    const addZone = (x, y) => {
        // Clamp bounds to prevent array index overflow. The machine origin is
        // bottom-right, so +X moves leftward across the bed.
        const cx = Math.max(0, Math.min(bedW - 0.001, x));
        const cy = Math.max(0, Math.min(bedH - 0.001, y));
        const leftBasedX = Math.max(0, Math.min(bedW - 0.001, bedW - cx));

        const col = Math.max(0, Math.min(1, Math.floor(leftBasedX / (bedW / 2)))); // 0 or 1
        const row = Math.max(0, Math.min(2, 2 - Math.floor(cy / (bedH / 3)))); // 0, 1, or 2
        const zoneNum = row * 2 + col + 1; // 1 to 6
        active.add(zoneNum);
    };

    const getAxisSteps = (mId, miId, dId, fallback) => {
        const m = parseFloat(document.getElementById(mId)?.value) || 200;
        const mi = parseFloat(document.getElementById(miId)?.value) || 1;
        const d = parseFloat(document.getElementById(dId)?.value) || 1;
        const v = (m * mi) / d;
        return (isNaN(v) || v <= 0) ? fallback : v;
    };

    const idX = parseInt(document.getElementById('xRs485Id')?.value) || 3;
    const idY = parseInt(document.getElementById('yRs485Id')?.value) || 2;
    const idZ = parseInt(document.getElementById('zRs485Id')?.value) || 1;

    const xStepsPerMM = getAxisSteps('xStepsPerMM', DEFAULT_STEPS.X);
    const yStepsPerMM = getAxisSteps('yStepsPerMM', DEFAULT_STEPS.Y);

    lines.forEach(line => {
        line = line.split(';')[0].trim().toUpperCase();
        if (!line) return;

        if (line.startsWith('MOVE')) {
            const parts = line.split(/[\s,]+/);
            const count = parseInt(parts[1]);
            if (isNaN(count) || parts.length < 2 + count * 2) return;

            let dx = 0, dy = 0, zVal = 0;
            for (let i = 0; i < count; i++) {
                const id = parseInt(parts[2 + i]);
                const steps = parseInt(parts[2 + count + i]);

                if (id === idX) dx = steps / xStepsPerMM;
                else if (id === idY) dy = steps / yStepsPerMM;
                else if (id === idZ) zVal = steps;
            }

            if (zVal > 0) isPenDown = true;
            else if (zVal < 0) isPenDown = false;

            const next = { x: cur.x + dx, y: cur.y + dy };

            if (isPenDown) {
                addZone(cur.x, cur.y);
                addZone(next.x, next.y);
                addZone((cur.x + next.x) / 2, (cur.y + next.y) / 2);
            }
            cur = next;
            return;
        }

        const isMove = line.startsWith('G0') || line.startsWith('G1');
        if (isMove) {
            const xMatch = line.match(/X([-+]?\d*\.?\d+)/);
            const yMatch = line.match(/Y([-+]?\d*\.?\d+)/);

            const next = { ...cur };
            if (xMatch) next.x = parseFloat(xMatch[1]);
            if (yMatch) next.y = parseFloat(yMatch[1]);

            const isCut = line.startsWith('G1');
            if (isCut) {
                addZone(cur.x, cur.y);
                addZone(next.x, next.y);
                addZone((cur.x + next.x) / 2, (cur.y + next.y) / 2);
            }
            cur = next;
        }
    });

    if (packets && packets.length > 0) {
        cur = { x: 0, y: 0 };
        isPenDown = false;

        for (const pkt of packets) {
            if (!(pkt instanceof Uint8Array) || pkt.length < 13) continue;

            const view = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
            if (view.getUint8(0) !== 0xAB) continue;

            const dx = view.getInt32(1, true) / xStepsPerMM;
            const dy = view.getInt32(5, true) / yStepsPerMM;
            const dz = view.getInt32(9, true);

            if (dz > 0) isPenDown = true;
            else if (dz < 0) isPenDown = false;

            const next = { x: cur.x + dx, y: cur.y + dy };

            if (isPenDown && (dx !== 0 || dy !== 0)) {
                addZone(cur.x, cur.y);
                addZone(next.x, next.y);
                addZone((cur.x + next.x) / 2, (cur.y + next.y) / 2);
            }

            cur = next;
        }
    }

    return Array.from(active);
}

function getActiveSuctionZones() {
    return state.suctionMode === 'auto'
        ? state.suctionAutoActiveZones
        : state.suctionZones.map((z, idx) => z ? (idx + 1) : null).filter(z => z !== null);
}

function shouldRunSuction() {
    if (!state.suctionControlEnabled) {
        return false;
    }

    const hasActiveZones = getActiveSuctionZones().length > 0;
    if (!hasActiveZones) return false;

    if (state.activeRunType === 'job') {
        return true;
    }

    if (state.activeRunType === 'jog' || state.activeRunType === 'park') {
        return false;
    }

    return state.suctionMode === 'manual';
}

function buildSuctionCommandSequence(shouldRun) {
    const activeSet = new Set(shouldRun ? getActiveSuctionZones().filter(z => z >= 1 && z <= 6) : []);
    const servoCommands = [];

    for (let zone = 1; zone <= 6; zone++) {
        servoCommands.push(`servo ${zone} ${activeSet.has(zone) ? 1 : 0}`);
    }

    if (activeSet.size > 0) {
        return [...servoCommands, 'suction 1'];
    }
    return ['suction 0', ...servoCommands];
}

function getSuctionSignature(shouldRun) {
    if (!shouldRun) return 'OFF';
    return buildSuctionCommandSequence(true).join('|');
}

function seedManualZonesFromAuto() {
    state.suctionZones = [false, false, false, false, false, false];
    state.suctionAutoActiveZones.forEach(z => {
        if (z >= 1 && z <= 6) state.suctionZones[z - 1] = true;
    });
}

/**
 * Synchronizes the suction panel UI state with the current global controller state.
 */
function updateSuctionUI() {
    const setupAutoBtn = document.getElementById('btnSetupSuctionAuto');
    const setupManualBtn = document.getElementById('btnSetupSuctionManual');
    const activeCountText = document.getElementById('setupVacuumActiveCount');

    const makeOnBtn = document.getElementById('btnSuctionManualOn');
    const makeOffBtn = document.getElementById('btnSuctionManualOff');
    const statusText = document.getElementById('suctionStatusText');
    const fanIcon = document.getElementById('suctionFanIcon');
    const cells = document.querySelectorAll('.suction-cell');

    // Toggle active state classes for Prepare page floating panel
    if (setupAutoBtn && setupManualBtn) {
        setupAutoBtn.classList.toggle('active', state.suctionMode === 'auto');
        setupManualBtn.classList.toggle('active', state.suctionMode === 'manual');
    }

    // Sync active count text
    if (activeCountText) {
        const count = getActiveSuctionZones().length;
        activeCountText.textContent = `${count} Active`;
    }

    // Sync Make page buttons
    if (makeOnBtn && makeOffBtn) {
        makeOnBtn.classList.toggle('active', state.suctionControlEnabled);
        makeOffBtn.classList.toggle('active', !state.suctionControlEnabled);
    }

    // Sync Make page single suction toggle
    const suctionToggle = document.getElementById('btnSuctionToggle');
    if (suctionToggle) {
        suctionToggle.classList.toggle('active', !!state.suctionControlEnabled);
        suctionToggle.dataset.on = state.suctionControlEnabled ? 'true' : 'false';
        suctionToggle.textContent = state.suctionControlEnabled ? 'Suction: On' : 'Suction: Off';
    }

    // Identify active zones based on current mode
    const activeList = getActiveSuctionZones();

    // Sync individual cells in the suction bed grid (3x2 layout)
    cells.forEach(cell => {
        const zoneNum = parseInt(cell.dataset.zone);
        if (activeList.includes(zoneNum)) {
            cell.classList.add('active');
        } else {
            cell.classList.remove('active');
        }
    });

    // Redraw the setup bed canvas to reflect suction zone changes
    if (typeof updateSetupBedVisualizer === 'function') {
        updateSetupBedVisualizer();
    }

    const isRunning = shouldRunSuction();

    // Status text update
    if (statusText) {
        if (isRunning) {
            statusText.textContent = 'ON';
            statusText.className = 'suction-status-active';
        } else {
            statusText.textContent = 'OFF';
            statusText.className = 'suction-status-idle';
        }
    }

    // Fan micro-animation state
    if (fanIcon) {
        if (isRunning) {
            fanIcon.classList.add('spinning');
        } else {
            fanIcon.classList.remove('spinning');
        }
    }

    // Sync on-canvas vacuum toggle button
    const canvasVacBtn = document.getElementById('btnCanvasVacuumToggle');
    if (canvasVacBtn) {
        canvasVacBtn.classList.toggle('on', !!state.suctionControlEnabled);
        const lbl = canvasVacBtn.querySelector('strong');
        if (lbl) lbl.textContent = state.suctionControlEnabled ? 'ON' : 'OFF';
    }

    // Redraw setup canvas if it's currently shown
    const setupCanvas = document.getElementById('setupGcodeCanvas');
    const setupPathImage = document.getElementById('setupPathImage');
    if (setupCanvas && setupPathImage && !setupPathImage.classList.contains('hidden')) {
        renderGCode(state.gcode, 'setupGcodeCanvas', 'setupGcodeCanvasContainer', state.stepsPerMM, -1, state.binaryPackets, state.suctionZones, { x: jogState.posX, y: jogState.posY });
    }
}

/**
 * Formats and transmits current suction status to the connected hardware over WebSerial/Pico.
 */
function sendSuctionCommands(force = false, overrideShouldRun = shouldRunSuction()) {
    if (!connection.connected) return;

    const signature = getSuctionSignature(overrideShouldRun);
    if (!overrideShouldRun && !force && (state.suctionLastSignature === null || state.suctionLastSignature === 'OFF')) {
        return;
    }
    if (!force && signature === state.suctionLastSignature) {
        return;
    }

    for (const cmd of buildSuctionCommandSequence(overrideShouldRun)) {
        connection.send(cmd, true);
    }
    state.suctionLastSignature = signature;
}

/**
 * Initializes and registers event listeners for the suction control UI panel elements.
 */
function initSuctionBed() {
    const autoBtn = document.getElementById('btnSuctionModeAuto');
    const manualBtn = document.getElementById('btnSuctionModeManual');
    const manualOnBtn = document.getElementById('btnSuctionManualOn');
    const manualOffBtn = document.getElementById('btnSuctionManualOff');
    const cells = document.querySelectorAll('.suction-cell');

    if (autoBtn && manualBtn) {
        autoBtn.addEventListener('click', () => {
            state.suctionMode = 'auto';
            updateSuctionUI();
            sendSuctionCommands();
            log('Suction Bed: Switched to Automatic (Drawing-Based) Mode.', 'info');
        });
        manualBtn.addEventListener('click', () => {
            state.suctionMode = 'manual';
            seedManualZonesFromAuto();
            updateSuctionUI();
            sendSuctionCommands();
            log('Suction Bed: Switched to Manual Override Mode.', 'info');
        });
    }

    if (manualOnBtn && manualOffBtn) {
        manualOnBtn.addEventListener('click', () => {
            state.suctionControlEnabled = true;
            updateSuctionUI();
            sendSuctionCommands();
            log('Suction Bed Control: Enabled.', 'info');
        });

        manualOffBtn.addEventListener('click', () => {
            state.suctionControlEnabled = false;
            updateSuctionUI();
            sendSuctionCommands(true, false);
            log('Suction Bed Control: Disabled.', 'info');
        });
    }

    cells.forEach(cell => {
        cell.addEventListener('click', () => {
            const zoneNum = parseInt(cell.dataset.zone);
            if (isNaN(zoneNum) || zoneNum < 1 || zoneNum > 6) return;

            if (state.suctionMode === 'auto') {
                state.suctionMode = 'manual';
                // Clone calculated zones to manual array for clean starting point override
                seedManualZonesFromAuto();
                log('Suction Bed: Clicking cell switched system to Manual override.', 'info');
            }

            state.suctionZones[zoneNum - 1] = !state.suctionZones[zoneNum - 1];
            updateSuctionUI();
            sendSuctionCommands();
        });
    });

    // Master vacuum toggle — shared handler for the on-canvas (Prepare) and
    // the Machine Controls (Make) toggle buttons.
    const toggleVacuum = () => {
        state.suctionControlEnabled = !state.suctionControlEnabled;
        updateSuctionUI();
        sendSuctionCommands(true, state.suctionControlEnabled);
        log(`Vacuum ${state.suctionControlEnabled ? 'enabled' : 'disabled'}.`, 'info');
    };
    document.getElementById('btnCanvasVacuumToggle')?.addEventListener('click', toggleVacuum);
    document.getElementById('btnSuctionToggle')?.addEventListener('click', toggleVacuum);

    // Run the initial UI sync
    updateSuctionUI();
}

// Kickstart the suction bed subsystem
initSuctionBed();


// ============================================================================
//  V2 REDESIGN FRONTEND WIRING & HELPERS
// ============================================================================

// 1. Draggable Floating Panels (Jog Panel)
function makeElementDraggable(elmnt, header) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    if (header) {
        header.onmousedown = dragMouseDown;
    } else {
        elmnt.onmousedown = dragMouseDown;
    }

    function dragMouseDown(e) {
        e = e || window.event;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT' || e.target.closest('.jog-step-btns')) {
            return;
        }
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
        e = e || window.event;
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
        elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
        elmnt.style.right = 'auto'; // Disable right-anchor once dragged
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
    }
}

// makeElementDraggable on floating jog modal removed

// 2. Mode Switching Logic (Prepare, Setup, Run)
function updateSetupCoordinates() {
    // Coordinates display is removed from Prepare tab sidebar
}

function updateSetupBedVisualizer() {
    const setupCanvas = document.getElementById('setupGcodeCanvas');
    if (!setupCanvas) return;
    renderGCode(state.gcode, 'setupGcodeCanvas', 'setupGcodeCanvasContainer', state.stepsPerMM, -1, state.binaryPackets, state.suctionZones, { x: jogState.posX, y: jogState.posY });
}

function switchMode(mode) {
    // Unbind keyboard jogging by default
    window.removeEventListener('keydown', handleJogKey);

    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const prepare = document.getElementById('prepareWorkspace');
    const setup = document.getElementById('setupWorkspace');
    const run = document.getElementById('runWorkspace');
    const inspector = document.getElementById('propertiesInspector');

    prepare.classList.add('hidden');
    setup.classList.add('hidden');
    run.classList.add('hidden');

    const canvasContainer = document.getElementById('canvasContainer');

    if (mode === 'prepare') {
        prepare.classList.remove('hidden');
        if (inspector) inspector.style.display = 'flex';
        
        const gcodePreview = document.getElementById('gcodePreview');
        if (gcodePreview && canvasContainer) {
            gcodePreview.appendChild(canvasContainer);
        }
        
        const activeTabBtn = document.querySelector('.sub-tabs .tab.active');
        if (activeTabBtn) {
            const tabText = activeTabBtn.textContent.toLowerCase();
            if (tabText.includes('draw')) window.switchTab('draw');
            else if (tabText.includes('svg') || tabText.includes('raw') || tabText.includes('editor')) window.switchTab('editor');
        } else {
            window.switchTab('draw');
        }
    } else if (mode === 'setup') {
        setup.classList.remove('hidden');
        if (inspector) inspector.style.display = 'none';
        
        updateSetupCoordinates();
        updateSetupBedVisualizer();
    } else if (mode === 'run') {
        run.classList.remove('hidden');
        if (inspector) inspector.style.display = 'none';
        
        const runCanvasWrapper = document.getElementById('runCanvasWrapper');
        if (runCanvasWrapper && canvasContainer) {
            runCanvasWrapper.appendChild(canvasContainer);
            canvasContainer.classList.remove('hidden');
        }
        
        setTimeout(updateViewer, 50);

        // Bind keyboard jogging dynamically when in Make mode
        window.addEventListener('keydown', handleJogKey);
    }
}
window.switchMode = switchMode;

document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        switchMode(btn.dataset.mode);
    });
});

// Prepare page sub-tabs routing
window.switchSetupTab = function(tabName) {
    document.querySelectorAll('.setup-sub-tabs .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.setup-view-panel').forEach(p => p.classList.add('hidden'));

    if (tabName === 'image') {
        document.getElementById('tabSetupImage')?.classList.add('active');
        document.getElementById('setupPathImage')?.classList.remove('hidden');
        setTimeout(updateSetupBedVisualizer, 20);
    } else {
        document.getElementById('tabSetupInstructions')?.classList.add('active');
        document.getElementById('setupPathInstructions')?.classList.remove('hidden');
        // Update the textarea value with current G-code instructions
        const area = document.getElementById('setupInstructionsText');
        if (area) {
            area.value = state.gcode + (state.binaryPackets.length > 0
                ? `\n; [${state.binaryPackets.length} binary MicroSegment packets ready]` : '');
        }
    }
};

// Clipboard copy listener for G-code instructions
document.getElementById('btnCopySetupInstructions')?.addEventListener('click', () => {
    const area = document.getElementById('setupInstructionsText');
    if (area && area.value) {
        navigator.clipboard.writeText(area.value)
            .then(() => {
                const btn = document.getElementById('btnCopySetupInstructions');
                const origHtml = btn.innerHTML;
                btn.innerHTML = 'Copied!';
                setTimeout(() => btn.innerHTML = origHtml, 1500);
            })
            .catch(err => console.error('Could not copy G-code: ', err));
    }
});



// 5. Visual Bed Interactive Clicks on Canvas
function mapCanvasToMachine(mouseX, mouseY, canvas, bedW, bedH) {
    const padding = 40;
    const availableW = canvas.width - padding * 2;
    const availableH = canvas.height - padding * 2;
    const scale = Math.min(availableW / bedW, availableH / bedH);

    const centerX = bedW / 2;
    const centerY = bedH / 2;
    const canvasCenterX = canvas.width / 2;
    const canvasCenterY = canvas.height / 2;

    const x = centerX - (mouseX - canvasCenterX) / scale;
    const y = centerY - (mouseY - canvasCenterY) / scale;
    return { x, y };
}

const setupCanvasEl = document.getElementById('setupGcodeCanvas');
if (setupCanvasEl) {
    setupCanvasEl.addEventListener('click', (e) => {
        // Only allow clicking to toggle zones if tab is setupPathImage
        const setupPathImage = document.getElementById('setupPathImage');
        if (setupPathImage && setupPathImage.classList.contains('hidden')) return;

        const rect = setupCanvasEl.getBoundingClientRect();
        const mouseX = (e.clientX - rect.left) * (setupCanvasEl.width / rect.width);
        const mouseY = (e.clientY - rect.top) * (setupCanvasEl.height / rect.height);

        const bedW = parseFloat(document.getElementById('bedWidthInput')?.value) || 960;
        const bedH = parseFloat(document.getElementById('bedHeightInput')?.value) || 770;

        const pos = mapCanvasToMachine(mouseX, mouseY, setupCanvasEl, bedW, bedH);
        
        if (pos.x >= 0 && pos.x <= bedW && pos.y >= 0 && pos.y <= bedH) {
            // Find which zone is clicked (3 rows, 2 columns)
            const r = 2 - Math.floor(pos.y / (bedH / 3));
            const c = pos.x < bedW / 2 ? 1 : 0;
            const zoneNum = r * 2 + c + 1;

            if (zoneNum >= 1 && zoneNum <= 6) {
                if (state.suctionMode === 'auto') {
                    state.suctionMode = 'manual';
                    seedManualZonesFromAuto();
                    log('Suction Bed: Clicking visual bed zone switched system to Manual override.', 'info');
                }

                state.suctionZones[zoneNum - 1] = !state.suctionZones[zoneNum - 1];
                updateSuctionUI();
                sendSuctionCommands();
            }
        }
    });
}

// Wire up new Prepare tab floating vacuum controls
document.getElementById('btnSetupSuctionAuto')?.addEventListener('click', () => {
    state.suctionMode = 'auto';
    updateSuctionUI();
    sendSuctionCommands();
});

document.getElementById('btnSetupSuctionManual')?.addEventListener('click', () => {
    state.suctionMode = 'manual';
    seedManualZonesFromAuto();
    updateSuctionUI();
    sendSuctionCommands();
});

document.getElementById('btnSetupSuctionClear')?.addEventListener('click', () => {
    state.suctionMode = 'manual';
    state.suctionZones = [false, false, false, false, false, false];
    updateSuctionUI();
    sendSuctionCommands();
});

// 6. Context-Sensitive Properties Inspector
function updatePropertiesInspector() {
    const inspectorContextDraw = document.getElementById('inspectorContextDraw');
    const inspectorContextGlobal = document.getElementById('inspectorContextGlobal');
    const inspectorTitle = document.getElementById('inspectorTitle');
    const inspectorPanel = document.getElementById('propertiesInspector');
    
    if (!canvasEditor) return;
    
    const hasSelection = canvasEditor._sel && canvasEditor._sel.length > 0;
    
    if (hasSelection) {
        if (inspectorPanel) inspectorPanel.classList.remove('collapsed');
        if (inspectorContextGlobal) inspectorContextGlobal.classList.add('hidden');
        if (inspectorContextDraw) inspectorContextDraw.classList.remove('hidden');
        if (inspectorTitle) inspectorTitle.textContent = "Shape Properties";
        
        const selectedShape = canvasEditor.shapes.find(s => s.id === canvasEditor._sel[0]);
        if (selectedShape) {
            const objType = document.getElementById('inspectorObjectType');
            if (objType) {
                let displayType = selectedShape.type;
                displayType = displayType.charAt(0).toUpperCase() + displayType.slice(1);
                objType.textContent = displayType;
            }
            
            const strokeInput = document.getElementById('drawStrokeWidth');
            if (strokeInput) {
                strokeInput.value = selectedShape.strokeWidth || 1.5;
            }
            
            const method = selectedShape.method || 'thru_cut';
            document.querySelectorAll('.method-toggle-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.value === method);
            });

            // Bounding-box size chip (mm)
            const sizeChip = document.getElementById('inspectorSizeChip');
            if (sizeChip && canvasEditor.getSelectionBounds) {
                const b = canvasEditor.getSelectionBounds();
                sizeChip.textContent = b ? `${b.w.toFixed(1)} × ${b.h.toFixed(1)} mm` : '— × — mm';
            }
        }
    } else {
        if (inspectorPanel) inspectorPanel.classList.add('collapsed');
        if (inspectorContextDraw) inspectorContextDraw.classList.add('hidden');
        if (inspectorContextGlobal) inspectorContextGlobal.classList.remove('hidden');
        if (inspectorTitle) inspectorTitle.textContent = "Global Settings";
    }
}

if (drawCanvasEl) {
    drawCanvasEl.addEventListener('mouseup', () => {
        setTimeout(updatePropertiesInspector, 20);
    });
}

// 7. Execution Progress & ETA calculation
function updateExecutionProgress() {
    const total = state.pendingPackets ? state.pendingPackets.length : 0;
    const current = state.base || 0;
    
    const segmentsLabel = document.getElementById('runSegmentsLabel');
    const progressBar = document.getElementById('runProgressBar');
    const etaLabel = document.getElementById('runETALabel');
    const statusLabel = document.getElementById('runStatusLabel');
    
    if (segmentsLabel) {
        segmentsLabel.textContent = `${current} / ${total} segments`;
    }
    
    const pct = total > 0 ? (current / total) * 100 : 0;
    if (progressBar) {
        progressBar.style.width = `${pct}%`;
    }
    
    if (statusLabel) {
        if (state.isPaused) {
            statusLabel.textContent = "PAUSED";
            statusLabel.className = "status-tag tag-paused";
        } else if (state.isSending) {
            statusLabel.textContent = "RUNNING";
            statusLabel.className = "status-tag tag-cutting";
        } else {
            statusLabel.textContent = "IDLE";
            statusLabel.className = "status-tag tag-idle";
        }
    }
    
    let etaText = "Time remaining: --:--";
    if (etaLabel) {
        if (state.isSending && total > 0 && current < total) {
            const segmentLen = parseFloat(document.getElementById('segmentLengthInput')?.value) || 1.0;
            const speed = parseFloat(document.getElementById('cuttingSpeedInput')?.value) || 22; // mm/s
            const remainingDist = (total - current) * segmentLen;
            const remainingSecs = speed > 0 ? remainingDist / speed : 0;
            
            const mins = Math.floor(remainingSecs / 60);
            const secs = Math.floor(remainingSecs % 60);
            const formattedMins = mins.toString().padStart(2, '0');
            const formattedSecs = secs.toString().padStart(2, '0');
            
            etaText = `Time remaining: ${formattedMins}:${formattedSecs}`;
            etaLabel.textContent = etaText;
        } else {
            etaLabel.textContent = "Time remaining: --:--";
        }
    }

    // Sync to HUD overlays
    const hudStatus = document.getElementById('hudProgressStatus');
    const hudPercent = document.getElementById('hudProgressPercent');
    const hudBarInner = document.getElementById('hudProgressBarInner');
    const hudEta = document.getElementById('hudProgressEta');
    const hudSegments = document.getElementById('hudProgressSegments');

    if (hudStatus && statusLabel) {
        hudStatus.textContent = statusLabel.textContent;
        hudStatus.className = `hud-progress-status ${state.isPaused ? 'status-paused' : (state.isSending ? 'status-running' : 'status-idle')}`;
    }
    if (hudPercent) {
        hudPercent.textContent = `${Math.round(pct)}%`;
    }
    if (hudBarInner) {
        hudBarInner.style.width = `${pct}%`;
    }
    if (hudEta) {
        hudEta.textContent = etaText;
    }
    if (hudSegments && segmentsLabel) {
        hudSegments.textContent = segmentsLabel.textContent;
    }
}

// Intercept stroke width change to update selected shapes in properties inspector
const drawStrokeWidthInput = document.getElementById('drawStrokeWidth');
if (drawStrokeWidthInput) {
    drawStrokeWidthInput.addEventListener('input', () => {
        const val = parseFloat(drawStrokeWidthInput.value) || 1.5;
        if (canvasEditor && canvasEditor._sel && canvasEditor._sel.length > 0) {
            canvasEditor.shapes.forEach(s => {
                if (canvasEditor._sel.includes(s.id)) {
                    s.strokeWidth = val;
                }
            });
            canvasEditor.draw();
        }
    });
}

// --- Layout Resizers ---
const resizerRight = document.getElementById('resizerRight');
const runGridLayout = document.getElementById('runGridLayout');

let isResizingRight = false;

if (resizerRight && runGridLayout) {
    resizerRight.addEventListener('mousedown', (e) => {
        isResizingRight = true;
        document.body.style.cursor = 'col-resize';
        resizerRight.classList.add('resizing');
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizingRight) return;
        
        // Disable text selection while dragging
        e.preventDefault();
        
        const containerRect = runGridLayout.getBoundingClientRect();
        
        // Calculate new width for the right panel
        let newWidth = containerRect.right - e.clientX;
        // Constrain width
        if (newWidth < 240) newWidth = 240;
        if (newWidth > 600) newWidth = 600;
        
        runGridLayout.style.gridTemplateColumns = `1fr 4px ${newWidth}px`;
        
        // Re-render canvas
        requestAnimationFrame(updateViewer);
    });

    document.addEventListener('mouseup', () => {
        if (isResizingRight) {
            isResizingRight = false;
            document.body.style.cursor = '';
            resizerRight.classList.remove('resizing');
        }
    });
}

// --- Sidebar Tab Switcher ---
document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        // Toggle active tab class
        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        // Hide all panels
        document.querySelectorAll('.sidebar-content-panel').forEach(panel => {
            panel.classList.add('hidden');
        });

        // Show selected panel
        const targetPanel = tab.dataset.panel;
        if (targetPanel === 'run') {
            document.getElementById('sidebarPanelControl')?.classList.remove('hidden');
        } else if (targetPanel === 'position') {
            document.getElementById('sidebarPanelJog')?.classList.remove('hidden');
        } else if (targetPanel === 'console') {
            document.getElementById('sidebarPanelTerminal')?.classList.remove('hidden');
        }
    });
});

// --- Virtual Joystick Controller ---
function initJoystick() {
    const boundary = document.getElementById('joystickBoundary');
    const knob = document.getElementById('joystickKnob');
    if (!boundary || !knob) return;

    let isDragging = false;
    let dragInterval = null;
    let currentX = 0; // relative to center
    let currentY = 0; // relative to center

    const maxRadius = 36; // px limit
    const deadzone = 12; // px

    function handleStart(e) {
        isDragging = true;
        boundary.style.cursor = 'grabbing';
        updatePosition(e);
        
        // Start the repeating jog loop
        if (!dragInterval) {
            dragInterval = setInterval(() => {
                if (!isDragging) return;
                const dist = Math.sqrt(currentX * currentX + currentY * currentY);
                if (dist > deadzone) {
                    const angle = Math.atan2(-currentY, currentX); // Y is inverted in screen coords
                    const deg = (angle * 180) / Math.PI;
                    const normDeg = (deg + 360) % 360;
                    
                    let stepX = 0;
                    let stepY = 0;
                    if (normDeg >= 337.5 || normDeg < 22.5) {
                        stepX = 1; stepY = 0; // X+
                    } else if (normDeg >= 22.5 && normDeg < 67.5) {
                        stepX = 1; stepY = 1; // X+, Y+
                    } else if (normDeg >= 67.5 && normDeg < 112.5) {
                        stepX = 0; stepY = 1; // Y+
                    } else if (normDeg >= 112.5 && normDeg < 157.5) {
                        stepX = -1; stepY = 1; // X-, Y+
                    } else if (normDeg >= 157.5 && normDeg < 202.5) {
                        stepX = -1; stepY = 0; // X-
                    } else if (normDeg >= 202.5 && normDeg < 247.5) {
                        stepX = -1; stepY = -1; // X-, Y-
                    } else if (normDeg >= 247.5 && normDeg < 292.5) {
                        stepX = 0; stepY = -1; // Y-
                    } else if (normDeg >= 292.5 && normDeg < 337.5) {
                        stepX = 1; stepY = -1; // X+, Y-
                    }
                    
                    // Call the main controller's sendJog method
                    sendJog(stepX * jogState.stepLinear, stepY * jogState.stepLinear, 0, 0);
                }
            }, 150);
        }
    }

    function updatePosition(e) {
        if (!isDragging) return;
        const rect = boundary.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        let clientX, clientY;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        let dx = clientX - centerX;
        let dy = clientY - centerY;

        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > maxRadius) {
            dx = (dx / dist) * maxRadius;
            dy = (dy / dist) * maxRadius;
        }

        currentX = dx;
        currentY = dy;

        knob.style.transform = `translate(${dx}px, ${dy}px)`;
    }

    function handleEnd() {
        if (!isDragging) return;
        isDragging = false;
        boundary.style.cursor = 'grab';
        currentX = 0;
        currentY = 0;
        knob.style.transform = 'translate(0px, 0px)';
        if (dragInterval) {
            clearInterval(dragInterval);
            dragInterval = null;
        }
    }

    boundary.addEventListener('mousedown', handleStart);
    boundary.addEventListener('touchstart', handleStart, { passive: true });

    document.addEventListener('mousemove', updatePosition);
    document.addEventListener('touchmove', updatePosition, { passive: false });

    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchend', handleEnd);
}

// Initialize joystick
initJoystick();

// Make right-column resizer — drag the divider to resize Job vs Terminal panes
(function initSidebarResizer() {
    const resizer = document.getElementById('sidebarResizer');
    const jobPane = document.getElementById('jobPane');
    if (!resizer || !jobPane) return;
    let dragging = false, startY = 0, startH = 0;

    const onMove = (e) => {
        if (!dragging) return;
        const panel = jobPane.parentElement;
        const dy = e.clientY - startY;
        const max = Math.max(90, panel.clientHeight - 160); // leave room for terminal
        const h = Math.max(90, Math.min(startH + dy, max));
        jobPane.style.flex = '0 0 auto';
        jobPane.style.height = h + 'px';
    };
    const stop = () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
    };
    resizer.addEventListener('mousedown', (e) => {
        dragging = true;
        startY = e.clientY;
        startH = jobPane.getBoundingClientRect().height;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'row-resize';
        e.preventDefault();
    });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
})();

// Initial mode switch to Prepare
window.switchMode('prepare');
