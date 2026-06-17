/**
 * ============================================================================
 *  URUMICAM — PICO 2 FIRMWARE CONFIGURATION
 * ============================================================================
 *  Pin definitions, calibration constants, and system limits.
 *  Target: Raspberry Pi Pico 2 (RP2350)
 * ============================================================================
 */

#ifndef CONFIG_H
#define CONFIG_H

/* ── UART (Pi 4 ↔ Pico 2 Communication) ─────────────────────────────── */
#define HOST_UART           uart0
#define HOST_UART_TX_PIN    0       // GP0
#define HOST_UART_RX_PIN    1       // GP1
#define HOST_UART_BAUD      115200

/* ── RS485 (Motor Command Bus) ───────────────────────────────────────── */
#define RS485_UART          uart1
#define RS485_TX_PIN        4       // GP4
#define RS485_RX_PIN        5       // GP5
#define RS485_DE_PIN        6       // GP6 — Driver Enable (HIGH = transmit)
#define RS485_BAUD          115200

/* ── Quiescence GPIO Output ──────────────────────────────────────────── */
#define QUIESCENCE_PIN      2       // GP2 → Pi 4 GPIO 17

/* ── ADXL345 Accelerometer (I2C) ─────────────────────────────────────── */
#define ACCEL_I2C           i2c0
#define ACCEL_SDA_PIN       8       // GP8
#define ACCEL_SCL_PIN       9       // GP9
#define ACCEL_I2C_FREQ      400000  // 400kHz Fast Mode
#define ACCEL_ADDR          0x53    // ADXL345 default I2C address

/* ── Motor RS485 IDs ─────────────────────────────────────────────────── */
#define MOTOR_X_ID          3
#define MOTOR_Y_ID          2

/* ── Motion Limits ───────────────────────────────────────────────────── */
#define MAX_SPS             30000   // Maximum steps per second
#define MAX_STEPS_CMD       30000   // Maximum steps per single command
#define X_MAX_STEPS         200000  // Soft limit X axis
#define Y_MAX_STEPS         200000  // Soft limit Y axis

/* ── Quiescence Calibration ──────────────────────────────────────────── */
#define ACCEL_RMS_THRESHOLD 0.05f   // g-force RMS threshold
#define QUIESCENCE_WINDOW   50      // ms — sustained quiet window
#define ACCEL_SAMPLE_RATE   200     // Hz — accelerometer sample rate

/* ── Fallback Dwell (no accelerometer) ───────────────────────────────── */
#define BASE_DWELL_MS       200
#define DWELL_PER_STEP      0.01f   // ms per step of move distance

/* ── Status LED ──────────────────────────────────────────────────────── */
#define LED_PIN             25      // Onboard LED

#endif /* CONFIG_H */
