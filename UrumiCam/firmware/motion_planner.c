/**
 * ============================================================================
 *  URUMICAM — MOTION PLANNER (Implementation)
 * ============================================================================
 *  Computes move commands with synchronous arrival for X/Y axes.
 *  Emits Antigravity move commands over RS485.
 *
 *  HARD RULE: No Z movement is ever generated.
 *  Only MOTOR_X_ID and MOTOR_Y_ID are used.
 *
 *  Synchronous arrival calculation:
 *      max_steps = max(abs(dx), abs(dy))
 *      duration  = max_steps / MAX_SPS
 *      sps_x     = abs(dx) / duration
 *      sps_y     = abs(dy) / duration
 * ============================================================================
 */

#include "motion_planner.h"
#include "config.h"
#include "pico/stdlib.h"
#include "hardware/uart.h"
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

/* Current absolute position in steps */
static int32_t pos_x = 0;
static int32_t pos_y = 0;
static uint32_t last_distance = 0;
static volatile bool is_idle = true;

/* Forward declarations */
static void rs485_send(const char *cmd);

void motion_init(void) {
    /* Initialize RS485 UART */
    uart_init(RS485_UART, RS485_BAUD);
    gpio_set_function(RS485_TX_PIN, GPIO_FUNC_UART);
    gpio_set_function(RS485_RX_PIN, GPIO_FUNC_UART);

    /* RS485 Direction control */
    gpio_init(RS485_DE_PIN);
    gpio_set_dir(RS485_DE_PIN, GPIO_OUT);
    gpio_put(RS485_DE_PIN, 0);  /* Default: receive mode */

    pos_x = 0;
    pos_y = 0;
    is_idle = true;
}

bool motion_move_to(int32_t target_x, int32_t target_y) {
    /* Check soft limits */
    if (abs(target_x) > X_MAX_STEPS || abs(target_y) > Y_MAX_STEPS) {
        return false;  /* ERR_BOUNDS */
    }

    int32_t dx = target_x - pos_x;
    int32_t dy = target_y - pos_y;

    if (dx == 0 && dy == 0) {
        /* Already at target */
        return true;
    }

    /* Calculate synchronous arrival SPS */
    uint32_t abs_dx = (uint32_t)abs(dx);
    uint32_t abs_dy = (uint32_t)abs(dy);
    uint32_t max_steps = abs_dx > abs_dy ? abs_dx : abs_dy;

    /* Distance for dwell calculation */
    last_distance = max_steps;

    /* Duration = max_steps / MAX_SPS */
    float duration = (float)max_steps / (float)MAX_SPS;
    if (duration < 0.001f) duration = 0.001f;

    uint32_t sps_x = abs_dx > 0 ? (uint32_t)((float)abs_dx / duration) : 0;
    uint32_t sps_y = abs_dy > 0 ? (uint32_t)((float)abs_dy / duration) : 0;

    /* Clamp SPS */
    if (sps_x > MAX_SPS) sps_x = MAX_SPS;
    if (sps_y > MAX_SPS) sps_y = MAX_SPS;
    if (sps_x < 1 && abs_dx > 0) sps_x = 1;
    if (sps_y < 1 && abs_dy > 0) sps_y = 1;

    /* Build move command — ONLY X and Y, NEVER Z */
    char cmd[128];
    if (dx != 0 && dy != 0) {
        snprintf(cmd, sizeof(cmd), "move 2 %d %d %ld %ld %lu %lu",
                 MOTOR_X_ID, MOTOR_Y_ID,
                 (long)dx, (long)dy,
                 (unsigned long)sps_x, (unsigned long)sps_y);
    } else if (dx != 0) {
        snprintf(cmd, sizeof(cmd), "move 1 %d %ld %lu",
                 MOTOR_X_ID, (long)dx, (unsigned long)sps_x);
    } else {
        snprintf(cmd, sizeof(cmd), "move 1 %d %ld %lu",
                 MOTOR_Y_ID, (long)dy, (unsigned long)sps_y);
    }

    is_idle = false;
    rs485_send(cmd);

    /* Update tracked position */
    pos_x = target_x;
    pos_y = target_y;

    /* Mark motion complete (kinematic arrival assumed after send) */
    /* In real implementation, this would wait for motor feedback */
    is_idle = true;

    return true;
}

void motion_home(void) {
    /* Send home command to motors */
    rs485_send("home");
    pos_x = 0;
    pos_y = 0;
    last_distance = 0;
    is_idle = true;
}

void motion_abort(void) {
    /* Emergency stop all motors */
    rs485_send("enable all 0");
    is_idle = true;
}

void motion_get_position(int32_t *x, int32_t *y) {
    *x = pos_x;
    *y = pos_y;
}

uint32_t motion_get_last_distance(void) {
    return last_distance;
}

bool motion_is_idle(void) {
    return is_idle;
}

/* ── RS485 Transmit ────────────────────────────────────────────────────── */

static void rs485_send(const char *cmd) {
    /* Assert DE (transmit mode) */
    gpio_put(RS485_DE_PIN, 1);
    sleep_us(10);

    uart_puts(RS485_UART, cmd);
    uart_puts(RS485_UART, "\n");

    /* Wait for UART TX FIFO to flush */
    uart_tx_wait_blocking(RS485_UART);
    sleep_us(10);

    /* De-assert DE (receive mode) */
    gpio_put(RS485_DE_PIN, 0);
}
