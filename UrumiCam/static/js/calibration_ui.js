/**
 * ============================================================================
 *  URUMICAM — CALIBRATION UI
 * ============================================================================
 * Settings panel bindings for calibration routines.
 * ============================================================================
 */

const CalibrationUI = (() => {
    function init() {
        // Calibration buttons
        document.getElementById('btnCalPixels')?.addEventListener('click', () => {
            WS.emit('calibrate', { type: 'pixels_per_step', step_count: 1000 });
            LogPanel.addLine('Running pixels/step calibration...', 'info');
        });

        document.getElementById('btnCalFov')?.addEventListener('click', () => {
            const w = parseFloat(document.getElementById('setTileFovX')?.value) || 10;
            const h = parseFloat(document.getElementById('setTileFovY')?.value) || 7.5;
            WS.emit('calibrate', { type: 'tile_fov', width_mm: w, height_mm: h });
            LogPanel.addLine('Running FOV calibration...', 'info');
        });

        document.getElementById('btnCalFocus')?.addEventListener('click', () => {
            WS.emit('calibrate', { type: 'focus_baseline' });
            LogPanel.addLine('Running focus baseline calibration...', 'info');
        });

        document.getElementById('btnCalQuiet')?.addEventListener('click', () => {
            WS.emit('calibrate', { type: 'quiescence' });
            LogPanel.addLine('Running quiescence calibration...', 'info');
        });

        document.getElementById('btnCalAruco')?.addEventListener('click', () => {
            WS.emit('calibrate', { type: 'aruco_dpi', marker_id: 0, marker_size_mm: 20.0 });
            LogPanel.addLine('Running ArUco marker calibration (DICT_4X4_50 ID 0, 20mm)...', 'info');
        });

        // Calibration results
        WS.on('calibration_result', (data) => {
            if (data.error) {
                LogPanel.addLine(`Calibration error: ${data.error}`, 'error');
            } else {
                LogPanel.addLine(`Calibration complete: ${JSON.stringify(data)}`, 'success');
            }
        });

        // Settings save on change
        const settingInputs = [
            'setTileFovX', 'setTileFovY', 'setOverlap', 'setRoiMargin',
            'setMaxRetries', 'setMotorXId', 'setMotorYId', 'setStepsX', 'setStepsY'
        ];

        settingInputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', saveSettings);
            }
        });

        document.getElementById('setMultiBody')?.addEventListener('change', saveSettings);
    }

    function saveSettings() {
        const updates = {
            tile_fov_x_mm: parseFloat(document.getElementById('setTileFovX')?.value) || 10,
            tile_fov_y_mm: parseFloat(document.getElementById('setTileFovY')?.value) || 7.5,
            overlap_fraction: (parseFloat(document.getElementById('setOverlap')?.value) || 28) / 100,
            roi_margin_mm: parseFloat(document.getElementById('setRoiMargin')?.value) || 5,
            max_focus_retries: parseInt(document.getElementById('setMaxRetries')?.value) || 3,
            motor_x_rs485_id: parseInt(document.getElementById('setMotorXId')?.value) || 3,
            motor_y_rs485_id: parseInt(document.getElementById('setMotorYId')?.value) || 2,
            steps_per_mm_x: parseFloat(document.getElementById('setStepsX')?.value) || 160,
            steps_per_mm_y: parseFloat(document.getElementById('setStepsY')?.value) || 160,
            multi_body_mode: document.getElementById('setMultiBody')?.checked || false,
        };

        WS.emit('config_update', updates);
    }

    function loadSettings(config) {
        if (!config) return;
        const map = {
            setTileFovX: config.tile_fov_x_mm,
            setTileFovY: config.tile_fov_y_mm,
            setOverlap: (config.overlap_fraction || 0.28) * 100,
            setRoiMargin: config.roi_margin_mm,
            setMaxRetries: config.max_focus_retries,
            setMotorXId: config.motor_x_rs485_id,
            setMotorYId: config.motor_y_rs485_id,
            setStepsX: config.steps_per_mm_x,
            setStepsY: config.steps_per_mm_y,
        };

        Object.entries(map).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el && val !== undefined) el.value = val;
        });

        const mb = document.getElementById('setMultiBody');
        if (mb) mb.checked = config.multi_body_mode || false;
    }

    return { init, loadSettings };
})();
