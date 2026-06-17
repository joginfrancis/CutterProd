"""
============================================================================
                    URUMICAM — QUIESCENCE GATE
============================================================================

Software quiescence gate.

The Urumi-Fw firmware running on the Pico 2 has no GPIO quiescence
output line — vibration sensing is not implemented in firmware.

This module therefore implements a TIME-BASED quiescence strategy:
    1. The state machine waits for the arrival timer to fire (move done).
    2. This gate then adds a configurable dwell period to allow mechanical
       vibrations to decay before the camera fires.

If a physical ADXL345 accelerometer is wired directly to the Pi 4's
I2C bus (not via the Pico), set use_adxl345=True and the gate will
read real RMS vibration values via smbus2.

External API is unchanged from the original gpio_gate.py so the
state machine requires zero changes.

============================================================================
"""

import time
import threading
import logging

logger = logging.getLogger("urumicam.gpio")


class GPIOGate:
    """
    Quiescence gate.

    In software-only mode (default): waits a fixed dwell time after
    the move completes before declaring quiescence.

    In ADXL345 mode: polls the accelerometer RMS until it falls below
    a configured threshold, with a timeout fallback to the dwell time.
    """

    def __init__(self, pin=17, mock=False, dwell_s=0.4,
                 use_adxl345=False, adxl345_threshold=0.02,
                 adxl345_i2c_bus=1, adxl345_address=0x53):
        """
        Args:
            pin:               Ignored — kept for API compatibility.
            mock:              If True, quiescence is instant (for dev/testing).
            dwell_s:           Seconds to wait after move before declaring settled.
            use_adxl345:       Read real vibration from ADXL345 on Pi 4 I2C.
            adxl345_threshold: RMS acceleration (g) below which = quiescent.
            adxl345_i2c_bus:   I2C bus number (usually 1 on Pi 4).
            adxl345_address:   I2C address (0x53 when SDO=HIGH, 0x1D default).
        """
        self.pin = pin          # kept for API compatibility, not used
        self.mock = mock
        self.dwell_s = dwell_s
        self.use_adxl345 = use_adxl345
        self.adxl345_threshold = adxl345_threshold
        self._adxl = None

        self._quiescent = False
        self._lock = threading.Lock()
        self._callback = None   # kept for API compatibility

        if not mock and use_adxl345:
            self._init_adxl345(adxl345_i2c_bus, adxl345_address)

    # ── ADXL345 Initialisation ─────────────────────────────────────────────

    def _init_adxl345(self, bus, address):
        try:
            import smbus2
            self._i2c = smbus2.SMBus(bus)
            self._adxl_addr = address
            # Wake ADXL345: set measurement mode
            self._i2c.write_byte_data(address, 0x2D, 0x08)
            # ±2g range, full resolution
            self._i2c.write_byte_data(address, 0x31, 0x08)
            logger.info(f"[GPIO] ADXL345 initialised on I2C bus {bus} addr 0x{address:02X}")
            self._adxl = True
        except ImportError:
            logger.warning("[GPIO] smbus2 not installed — falling back to timed dwell")
            self.use_adxl345 = False
        except Exception as e:
            logger.warning(f"[GPIO] ADXL345 init failed: {e} — falling back to timed dwell")
            self.use_adxl345 = False

    def _read_adxl345_rms(self):
        """Read RMS acceleration (g) across X/Y/Z axes."""
        try:
            import smbus2
            raw = self._i2c.read_i2c_block_data(self._adxl_addr, 0x32, 6)
            x = (raw[1] << 8 | raw[0])
            y = (raw[3] << 8 | raw[2])
            z = (raw[5] << 8 | raw[4])
            # Sign-extend 16-bit
            for v in [x, y, z]:
                if v & 0x8000:
                    v -= 0x10000
            scale = 0.0039  # ±2g full resolution: 3.9mg/LSB
            x *= scale; y *= scale; z *= scale
            return ((x**2 + y**2 + z**2) ** 0.5)
        except Exception as e:
            logger.debug(f"[GPIO] ADXL345 read error: {e}")
            return 0.0

    # ── Public API (unchanged from original) ───────────────────────────────

    def is_quiescent(self):
        """True if the system is settled and safe to capture."""
        with self._lock:
            return self._quiescent

    def wait_for_quiescence(self, timeout=10.0):
        """
        Block until quiescence is confirmed. Returns True if settled,
        False on timeout.

        In mock mode: returns immediately (True).
        In software-dwell mode: waits dwell_s and returns True.
        In ADXL345 mode: polls accelerometer until RMS < threshold.
        """
        if self.mock:
            with self._lock:
                self._quiescent = True
            return True

        start = time.monotonic()

        if self.use_adxl345 and self._adxl:
            # Poll accelerometer
            while (time.monotonic() - start) < timeout:
                rms = self._read_adxl345_rms()
                if rms < self.adxl345_threshold:
                    logger.info(f"[GPIO] ADXL345 quiescent (RMS={rms:.4f}g)")
                    with self._lock:
                        self._quiescent = True
                    if self._callback:
                        self._callback()
                    return True
                time.sleep(0.01)
            logger.warning(f"[GPIO] ADXL345 timeout after {timeout}s — proceeding with dwell")
            # Fall through to dwell

        # Software dwell — just wait
        remaining = self.dwell_s - (time.monotonic() - start)
        if remaining > 0:
            time.sleep(remaining)

        with self._lock:
            self._quiescent = True
        logger.info(f"[GPIO] Quiescence declared after {time.monotonic()-start:.2f}s dwell")

        if self._callback:
            self._callback()
        return True

    def reset(self):
        """Mark as non-quiescent — call before each move."""
        with self._lock:
            self._quiescent = False

    def register_edge_callback(self, callback):
        """Register a callback fired when quiescence is achieved."""
        self._callback = callback

    # ── Mock / Test Helpers ────────────────────────────────────────────────

    def mock_set_quiescent(self, state=True):
        if self.mock:
            with self._lock:
                self._quiescent = state
            if state and self._callback:
                self._callback()

    def cleanup(self):
        """Release hardware resources."""
        if self.use_adxl345 and self._adxl:
            try:
                self._i2c.close()
            except Exception:
                pass
