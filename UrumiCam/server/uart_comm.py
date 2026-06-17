"""
============================================================================
                    URUMICAM — PICO 2 USB SERIAL COMMUNICATION
============================================================================

Manages the USB serial link between the Pi 4 and the Pico 2 running
Urumi-Fw. The Pico appears as /dev/ttyACM0 (USB CDC serial).

Protocol (Pi 4 → Pico 2, plain ASCII, newline-terminated):
    move <count> <addr...> <steps...> <sps...>   — queue synchronized move
    stop                                          — emergency stop
    enable <addr|all> <0|1>                       — enable/disable driver
    ping <addr>                                   — check node alive

Protocol (Pico 2 → Pi 4):
    ok          — move segment queued successfully
    nope        — ring buffer full, must retry
    ready       — buffer drained past watermark, safe to resume

Motor completion detection:
    The firmware has NO "arrived" message. Completion is determined by
    calculating the expected move duration and waiting with a safety
    margin, then calling on_arrived to unblock the state machine.

============================================================================
"""

import threading
import time
import logging
import queue
from collections import deque

logger = logging.getLogger("urumicam.uart")

# How long to wait beyond the calculated move time before declaring arrival.
# Accounts for RS485 round-trips, slave buffer latency, etc.
SETTLE_MARGIN_S = 0.25

# Max retries on "nope" before giving up on a segment.
NOPE_MAX_RETRIES = 20
NOPE_RETRY_DELAY_S = 0.05


class UARTComm:
    """
    USB serial communication handler for Urumi-Fw on the Pico 2.

    The Pico 2 connects as /dev/ttyACM0 and speaks plain ASCII.
    This class preserves the same external API as the old UARTComm so
    the state machine (state_machine.py) requires zero changes.

    Public callbacks (set by state machine):
        on_arrived(x, y)   — called when a move is complete
        on_homed()         — called when a stop+home is complete
        on_stall(axis)     — not natively supported by firmware; unused
        on_bounds()        — not natively supported by firmware; unused
        on_message(msg)    — called with every raw TX/RX line (for logging)
    """

    def __init__(self, port="/dev/ttyACM0", baudrate=115200, mock=False):
        self.port = port
        self.baudrate = baudrate
        self.mock = mock

        self._serial = None
        self._reader_thread = None
        self._running = False
        self._lock = threading.Lock()
        self._message_log = deque(maxlen=200)

        # Completion timer — fires on_arrived after move duration elapses
        self._arrival_timer = None

        self._rx_queue = queue.Queue()

        # Config injected by app.py so we can calculate move durations
        self._motor_x_addr = 3
        self._motor_y_addr = 2
        self._steps_per_mm_x = 160.0
        self._steps_per_mm_y = 160.0

        # Connect on init unless mock mode
        if not self.mock:
            self.connect()
        # Absolute position tracker — origin (0,0) is wherever the gantry
        # was when the server started. All moves are tracked relative to this.
        self._pos_x_steps = 0
        self._pos_y_steps = 0
        self._pos_lock = threading.Lock()

        # Callbacks — set by state machine
        self.on_arrived = None
        self.on_homed   = None
        self.on_stall   = None     # unused — kept for API compatibility
        self.on_bounds  = None     # unused — kept for API compatibility
        self.on_message = None

    # ── Lifecycle ──────────────────────────────────────────────────────────

    def connect(self):
        """Open the serial port and start the reader thread."""
        if self.mock:
            logger.info("[UART] Running in MOCK mode")
            self._running = True
            return True

        try:
            import serial
            self._serial = serial.Serial(
                port=self.port,
                baudrate=self.baudrate,
                timeout=0.1,
                write_timeout=2.0
            )
            self._running = True
            self._reader_thread = threading.Thread(
                target=self._read_loop, daemon=True, name="uart-reader"
            )
            self._reader_thread.start()
            logger.info(f"[UART] Connected to {self.port} @ {self.baudrate}")

            # Enable motors on connect
            time.sleep(0.5)  # Give Pico time to boot if freshly connected
            self._send_raw("enable all 1")
            return True

        except Exception as e:
            logger.error(f"[UART] Connection failed: {e}")
            return False

    def disconnect(self):
        """Close the serial port and stop the reader thread."""
        self._running = False
        self._cancel_arrival_timer()
        if self._reader_thread:
            self._reader_thread.join(timeout=2.0)
        if self._serial and self._serial.is_open:
            self._serial.close()
        logger.info("[UART] Disconnected")

    def configure(self, motor_x_addr, motor_y_addr,
                  steps_per_mm_x=160.0, steps_per_mm_y=160.0):
        """Inject motor addresses and steps/mm from config."""
        self._motor_x_addr = motor_x_addr
        self._motor_y_addr = motor_y_addr
        self._steps_per_mm_x = steps_per_mm_x
        self._steps_per_mm_y = steps_per_mm_y

    def get_position_mm(self):
        """Return current tracked position in mm from origin (0, 0)."""
        with self._pos_lock:
            x_mm = self._pos_x_steps / max(self._steps_per_mm_x, 1)
            y_mm = self._pos_y_steps / max(self._steps_per_mm_y, 1)
        return {"x_mm": round(x_mm, 3), "y_mm": round(y_mm, 3)}

    def reset_position(self):
        """Reset tracked position to (0, 0) — call when user re-homes."""
        with self._pos_lock:
            self._pos_x_steps = 0
            self._pos_y_steps = 0
        logger.info("[UART] Position reset to (0, 0)")

    # ── Outgoing Commands (public API — same as before) ────────────────────

    def send_jog(self, dx_steps, dy_steps, sps=800, on_complete=None):
        """
        Jog the gantry by a RELATIVE step delta.
        on_complete(pos_mm) is called after the move finishes.
        """
        with self._pos_lock:
            target_x = self._pos_x_steps + dx_steps
            target_y = self._pos_y_steps + dy_steps

        def _jog_done(x, y):
            with self._pos_lock:
                self._pos_x_steps = x
                self._pos_y_steps = y
            if on_complete:
                on_complete(self.get_position_mm())

        self._execute_move(target_x, target_y, sps,
                           arrival_cb=_jog_done, state_cb=None,
                           dx_override=dx_steps, dy_override=dy_steps)

    def send_move_to(self, x_steps_abs, y_steps_abs, sps=800):
        """
        Move to an ABSOLUTE position (in steps from the tracked origin).
        Internally computes the delta from current tracked position.
        Fires on_arrived(x, y) after the move duration has elapsed.
        """
        if self.mock:
            with self._pos_lock:
                self._pos_x_steps = x_steps_abs
                self._pos_y_steps = y_steps_abs
            duration = max(abs(x_steps_abs), abs(y_steps_abs)) / max(sps, 1)
            self._schedule_arrival(x_steps_abs, y_steps_abs, duration,
                                   cb=self.on_arrived)
            logger.debug(f"[UART MOCK] move_to ({x_steps_abs}, {y_steps_abs})")
            return

        with self._pos_lock:
            dx = x_steps_abs - self._pos_x_steps
            dy = y_steps_abs - self._pos_y_steps

        def _scan_done(x, y):
            with self._pos_lock:
                self._pos_x_steps = x_steps_abs
                self._pos_y_steps = y_steps_abs
            if self.on_arrived:
                self.on_arrived(x, y)

        self._execute_move(x_steps_abs, y_steps_abs, sps,
                           arrival_cb=_scan_done,
                           dx_override=dx, dy_override=dy,
                           state_cb=None)

    def _execute_move(self, target_x, target_y, sps,
                      arrival_cb, state_cb=None,
                      dx_override=None, dy_override=None):
        """
        Core move dispatcher. Sends the RS485 move command and schedules
        the arrival callback after the expected duration.

        target_x/y  — absolute tracked positions AFTER this move
        dx/dy       — step deltas to actually send (defaults to target if None)
        arrival_cb  — called with (target_x, target_y) on arrival
        """
        dx = dx_override if dx_override is not None else target_x
        dy = dy_override if dy_override is not None else target_y

        abs_dx = abs(dx)
        abs_dy = abs(dy)
        max_steps = max(abs_dx, abs_dy, 1)

        sps_x = int(sps * abs_dx / max_steps) if abs_dx > 0 else 0
        sps_y = int(sps * abs_dy / max_steps) if abs_dy > 0 else 0

        participants = []
        if abs_dx > 0:
            participants.append((self._motor_x_addr, dx, sps_x))
        if abs_dy > 0:
            participants.append((self._motor_y_addr, dy, sps_y))

        if not participants:
            # Zero-length move — fire immediately
            arrival_cb(target_x, target_y)
            return

        count = len(participants)
        addrs = " ".join(str(p[0]) for p in participants)
        steps = " ".join(str(p[1]) for p in participants)
        spss  = " ".join(str(p[2]) for p in participants)
        cmd   = f"move {count} {addrs} {steps} {spss}"

        ok = self._send_with_retry(cmd)
        if not ok:
            logger.error("[UART] Move command rejected after retries")
            if self.on_stall:
                self.on_stall("X")
            return

        duration = max_steps / max(sps, 1)
        self._schedule_arrival(target_x, target_y, duration, cb=arrival_cb)

    def send_home(self):
        """
        Urumi-Fw has no homing command.
        Send a stop and fire on_homed so the state machine can continue.
        """
        self.send_abort()
        time.sleep(0.2)
        if self.on_homed:
            self.on_homed()

    def send_abort(self):
        """Emergency stop — clears all slave buffers immediately."""
        self._cancel_arrival_timer()
        if self.mock:
            logger.debug("[UART MOCK] stop")
            return
        self._send_raw("stop")

    # ── Internal Helpers ───────────────────────────────────────────────────

    def _send_with_retry(self, cmd):
        """
        Send a command, retrying on 'nope' (buffer full) responses.
        Returns True if 'ok' was received, False on exhausted retries.
        """
        for attempt in range(NOPE_MAX_RETRIES):
            self._send_raw(cmd)
            # Brief wait for the Pico to respond
            response = self._wait_for_response(timeout=0.3)
            if response == "ok":
                return True
            elif response == "nope":
                logger.debug(f"[UART] nope (attempt {attempt+1}/{NOPE_MAX_RETRIES}) — retrying")
                time.sleep(NOPE_RETRY_DELAY_S)
            else:
                # Unexpected or no response — try once more
                time.sleep(NOPE_RETRY_DELAY_S)
        return False

    def _wait_for_response(self, timeout=0.5):
        """
        Block briefly waiting for a 'ok', 'nope', or 'ready' line.
        Returns the response string or None on timeout.
        """
        if self.mock:
            return "ok"

        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                line = self._rx_queue.get(timeout=remaining)
                if line in ("ok", "nope", "ready"):
                    return line
            except queue.Empty:
                return None

    def _send_raw(self, message):
        """Send a raw ASCII command string, newline-terminated."""
        with self._lock:
            msg = message.strip() + "\n"
            self._log_tx(msg.strip())

            if self.mock:
                return

            if self._serial and self._serial.is_open:
                try:
                    self._serial.write(msg.encode("ascii"))
                    self._serial.flush()
                except Exception as e:
                    logger.error(f"[UART TX Error] {e}")

    def _log_tx(self, msg):
        self._message_log.append(("TX", msg, time.time()))
        logger.debug(f"[UART TX] {msg}")
        if self.on_message:
            self.on_message(f"TX: {msg}")

    def _log_rx(self, msg):
        self._message_log.append(("RX", msg, time.time()))
        logger.debug(f"[UART RX] {msg}")
        if self.on_message:
            self.on_message(f"RX: {msg}")

    # ── Arrival Timer ──────────────────────────────────────────────────────

    def _schedule_arrival(self, x, y, duration_s, cb=None):
        """Fire cb(x, y) after duration_s + SETTLE_MARGIN_S."""
        self._cancel_arrival_timer()
        total = duration_s + SETTLE_MARGIN_S
        callback = cb or self.on_arrived

        def _fire():
            logger.debug(f"[UART] Arrival timer fired after {total:.2f}s")
            if callback:
                callback(x, y)

        self._arrival_timer = threading.Timer(total, _fire)
        self._arrival_timer.daemon = True
        self._arrival_timer.start()

    def _cancel_arrival_timer(self):
        if self._arrival_timer:
            self._arrival_timer.cancel()
            self._arrival_timer = None

    # ── Background Reader Thread ───────────────────────────────────────────

    def _read_loop(self):
        """
        Background thread: continuously drain the serial RX buffer.
        The Pico sends unsolicited 'ready' messages when its buffer drains.
        We log them; flow control is handled synchronously in _send_with_retry.
        """
        buffer = ""
        while self._running:
            try:
                if self._serial and self._serial.in_waiting:
                    chunk = self._serial.read(self._serial.in_waiting).decode("ascii", errors="replace")
                    buffer += chunk
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.strip()
                        if line:
                            self._log_rx(line)
                            self._rx_queue.put(line)
                else:
                    time.sleep(0.01)
            except Exception as e:
                logger.error(f"[UART Read Error] {e}")
                time.sleep(0.1)

    # ── Mock Injection ─────────────────────────────────────────────────────

    def mock_inject(self, message):
        """Inject a simulated Pico message for testing."""
        if self.mock:
            self._log_rx(message)

    # ── Utilities ──────────────────────────────────────────────────────────

    def get_log(self, count=20):
        """Return the last N message log entries."""
        return list(self._message_log)[-count:]

    @property
    def is_connected(self):
        if self.mock:
            return self._running
        return self._serial is not None and self._serial.is_open
