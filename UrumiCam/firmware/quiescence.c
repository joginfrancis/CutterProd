/**
 * ============================================================================
 *  URUMICAM — QUIESCENCE MONITOR (Implementation)
 * ============================================================================
 *  Monitors ADXL345 accelerometer RMS vibration after motion complete.
 *  Asserts GPIO HIGH only when RMS drops below threshold for sustained
 *  50ms window. Falls back to distance-proportional dwell if no ADXL345.
 *
 *  HARD ARCHITECTURAL RULE: Camera capture is gated on this GPIO.
 * ============================================================================
 */

#include "quiescence.h"
#include "config.h"
#include "pico/stdlib.h"
#include "hardware/i2c.h"
#include "hardware/gpio.h"
#include <math.h>

/* ADXL345 Registers */
#define REG_POWER_CTL   0x2D
#define REG_DATA_FORMAT 0x31
#define REG_BW_RATE     0x2C
#define REG_DATAX0      0x32
#define REG_DEVID       0x00

static bool accel_available = false;
static bool monitoring = false;
static uint32_t quiet_start_ms = 0;
static bool gpio_asserted = false;

/* Fallback dwell state */
static uint32_t dwell_target_ms = 0;
static uint32_t dwell_start_ms = 0;
static bool dwell_active = false;

/* ── I2C Helpers ───────────────────────────────────────────────────────── */

static bool i2c_write_reg(uint8_t reg, uint8_t val) {
    uint8_t buf[2] = { reg, val };
    int ret = i2c_write_blocking(ACCEL_I2C, ACCEL_ADDR, buf, 2, false);
    return ret == 2;
}

static bool i2c_read_regs(uint8_t reg, uint8_t *buf, size_t len) {
    int ret = i2c_write_blocking(ACCEL_I2C, ACCEL_ADDR, &reg, 1, true);
    if (ret != 1) return false;
    ret = i2c_read_blocking(ACCEL_I2C, ACCEL_ADDR, buf, len, false);
    return ret == (int)len;
}

/* ── ADXL345 Init ──────────────────────────────────────────────────────── */

bool quiescence_init(void) {
    /* Init GPIO output for quiescence signal */
    gpio_init(QUIESCENCE_PIN);
    gpio_set_dir(QUIESCENCE_PIN, GPIO_OUT);
    gpio_put(QUIESCENCE_PIN, 0);  /* LOW = not settled */

    /* Init I2C for ADXL345 */
    i2c_init(ACCEL_I2C, ACCEL_I2C_FREQ);
    gpio_set_function(ACCEL_SDA_PIN, GPIO_FUNC_I2C);
    gpio_set_function(ACCEL_SCL_PIN, GPIO_FUNC_I2C);
    gpio_pull_up(ACCEL_SDA_PIN);
    gpio_pull_up(ACCEL_SCL_PIN);

    /* Check if ADXL345 responds */
    uint8_t devid = 0;
    if (i2c_read_regs(REG_DEVID, &devid, 1) && devid == 0xE5) {
        accel_available = true;

        /* Configure ADXL345 */
        i2c_write_reg(REG_DATA_FORMAT, 0x08); /* Full resolution, ±2g */
        i2c_write_reg(REG_BW_RATE, 0x0C);    /* 400 Hz output rate */
        i2c_write_reg(REG_POWER_CTL, 0x08);  /* Measurement mode */
    } else {
        accel_available = false;
    }

    return accel_available;
}

bool quiescence_has_accel(void) {
    return accel_available;
}

/* ── Monitoring Control ────────────────────────────────────────────────── */

void quiescence_start_monitoring(uint32_t move_distance_steps) {
    gpio_asserted = false;
    monitoring = true;

    if (accel_available) {
        /* Hardware quiescence: start sampling */
        quiet_start_ms = 0;
    } else {
        /* Fallback dwell timer */
        dwell_target_ms = BASE_DWELL_MS + 
            (uint32_t)(move_distance_steps * DWELL_PER_STEP);
        dwell_start_ms = to_ms_since_boot(get_absolute_time());
        dwell_active = true;
    }
}

void quiescence_deassert(void) {
    gpio_put(QUIESCENCE_PIN, 0);
    gpio_asserted = false;
    monitoring = false;
    dwell_active = false;
}

/* ── Main Poll Loop ────────────────────────────────────────────────────── */

void quiescence_poll(void) {
    if (!monitoring || gpio_asserted) return;

    if (accel_available) {
        /* Read ADXL345 XYZ data */
        uint8_t data[6];
        if (!i2c_read_regs(REG_DATAX0, data, 6)) return;

        int16_t ax = (int16_t)(data[1] << 8 | data[0]);
        int16_t ay = (int16_t)(data[3] << 8 | data[2]);
        int16_t az = (int16_t)(data[5] << 8 | data[4]);

        /* Convert to g-force (full resolution: 3.9mg/LSB) */
        float gx = ax * 0.0039f;
        float gy = ay * 0.0039f;
        float gz = az * 0.0039f;

        /* Remove gravity component (assume Z-up) */
        gz -= 1.0f;

        /* Compute RMS */
        float rms = sqrtf(gx * gx + gy * gy + gz * gz);

        if (rms < ACCEL_RMS_THRESHOLD) {
            if (quiet_start_ms == 0) {
                quiet_start_ms = to_ms_since_boot(get_absolute_time());
            } else {
                uint32_t elapsed = to_ms_since_boot(get_absolute_time()) - quiet_start_ms;
                if (elapsed >= QUIESCENCE_WINDOW) {
                    /* Sustained quiescence confirmed */
                    gpio_put(QUIESCENCE_PIN, 1);
                    gpio_asserted = true;
                }
            }
        } else {
            /* Reset quiet window */
            quiet_start_ms = 0;
        }
    } else if (dwell_active) {
        /* Fallback dwell timer */
        uint32_t elapsed = to_ms_since_boot(get_absolute_time()) - dwell_start_ms;
        if (elapsed >= dwell_target_ms) {
            gpio_put(QUIESCENCE_PIN, 1);
            gpio_asserted = true;
            dwell_active = false;
        }
    }
}
