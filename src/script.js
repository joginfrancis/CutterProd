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
import { CanvasEditor } from './CanvasEditor.js?v=4';
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
    renderGCode(state.gcode, 'gcodeCanvas', 'canvasContainer', state.stepsPerMM, state.simulatedPathIndex, state.binaryPackets);
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

    document.getElementById('jogPosX').textContent = jogState.posX.toFixed(2);
    document.getElementById('jogPosY').textContent = jogState.posY.toFixed(2);
    document.getElementById('jogPosZ').textContent = jogState.posZ.toFixed(2);
    document.getElementById('jogPosA').textContent = jogState.posA.toFixed(2);
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

// Gantry Parking Control UI Bindings
const parkXInput = document.getElementById('parkXInput');
const parkYInput = document.getElementById('parkYInput');
const parkModeCheckbox = document.getElementById('parkModeCheckbox');
const parkStatusText = document.getElementById('parkStatusText');
const btnSetParkCurrent = document.getElementById('btnSetParkCurrent');
const btnParkNow = document.getElementById('btnParkNow');

if (parkXInput && parkYInput && parkModeCheckbox) {
    // Initialize fields with values from state
    parkXInput.value = state.parkX;
    parkYInput.value = state.parkY;
    parkModeCheckbox.checked = state.parkEnabled;
    if (parkStatusText) {
        parkStatusText.textContent = state.parkEnabled ? 'ON' : 'OFF';
    }

    parkXInput.addEventListener('change', () => {
        state.parkX = parseFloat(parkXInput.value) || 0;
        localStorage.setItem('parkX', state.parkX);
        log(`Park position X updated to ${state.parkX} mm`, 'info');
    });

    parkYInput.addEventListener('change', () => {
        state.parkY = parseFloat(parkYInput.value) || 0;
        localStorage.setItem('parkY', state.parkY);
        log(`Park position Y updated to ${state.parkY} mm`, 'info');
    });

    parkModeCheckbox.addEventListener('change', () => {
        state.parkEnabled = parkModeCheckbox.checked;
        localStorage.setItem('parkEnabled', state.parkEnabled);
        if (parkStatusText) {
            parkStatusText.textContent = state.parkEnabled ? 'ON' : 'OFF';
        }
        log(`Park Mode ${state.parkEnabled ? 'Enabled' : 'Disabled'}`, 'success');
    });
}

if (btnSetParkCurrent) {
    btnSetParkCurrent.addEventListener('click', () => {
        state.parkX = Math.round(jogState.posX * 100) / 100;
        state.parkY = Math.round(jogState.posY * 100) / 100;

        if (parkXInput) parkXInput.value = state.parkX;
        if (parkYInput) parkYInput.value = state.parkY;

        localStorage.setItem('parkX', state.parkX);
        localStorage.setItem('parkY', state.parkY);

        log(`Set park position to current coordinates: X=${state.parkX}, Y=${state.parkY}`, 'success');
    });
}

if (btnParkNow) {
    btnParkNow.addEventListener('click', () => {
        parkNow();
    });
}

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
            connection.send('disable all', true);
            btnToggleMotors.dataset.enabled = 'false';
            btnToggleMotors.textContent = 'Enable Motors';
        } else {
            connection.send('enable all', true);
            btnToggleMotors.dataset.enabled = 'true';
            btnToggleMotors.textContent = 'Disable Motors';
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

// 3. Reconnect on Badge Click or Connect Button
// If user clicks the "Disconnected" red badge, try to reconnect.
document.getElementById('statusBadge').addEventListener('click', () => {
    state.suctionLastSignature = null;
    connection.connect();
});
document.getElementById('btnConnect').addEventListener('click', () => {
    if (connection.connected) {
        state.suctionLastSignature = null;
        connection.disconnect();
    } else {
        state.suctionLastSignature = null;
        connection.connect();
    }
});

// 4. Sync Editor changes
// When user types in the editor, update our global variable so the preview knows.
editor.addEventListener('input', () => {
    state.gcode = editor.value;
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

// Send to Cutter – export drawn shapes as SVG and push through handleFile
document.getElementById('btnDrawSend')?.addEventListener('click', () => {
    if (!canvasEditor || !canvasEditor.hasShapes) {
        log('No drawn shapes to send.', 'error');
        return;
    }
    const svgText = canvasEditor.exportAsSVG();
    const virtualFile = new File([svgText], 'canvas_drawing.svg', { type: 'image/svg+xml' });
    log('Converting drawn shapes to trajectory...', 'info');
    handleFile(virtualFile, onGCodeReady, window.switchTab);
});

// Import SVG to CanvasEditor
document.getElementById('btnDrawImport')?.addEventListener('click', () => {
    document.getElementById('drawFileInput')?.click();
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

// --- Real-time UrumiCam SVG Push Listener ---
function setupUrumiCamPushListener() {
    const serverUrl = "http://localhost:5000";

    // Dynamic Socket.IO client library loader
    function loadSocketIO() {
        return new Promise((resolve) => {
            if (window.io) return resolve(window.io);
            const script = document.createElement('script');
            script.src = `${serverUrl}/socket.io/socket.io.js`;
            script.onload = () => resolve(window.io);
            script.onerror = () => {
                // Fallback CDN
                const fallback = document.createElement('script');
                fallback.src = "https://cdn.socket.io/4.7.2/socket.io.min.js";
                fallback.onload = () => resolve(window.io);
                fallback.onerror = () => console.log("[UrumiCam Bridge] Socket.IO failed to load.");
                document.head.appendChild(fallback);
            };
            document.head.appendChild(script);
        });
    }

    loadSocketIO().then((io) => {
        if (!io) return;
        const socket = io(serverUrl, { reconnection: true });

        socket.on('connect', () => {
            console.log("[UrumiCam Bridge] Connected to UrumiCam background listener.");
        });

        socket.on('import_svg_in_cutter', async (data) => {
            log("[UrumiCam Bridge] Received real-time push from UrumiCam! Tracing skeleton...", "info");

            try {
                if (data && data.error) throw new Error(data.error);

                // Fetch both the true binary mask and the rectified color bed photo
                const maskUrl = `${serverUrl}/uploads/rectified_mask.png?t=${Date.now()}`;
                const colorUrl = `${serverUrl}/uploads/rectified_bed.png?t=${Date.now()}`;

                const maskImg = new Image();
                maskImg.crossOrigin = "Anonymous";

                const colorImg = new Image();
                colorImg.crossOrigin = "Anonymous";

                const loadMaskPromise = new Promise((resolve, reject) => {
                    maskImg.onload = resolve;
                    maskImg.onerror = () => reject(new Error("Failed to load rectified_mask.png"));
                    maskImg.src = maskUrl;
                });

                const loadColorPromise = new Promise((resolve, reject) => {
                    colorImg.onload = resolve;
                    colorImg.onerror = () => reject(new Error("Failed to load rectified_bed.png"));
                    colorImg.src = colorUrl;
                });

                await Promise.all([loadMaskPromise, loadColorPromise]);

                if (!window.TraceSkeleton) {
                    throw new Error("TraceSkeleton library not loaded");
                }

                // Draw mask to offscreen canvas to get ImageData
                const maskCanvas = document.createElement('canvas');
                maskCanvas.width = maskImg.width;
                maskCanvas.height = maskImg.height;
                const maskCtx = maskCanvas.getContext('2d');
                maskCtx.drawImage(maskImg, 0, 0);
                const maskData = maskCtx.getImageData(0, 0, maskImg.width, maskImg.height);

                // Draw color image to offscreen canvas to get ImageData
                const colorCanvas = document.createElement('canvas');
                colorCanvas.width = colorImg.width;
                colorCanvas.height = colorImg.height;
                const colorCtx = colorCanvas.getContext('2d');
                colorCtx.drawImage(colorImg, 0, 0);
                const colorData = colorCtx.getImageData(0, 0, colorImg.width, colorImg.height);

                // Tracing algorithm expects a flat binary array
                const o = maskData.data;
                const a = new Array(maskImg.width * maskImg.height);
                for (let i = 0, j = 0; i < o.length; i += 4, j++) {
                    a[j] = o[i] > 127 ? 1 : 0;
                }

                // trace(data, width, height, chunk_size)
                const result = window.TraceSkeleton.trace(a, maskImg.width, maskImg.height, 3);

                // Helpers for color classification
                function rgbToHsl(r, g, b) {
                    r /= 255; g /= 255; b /= 255;
                    const max = Math.max(r, g, b), min = Math.min(r, g, b);
                    let h, s, l = (max + min) / 2;

                    if (max === min) {
                        h = s = 0;
                    } else {
                        const d = max - min;
                        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                        switch (max) {
                            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                            case g: h = (b - r) / d + 2; break;
                            case b: h = (r - g) / d + 4; break;
                        }
                        h /= 6;
                    }
                    return { h: h * 360, s, l };
                }

                function getNeighborhoodInkColor(cData, x, y) {
                    let minL = 1.1;
                    let bestRgb = { r: 255, g: 255, b: 255 };
                    const rx = Math.round(x);
                    const ry = Math.round(y);

                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            const px = Math.max(0, Math.min(cData.width - 1, rx + dx));
                            const py = Math.max(0, Math.min(cData.height - 1, ry + dy));
                            const idx = (py * cData.width + px) * 4;
                            const r = cData.data[idx];
                            const g = cData.data[idx + 1];
                            const b = cData.data[idx + 2];

                            const maxVal = Math.max(r, g, b) / 255;
                            const minVal = Math.min(r, g, b) / 255;
                            const l = (maxVal + minVal) / 2;

                            if (l < minL) {
                                minL = l;
                                bestRgb = { r, g, b };
                            }
                        }
                    }
                    return bestRgb;
                }

                function classifyHsl(h, s, l) {
                    if (s < 0.12) {
                        return "neutral"; // black, grey, white
                    }
                    if (h >= 335 || h < 25) {
                        return "red";
                    }
                    if (h >= 75 && h < 160) {
                        return "green";
                    }
                    if (h >= 170 && h < 265) {
                        return "blue";
                    }
                    return "unknown";
                }

                function dist(a, b) {
                    return Math.hypot(b.x - a.x, b.y - a.y);
                }

                function formatSvgNum(value) {
                    return Number(value.toFixed(2));
                }

                function toPointList(poly) {
                    return poly.map(([x, y]) => ({ x, y }));
                }

                function dedupePolyline(points, minSegmentLength = 1.25) {
                    if (points.length <= 1) return points.slice();
                    const filtered = [points[0]];
                    for (let i = 1; i < points.length; i++) {
                        if (dist(filtered[filtered.length - 1], points[i]) >= minSegmentLength) {
                            filtered.push(points[i]);
                        }
                    }
                    if (filtered.length === 1 && points.length > 1) {
                        filtered.push(points[points.length - 1]);
                    }
                    return filtered;
                }

                function pointToSegmentDistance(point, start, end) {
                    const dx = end.x - start.x;
                    const dy = end.y - start.y;
                    if (dx === 0 && dy === 0) {
                        return dist(point, start);
                    }
                    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
                    const proj = { x: start.x + t * dx, y: start.y + t * dy };
                    return dist(point, proj);
                }

                function simplifyRdp(points, epsilon) {
                    if (points.length <= 2) return points.slice();

                    let maxDistance = 0;
                    let index = -1;
                    const start = points[0];
                    const end = points[points.length - 1];

                    for (let i = 1; i < points.length - 1; i++) {
                        const candidateDistance = pointToSegmentDistance(points[i], start, end);
                        if (candidateDistance > maxDistance) {
                            maxDistance = candidateDistance;
                            index = i;
                        }
                    }

                    if (maxDistance <= epsilon || index === -1) {
                        return [start, end];
                    }

                    const left = simplifyRdp(points.slice(0, index + 1), epsilon);
                    const right = simplifyRdp(points.slice(index), epsilon);
                    return left.slice(0, -1).concat(right);
                }

                function getPolylineBounds(points) {
                    let minX = Infinity;
                    let minY = Infinity;
                    let maxX = -Infinity;
                    let maxY = -Infinity;
                    for (const point of points) {
                        if (point.x < minX) minX = point.x;
                        if (point.y < minY) minY = point.y;
                        if (point.x > maxX) maxX = point.x;
                        if (point.y > maxY) maxY = point.y;
                    }
                    return { minX, minY, maxX, maxY };
                }

                function simplifyTracePolyline(poly) {
                    const points = dedupePolyline(toPointList(poly));
                    if (points.length <= 2) {
                        return points;
                    }

                    const bounds = getPolylineBounds(points);
                    const diag = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
                    const epsilon = Math.max(1.5, Math.min(8, diag * 0.015 + points.length * 0.006));
                    const simplified = simplifyRdp(points, epsilon);

                    if (simplified.length < 2) {
                        return points;
                    }
                    return simplified;
                }

                function pointsToSvgPath(points) {
                    if (!points.length) return "";
                    if (points.length === 1) {
                        return `M ${formatSvgNum(points[0].x)},${formatSvgNum(points[0].y)}`;
                    }
                    if (points.length === 2) {
                        return `M ${formatSvgNum(points[0].x)},${formatSvgNum(points[0].y)} L ${formatSvgNum(points[1].x)},${formatSvgNum(points[1].y)}`;
                    }

                    const tension = 0.85;
                    let d = `M ${formatSvgNum(points[0].x)},${formatSvgNum(points[0].y)}`;

                    for (let i = 0; i < points.length - 1; i++) {
                        const p0 = points[i - 1] || points[i];
                        const p1 = points[i];
                        const p2 = points[i + 1];
                        const p3 = points[i + 2] || p2;

                        const c1 = {
                            x: p1.x + ((p2.x - p0.x) * tension) / 6,
                            y: p1.y + ((p2.y - p0.y) * tension) / 6
                        };
                        const c2 = {
                            x: p2.x - ((p3.x - p1.x) * tension) / 6,
                            y: p2.y - ((p3.y - p1.y) * tension) / 6
                        };

                        d += ` C ${formatSvgNum(c1.x)},${formatSvgNum(c1.y)} ${formatSvgNum(c2.x)},${formatSvgNum(c2.y)} ${formatSvgNum(p2.x)},${formatSvgNum(p2.y)}`;
                    }

                    return d;
                }

                let thruCutPaths = [];
                let offBasePaths = [];
                let creasePaths = [];

                for (const poly of result.polylines) {
                    if (poly.length < 10) continue; // Filter out tiny noise specs

                    // Sample up to 20 points along the polyline to determine dominant color
                    let votes = { red: 0, blue: 0, green: 0, neutral: 0, unknown: 0 };
                    const numSamples = Math.min(20, poly.length);
                    for (let i = 0; i < numSamples; i++) {
                        const idx = Math.floor(i * (poly.length - 1) / (numSamples - 1 || 1));
                        const pt = poly[idx];
                        const rgb = getNeighborhoodInkColor(colorData, pt[0], pt[1]);
                        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
                        const cls = classifyHsl(hsl.h, hsl.s, hsl.l);
                        votes[cls]++;
                    }

                    // Majority vote
                    let maxVotes = -1;
                    let dominantColor = "neutral";
                    for (const color in votes) {
                        if (votes[color] > maxVotes) {
                            maxVotes = votes[color];
                            dominantColor = color;
                        }
                    }

                    // Map ink color to cutting method
                    let method = "thru_cut";
                    if (dominantColor === "blue") {
                        method = "thru_cut";
                    } else if (dominantColor === "red") {
                        method = "off_base";
                    } else if (dominantColor === "green") {
                        method = "crease";
                    } else {
                        method = "thru_cut"; // black/neutral ink defaults to thru_cut
                    }

                    const simplifiedPoints = simplifyTracePolyline(poly);
                    if (simplifiedPoints.length < 2) continue;

                    const pathD = pointsToSvgPath(simplifiedPoints);

                    if (method === "thru_cut") {
                        thruCutPaths.push(pathD);
                    } else if (method === "off_base") {
                        offBasePaths.push(pathD);
                    } else if (method === "crease") {
                        creasePaths.push(pathD);
                    }
                }

                let svgText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${maskImg.width} ${maskImg.height}" width="${maskImg.width}px" height="${maskImg.height}px">\n`;
                if (thruCutPaths.length > 0) {
                    svgText += `  <path d="${thruCutPaths.join(' ')}" fill="none" stroke="#3b82f6" stroke-width="2" vector-effect="non-scaling-stroke" data-method="thru_cut"/>\n`;
                }
                if (offBasePaths.length > 0) {
                    svgText += `  <path d="${offBasePaths.join(' ')}" fill="none" stroke="#8b5cf6" stroke-width="2" vector-effect="non-scaling-stroke" data-method="off_base"/>\n`;
                }
                if (creasePaths.length > 0) {
                    svgText += `  <path d="${creasePaths.join(' ')}" fill="none" stroke="#f59e0b" stroke-width="2" vector-effect="non-scaling-stroke" data-method="crease"/>\n`;
                }
                svgText += `</svg>`;

                const virtualFile = new File([svgText], "skeleton_trace.svg", { type: "image/svg+xml" });

                let urumiMeta = null;
                try {
                    const metaRes = await fetch(`${serverUrl}/uploads/metadata.json?t=${Date.now()}`);
                    if (metaRes.ok) {
                        const meta = await metaRes.json();
                        urumiMeta = {
                            dots_per_mm: meta.dots_per_mm,
                            physical_width: meta.physical_width,
                            physical_height: meta.physical_height
                        };
                    }
                } catch (err) { }

                log(`Skeletonization complete: Extracted ${result.polylines.length} polylines.`, "success");
                handleFile(virtualFile, onGCodeReady, window.switchTab, urumiMeta);

                if (window.switchTab) {
                    window.switchTab('gcode-preview');
                }
            } catch (e) {
                log(`Skeletonization Failed: ${e.message}`, "error");
            }
        });
    });
}

try {
    setupUrumiCamPushListener();
} catch (e) {
    console.error("Failed to setup UrumiCam push listener:", e);
}


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
        renderGCode(state.gcode, 'gcodeCanvas', 'canvasContainer', state.stepsPerMM, -1, state.binaryPackets);
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
const btnJog = document.getElementById('btnJog');

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
document.getElementById('jogXPlus').addEventListener('click', () => sendJog(jogState.step, 0, 0, 0));
document.getElementById('jogXMinus').addEventListener('click', () => sendJog(-jogState.step, 0, 0, 0));
document.getElementById('jogYPlus').addEventListener('click', () => sendJog(0, jogState.step, 0, 0));
document.getElementById('jogYMinus').addEventListener('click', () => sendJog(0, -jogState.step, 0, 0));
document.getElementById('jogZPlus').addEventListener('click', () => sendJog(0, 0, jogState.step, 0));
document.getElementById('jogZMinus').addEventListener('click', () => sendJog(0, 0, -jogState.step, 0));
document.getElementById('jogAPlus').addEventListener('click', () => sendJog(0, 0, 0, jogState.step));
document.getElementById('jogAMinus').addEventListener('click', () => sendJog(0, 0, 0, -jogState.step));

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

        const col = Math.floor(leftBasedX / (bedW / 3)); // 0 to 2, left to right
        const row = cy >= (bedH / 2) ? 0 : 1;           // Row 0 is Top, Row 1 is Bottom

        let zoneNum = 1;
        if (row === 0) {
            zoneNum = col + 1; // 1, 2, 3
        } else {
            zoneNum = col + 4; // 4, 5, 6
        }
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
    const autoBtn = document.getElementById('btnSuctionModeAuto');
    const manualBtn = document.getElementById('btnSuctionModeManual');
    const manualOnBtn = document.getElementById('btnSuctionManualOn');
    const manualOffBtn = document.getElementById('btnSuctionManualOff');
    const statusText = document.getElementById('suctionStatusText');
    const fanIcon = document.getElementById('suctionFanIcon');
    const cells = document.querySelectorAll('.suction-cell');

    // Toggle active state classes for pills
    if (autoBtn && manualBtn) {
        if (state.suctionMode === 'auto') {
            autoBtn.classList.add('active');
            manualBtn.classList.remove('active');
        } else {
            autoBtn.classList.remove('active');
            manualBtn.classList.add('active');
        }
    }

    if (manualOnBtn && manualOffBtn) {
        manualOnBtn.classList.toggle('active', state.suctionControlEnabled);
        manualOffBtn.classList.toggle('active', !state.suctionControlEnabled);
    }

    // Identify active zones based on current mode
    const activeList = getActiveSuctionZones();

    // Sync individual cells in the 2x3 bed visualizer grid
    cells.forEach(cell => {
        const zoneNum = parseInt(cell.dataset.zone);
        if (activeList.includes(zoneNum)) {
            cell.classList.add('active');
        } else {
            cell.classList.remove('active');
        }
    });

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

    // Run the initial UI sync
    updateSuctionUI();
}

// Kickstart the suction bed subsystem
initSuctionBed();
