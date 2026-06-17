/**
 * ============================================================================
 *  URUMICAM — LOG PANEL
 * ============================================================================
 * Scrolling monospace log window. Last 6 lines visible.
 * Color-coded: UART (blue), success (green), error (red), warning (amber).
 * ============================================================================
 */

const LogPanel = (() => {
    const MAX_LINES = 200;
    let logEl = null;

    function init() {
        logEl = document.getElementById('logOutput');
        document.getElementById('btnClearLog').addEventListener('click', clear);

        // Wire WebSocket
        WS.on('log_message', (data) => {
            addLine(data.message, data.level, data.timestamp);
        });
    }

    function addLine(message, level = 'info', timestamp = null) {
        if (!logEl) return;

        const ts = timestamp || new Date().toLocaleTimeString('en-GB', { hour12: false });
        const line = document.createElement('div');
        line.className = `log-line log-${level}`;
        line.textContent = `[${ts}] ${message}`;
        logEl.appendChild(line);

        // Trim old lines
        while (logEl.children.length > MAX_LINES) {
            logEl.removeChild(logEl.firstChild);
        }

        // Auto-scroll to bottom
        logEl.scrollTop = logEl.scrollHeight;
    }

    function clear() {
        if (logEl) logEl.innerHTML = '';
    }

    return { init, addLine, clear };
})();
