/**
 * ============================================================================
 *  URUMICAM — WEBSOCKET CLIENT
 * ============================================================================
 * Socket.IO client wrapper with event routing and reconnection handling.
 * ============================================================================
 */

const WS = (() => {
    let socket = null;
    const handlers = {};

    function connect(url) {
        socket = io(url || window.location.origin, {
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
        });

        socket.on('connect', () => {
            console.log('[WS] Connected');
            _dispatch('connected');
        });

        socket.on('disconnect', () => {
            console.log('[WS] Disconnected');
            _dispatch('disconnected');
        });

        // Route all server events to registered handlers
        const events = [
            'state_change', 'tile_update', 'log_message',
            'scan_progress', 'scan_complete', 'roi_overlay',
            'camera_frame', 'calibration_result', 'error',
            'bed_rectified', 'scan_reset'
        ];

        events.forEach(evt => {
            socket.on(evt, (data) => _dispatch(evt, data));
        });

        return socket;
    }

    function on(event, callback) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(callback);
    }

    function emit(event, data) {
        if (socket) socket.emit(event, data);
    }

    function _dispatch(event, data) {
        if (handlers[event]) {
            handlers[event].forEach(cb => cb(data));
        }
    }

    return { connect, on, emit };
})();
