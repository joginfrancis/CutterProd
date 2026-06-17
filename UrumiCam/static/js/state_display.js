/**
 * ============================================================================
 *  URUMICAM — STATE DISPLAY
 * ============================================================================
 * Shows the current state machine state in the header badge.
 * Maps internal state names to human-readable labels.
 * ============================================================================
 */

const StateDisplay = (() => {
    const STATE_LABELS = {
        idle: 'IDLE',
        roi_scan: 'DETECTING ROI',
        plan: 'PLANNING',
        targeting: 'TARGETING',
        settling: 'SETTLING',
        capturing: 'CAPTURING',
        processing: 'PROCESSING',
        tile_complete: 'TILE OK',
        tile_failed: 'TILE FAILED',
        stitch: 'STITCHING',
        complete: 'COMPLETE',
    };

    let badgeEl = null;
    let textEl = null;

    function init() {
        badgeEl = document.getElementById('stateBadge');
        textEl = document.getElementById('stateText');

        WS.on('state_change', (data) => {
            setState(data.state);
        });
    }

    function setState(state) {
        if (!badgeEl || !textEl) return;
        textEl.textContent = STATE_LABELS[state] || state.toUpperCase();
        badgeEl.setAttribute('data-state', state);
    }

    return { init, setState };
})();
