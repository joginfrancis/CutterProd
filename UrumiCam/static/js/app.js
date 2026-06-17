/**
 * ============================================================================
 *  URUMICAM — MAIN APPLICATION CONTROLLER
 * ============================================================================
 * Initializes all UI modules, handles scan lifecycle, manages modals,
 * and coordinates the complete user interaction flow.
 * ============================================================================
 */

document.addEventListener('DOMContentLoaded', () => {

    // ── Initialize Modules ────────────────────────────────────────────────

    WS.connect();
    LogPanel.init();
    StateDisplay.init();
    TileGrid.init();
    CameraFeed.init();
    CalibrationUI.init();
    Method2Controller.init();

    // Initialize Lucide Icons
    lucide.createIcons();

    // ── DOM References ────────────────────────────────────────────────────

    const btnStartScan  = document.getElementById('btnStartScan');
    const btnAbortScan  = document.getElementById('btnAbortScan');
    const btnSettings   = document.getElementById('btnSettings');
    const folderNameInput = document.getElementById('folderName');
    const progressFill  = document.getElementById('progressFill');
    const progressLabel = document.getElementById('progressLabel');
    const coordX        = document.getElementById('coordX');
    const coordY        = document.getElementById('coordY');
    const btnSetTL      = document.getElementById('btnSetTL');
    const btnSetBR      = document.getElementById('btnSetBR');
    const roiTlDisplay  = document.getElementById('roiTlDisplay');
    const roiBrDisplay  = document.getElementById('roiBrDisplay');
    const btnZeroPos    = document.getElementById('btnZeroPos');

    const roiManualSection = document.getElementById('roiManualSection');
    const roiAutoSection   = document.getElementById('roiAutoSection');

    // Modals
    const settingsModal = document.getElementById('settingsModal');
    const roiModal      = document.getElementById('roiModal');
    const completeModal = document.getElementById('completeModal');

    let isScanning   = false;
    let currentX_mm  = 0;
    let currentY_mm  = 0;
    let jogStep_mm   = 1;     // active step size
    let jogBusy      = false; // debounce: ignore clicks while move is in flight

    // ── ROI Mode Selection ────────────────────────────────────────────────

    document.querySelectorAll('.roi-mode-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.roi-mode-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const mode = tab.dataset.mode;
            if (mode === 'manual') {
                roiManualSection.classList.remove('hidden');
                roiAutoSection.classList.add('hidden');
            } else {
                roiManualSection.classList.add('hidden');
                roiAutoSection.classList.remove('hidden');
            }
        });
    });

    // ── Scan Control ──────────────────────────────────────────────────────

    btnStartScan.addEventListener('click', () => {
        const activeRoiMode = document.querySelector('.roi-mode-tab.active')?.dataset.mode || 'manual';
        let roiBox = null;

        if (activeRoiMode === 'manual') {
            const x1 = parseFloat(document.getElementById('roiTlX').value);
            const y1 = parseFloat(document.getElementById('roiTlY').value);
            const x2 = parseFloat(document.getElementById('roiBrX').value);
            const y2 = parseFloat(document.getElementById('roiBrY').value);

            if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
                alert('Jog to Top-Left corner and click "Set Top-Left", then jog to Bottom-Right and click "Set Bottom-Right" before starting the scan.');
                return;
            }
            roiBox = { x1, y1, x2, y2 };
        }

        const folderName = folderNameInput.value.trim() ||
            `scan_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
        folderNameInput.value = folderName;
        folderNameInput.disabled = true;

        isScanning = true;
        btnStartScan.classList.add('hidden');
        btnAbortScan.classList.remove('hidden');

        TileGrid.reset();
        WS.emit('scan_start', { folder_name: folderName, roi_box: roiBox });
        
        if (roiBox) {
            LogPanel.addLine(`Scan started: ${folderName} (ROI: ${roiBox.x1.toFixed(2)},${roiBox.y1.toFixed(2)} → ${roiBox.x2.toFixed(2)},${roiBox.y2.toFixed(2)})`, 'success');
        } else {
            LogPanel.addLine(`Scan started: ${folderName} (Auto Edge Detection)`, 'success');
        }
    });

    btnAbortScan.addEventListener('click', () => {
        if (confirm('Abort the current scan?')) {
            WS.emit('scan_abort');
            endScan();
        }
    });


    function endScan() {
        isScanning = false;
        folderNameInput.disabled = false;
        btnAbortScan.classList.add('hidden');
        btnStartScan.classList.remove('hidden');
    }

    // ── Jog Pad ───────────────────────────────────────────────────────────

    function updatePositionDisplay(x_mm, y_mm) {
        currentX_mm = x_mm;
        currentY_mm = y_mm;
        coordX.textContent = x_mm.toFixed(2);
        coordY.textContent = y_mm.toFixed(2);
    }

    // Step size pills
    document.querySelectorAll('.jog-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.jog-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            jogStep_mm = parseFloat(pill.dataset.step);
        });
    });

    // D-pad buttons
    const jogMap = {
        jogXPlus:  'x+',
        jogXMinus: 'x-',
        jogYPlus:  'y+',
        jogYMinus: 'y-',
    };
    Object.entries(jogMap).forEach(([id, dir]) => {
        document.getElementById(id).addEventListener('click', () => {
            if (jogBusy || isScanning) return;
            jogBusy = true;
            WS.emit('jog', { dir, step_mm: jogStep_mm });
            // Optimistic local display update
            const dx = dir === 'x+' ? jogStep_mm : dir === 'x-' ? -jogStep_mm : 0;
            const dy = dir === 'y+' ? jogStep_mm : dir === 'y-' ? -jogStep_mm : 0;
            updatePositionDisplay(currentX_mm + dx, currentY_mm + dy);
        });
    });

    // Server confirms actual position after move
    WS.on('position_update', (data) => {
        updatePositionDisplay(data.x_mm, data.y_mm);
        jogBusy = false;
    });

    // Zero button — mark current gantry position as (0, 0)
    btnZeroPos.addEventListener('click', () => {
        WS.emit('reset_position');
        updatePositionDisplay(0, 0);
        // Also clear ROI since it was relative to old origin
        document.getElementById('roiTlX').value = '';
        document.getElementById('roiTlY').value = '';
        document.getElementById('roiBrX').value = '';
        document.getElementById('roiBrY').value = '';
        roiTlDisplay.textContent = 'not set';
        roiBrDisplay.textContent = 'not set';
        LogPanel.addLine('Position zeroed at current location.', 'info');
    });

    // ROI capture buttons
    btnSetTL.addEventListener('click', () => {
        document.getElementById('roiTlX').value = currentX_mm.toFixed(3);
        document.getElementById('roiTlY').value = currentY_mm.toFixed(3);
        roiTlDisplay.textContent = `X:${currentX_mm.toFixed(2)} Y:${currentY_mm.toFixed(2)}`;
        LogPanel.addLine(`Top-Left set: (${currentX_mm.toFixed(2)}, ${currentY_mm.toFixed(2)}) mm`, 'info');
    });

    btnSetBR.addEventListener('click', () => {
        document.getElementById('roiBrX').value = currentX_mm.toFixed(3);
        document.getElementById('roiBrY').value = currentY_mm.toFixed(3);
        roiBrDisplay.textContent = `X:${currentX_mm.toFixed(2)} Y:${currentY_mm.toFixed(2)}`;
        LogPanel.addLine(`Bottom-Right set: (${currentX_mm.toFixed(2)}, ${currentY_mm.toFixed(2)}) mm`, 'info');
    });

    // ── State Change Handling ─────────────────────────────────────────────

    WS.on('state_change', (data) => {
        if (data.state === 'idle' && isScanning) {
            endScan();
        }
    });

    // ── Progress Updates ──────────────────────────────────────────────────

    WS.on('scan_progress', (data) => {
        const pct = data.total > 0 ? (data.completed / data.total * 100) : 0;
        progressFill.style.width = `${pct}%`;
        progressLabel.textContent = `${data.completed} / ${data.total}`;
    });

    // ── Tile Updates (coordinate tracking) ────────────────────────────────

    WS.on('tile_update', (data) => {
        if (data.status === 'targeting' || data.status === 'capturing') {
            // Update coordinate display — X Y only (NO Z)
            const xMm = data.center_x_mm || 0;
            const yMm = data.center_y_mm || 0;
            coordX.textContent = xMm.toFixed(2);
            coordY.textContent = yMm.toFixed(2);
            CameraFeed.updateCoords(xMm, yMm);
            CameraFeed.updateTileLabel(data.row, data.col);
        }
    });

    // ── ROI Confirmation Modal ────────────────────────────────────────────

    WS.on('roi_overlay', (data) => {
        if (!data.success) {
            LogPanel.addLine('ROI detection failed — enter manually', 'error');
            return;
        }

        const msg = document.getElementById('roiMessage');
        msg.textContent = `Workpiece detected (${data.method}): ` +
            `${data.rois.length} region(s) found. Accept highlighted ROI?`;

        openModal(roiModal);
    });

    document.getElementById('btnRoiAccept')?.addEventListener('click', () => {
        closeModal(roiModal);
        WS.emit('roi_confirm', {});
        LogPanel.addLine('ROI accepted — computing tile grid', 'success');
    });

    document.getElementById('btnRoiRescan')?.addEventListener('click', () => {
        closeModal(roiModal);
        WS.emit('roi_rescan');
        LogPanel.addLine('Rescanning ROI...', 'info');
    });

    document.getElementById('btnCloseRoi')?.addEventListener('click', () => {
        closeModal(roiModal);
        WS.emit('scan_abort');
        endScan();
        LogPanel.addLine('ROI detection cancelled', 'info');
    });

    // ── Scan Complete Modal ───────────────────────────────────────────────

    WS.on('scan_complete', (data) => {
        endScan();
        progressFill.style.width = '100%';
        progressLabel.textContent = 'Complete';

        const msg = document.getElementById('completeMessage');
        msg.textContent = `Scan complete — ${data.completed} tiles captured.` +
            (data.failed_focus > 0 ? ` ${data.failed_focus} failed (focus).` : '') +
            ` Run another scan?`;

        const retryBtn = document.getElementById('btnRetryFailed');
        retryBtn.style.display = data.failed_focus > 0 ? 'flex' : 'none';

        openModal(completeModal);
    });

    document.getElementById('btnNewScan')?.addEventListener('click', () => {
        closeModal(completeModal);
        WS.emit('scan_reset');
        TileGrid.reset();
        progressFill.style.width = '0%';
        progressLabel.textContent = 'Ready';
        coordX.textContent = '0.00';
        coordY.textContent = '0.00';
    });

    document.getElementById('btnRetryFailed')?.addEventListener('click', () => {
        closeModal(completeModal);
        WS.emit('retry_failed');
        LogPanel.addLine('Retrying failed tiles...', 'info');
        isScanning = true;
        btnStartScan.classList.add('hidden');
        btnAbortScan.classList.remove('hidden');
    });

    document.getElementById('btnDone')?.addEventListener('click', () => {
        closeModal(completeModal);
        WS.emit('scan_reset');
    });

    // ── Settings Modal ────────────────────────────────────────────────────

    btnSettings.addEventListener('click', () => {
        // Load current config from server
        fetch('/api/config')
            .then(r => r.json())
            .then(config => CalibrationUI.loadSettings(config))
            .catch(() => {});
        openModal(settingsModal);
    });

    document.getElementById('btnCloseSettings')?.addEventListener('click', () => {
        closeModal(settingsModal);
    });

    // ── Error Handling ────────────────────────────────────────────────────

    WS.on('error', (data) => {
        if (data.type === 'motor_stall') {
            LogPanel.addLine(`⚠ MOTOR STALL on ${data.detail}! Scan halted.`, 'error');
            endScan();
            alert(`Motor stall detected on ${data.detail} axis!\n\nThe scan has been halted and axes will be homed.\nGantry position was lost — all coordinates must be re-established.`);
        } else if (data.type === 'roi_failed') {
            LogPanel.addLine(`ROI detection failed: ${data.detail}`, 'error');
        }
    });

    // ── Connection Events ─────────────────────────────────────────────────

    WS.on('connected', () => {
        LogPanel.addLine('WebSocket connected', 'success');
        CameraFeed.startPreview();
    });

    WS.on('disconnected', () => {
        LogPanel.addLine('WebSocket disconnected', 'error');
    });

    // ── Modal Helpers ─────────────────────────────────────────────────────

    function openModal(modal) {
        modal.classList.remove('hidden');
        setTimeout(() => modal.classList.add('visible'), 10);
    }

    function closeModal(modal) {
        modal.classList.remove('visible');
        setTimeout(() => modal.classList.add('hidden'), 300);
    }

    // Close modals on overlay click
    [settingsModal, roiModal, completeModal].forEach(modal => {
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeModal(modal);
            });
        }
    });

    // ── Initial State ─────────────────────────────────────────────────────

    LogPanel.addLine('UrumiCam ready', 'info');
    progressLabel.textContent = 'Ready';

    // Set default folder name
    folderNameInput.value = `scan_${new Date().toISOString().slice(0, 10)}`;
});
