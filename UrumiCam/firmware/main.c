/**
 * ============================================================================
 *  URUMICAM — PICO 2 FIRMWARE (Main Entry Point)
 * ============================================================================
 *  Target: Raspberry Pi Pico 2 (RP2350)
 *
 *  Main loop:
 *    1. Poll UART for commands from Pi 4
 *    2. Execute motion commands (MOVE_TO, HOME, ABORT)
 *    3. After motion complete, monitor quiescence
 *    4. Assert GPIO HIGH when settled (camera gate)
 * ============================================================================
 */

#include "pico/stdlib.h"
#include "config.h"
#include "uart_protocol.h"
#include "motion_planner.h"
#include "quiescence.h"

/* System state */
typedef enum {
    STATE_IDLE,
    STATE_MOVING,
    STATE_SETTLING,
} system_state_t;

static system_state_t sys_state = STATE_IDLE;

int main(void) {
    /* ── Hardware Init ─────────────────────────────────────────────────── */
    stdio_init_all();

    /* Status LED */
    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);
    gpio_put(LED_PIN, 1);

    /* UART protocol (Pi 4 communication) */
    uart_protocol_init();

    /* Motion planner and RS485 */
    motion_init();

    /* Quiescence monitor and GPIO */
    bool has_accel = quiescence_init();

    /* Startup message */
    sleep_ms(100);
    if (has_accel) {
        /* ADXL345 detected — hardware quiescence mode */
        gpio_put(LED_PIN, 1);
    } else {
        /* No ADXL345 — fallback dwell timer mode */
        /* Blink LED twice to indicate fallback */
        for (int i = 0; i < 4; i++) {
            gpio_put(LED_PIN, i % 2);
            sleep_ms(150);
        }
        gpio_put(LED_PIN, 1);
    }

    /* ── Main Loop ─────────────────────────────────────────────────────── */

    host_msg_t msg;

    while (true) {
        /* 1. Check for incoming UART commands */
        if (uart_protocol_read(&msg)) {
            switch (msg.type) {
                case MSG_MOVE_TO: {
                    /* De-assert quiescence before moving */
                    quiescence_deassert();

                    /* Execute move */
                    if (motion_move_to(msg.x, msg.y)) {
                        sys_state = STATE_MOVING;

                        /* Send ACK_ARRIVED with actual position */
                        int32_t cx, cy;
                        motion_get_position(&cx, &cy);
                        uart_send_ack_arrived(cx, cy);

                        /* Start quiescence monitoring */
                        sys_state = STATE_SETTLING;
                        quiescence_start_monitoring(
                            motion_get_last_distance()
                        );
                    } else {
                        /* Bounds exceeded */
                        uart_send_err_bounds();
                    }
                    break;
                }

                case MSG_HOME: {
                    quiescence_deassert();
                    motion_home();
                    sys_state = STATE_IDLE;
                    uart_send_ack_homed();
                    break;
                }

                case MSG_ABORT: {
                    quiescence_deassert();
                    motion_abort();
                    sys_state = STATE_IDLE;
                    break;
                }

                default:
                    break;
            }
        }

        /* 2. Poll quiescence monitor */
        if (sys_state == STATE_SETTLING) {
            quiescence_poll();
        }

        /* 3. Brief sleep to avoid busy-spinning */
        sleep_us(100);
    }

    return 0;
}
