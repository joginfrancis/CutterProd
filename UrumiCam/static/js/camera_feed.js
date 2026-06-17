/**
 * ============================================================================
 *  URUMICAM — CAMERA FEED
 * ============================================================================
 * Displays MJPEG frames from WebSocket onto a canvas element.
 * Overlays: crosshair, coordinate text, tile label.
 * ============================================================================
 */

const CameraFeed = (() => {
    let canvas = null;
    let ctx = null;
    let emptyEl = null;
    let coordEl = null;
    let tileLabel = null;
    let isActive = false;

    function init() {
        canvas = document.getElementById('cameraCanvas');
        ctx = canvas.getContext('2d');
        emptyEl = document.getElementById('cameraEmpty');
        coordEl = document.getElementById('cameraCoord');
        tileLabel = document.getElementById('cameraTileLabel');

        WS.on('camera_frame', (data) => {
            if (!data.data) return;
            showFrame(data.data);
        });

        WS.on('state_change', (data) => {
            if (data.state === 'targeting' || data.state === 'settling' ||
                data.state === 'capturing') {
                if (!isActive) startPreview();
            }
        });

        // Size canvas to container
        const container = canvas.parentElement;
        const rect = container.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;
    }

    function showFrame(b64Data) {
        const img = new Image();
        img.onload = () => {
            if (emptyEl) emptyEl.classList.add('hidden');

            const container = canvas.parentElement;
            canvas.width = container.clientWidth;
            canvas.height = container.clientHeight;

            // Draw frame maintaining aspect ratio
            const scale = Math.min(
                canvas.width / img.width,
                canvas.height / img.height
            );
            const w = img.width * scale;
            const h = img.height * scale;
            const x = (canvas.width - w) / 2;
            const y = (canvas.height - h) / 2;

            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, x, y, w, h);
        };
        img.src = 'data:image/jpeg;base64,' + b64Data;
    }

    function updateCoords(x, y) {
        if (coordEl) {
            coordEl.textContent = `X: ${x.toFixed(2)}  Y: ${y.toFixed(2)}`;
        }
    }

    function updateTileLabel(row, col) {
        if (tileLabel) {
            tileLabel.textContent = row !== null ? `Tile [${row}, ${col}]` : '';
        }
    }

    function startPreview() {
        isActive = true;
        WS.emit('start_preview');
    }

    function stopPreview() {
        isActive = false;
        WS.emit('stop_preview');
    }

    return { init, updateCoords, updateTileLabel, startPreview, stopPreview };
})();
