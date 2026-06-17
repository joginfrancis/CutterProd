/**
 * ============================================================================
 *  URUMICAM — UART PROTOCOL (Implementation)
 * ============================================================================
 *  Parses incoming messages from Pi 4 and sends status responses.
 *  Protocol: newline-terminated ASCII strings.
 *
 *  Incoming: MOVE_TO X Y | HOME | ABORT
 *  Outgoing: ACK_ARRIVED X Y | ACK_HOMED | ERR_STALL axis | ERR_BOUNDS
 * ============================================================================
 */

#include "uart_protocol.h"
#include "config.h"
#include "pico/stdlib.h"
#include "hardware/uart.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define UART_BUF_SIZE 128

static char rx_buf[UART_BUF_SIZE];
static int rx_pos = 0;

void uart_protocol_init(void) {
    uart_init(HOST_UART, HOST_UART_BAUD);
    gpio_set_function(HOST_UART_TX_PIN, GPIO_FUNC_UART);
    gpio_set_function(HOST_UART_RX_PIN, GPIO_FUNC_UART);
    uart_set_fifo_enabled(HOST_UART, true);
}

bool uart_protocol_read(host_msg_t *msg) {
    while (uart_is_readable(HOST_UART)) {
        char c = uart_getc(HOST_UART);

        if (c == '\n' || c == '\r') {
            if (rx_pos == 0) continue;  // Skip empty lines
            rx_buf[rx_pos] = '\0';

            // Parse the message
            msg->type = MSG_UNKNOWN;
            msg->x = 0;
            msg->y = 0;

            if (strncmp(rx_buf, "MOVE_TO ", 8) == 0) {
                msg->type = MSG_MOVE_TO;
                char *ptr = rx_buf + 8;
                msg->x = strtol(ptr, &ptr, 10);
                msg->y = strtol(ptr, NULL, 10);
            } else if (strcmp(rx_buf, "HOME") == 0) {
                msg->type = MSG_HOME;
            } else if (strcmp(rx_buf, "ABORT") == 0) {
                msg->type = MSG_ABORT;
            } else if (strncmp(rx_buf, "suction speed ", 14) == 0 || strncmp(rx_buf, "SUCTION SPEED ", 14) == 0) {
                msg->type = MSG_SUCTION_SPEED;
                msg->speed = strtol(rx_buf + 14, NULL, 10);
            } else if (strncmp(rx_buf, "suction zones ", 14) == 0 || strncmp(rx_buf, "SUCTION ZONES ", 14) == 0) {
                msg->type = MSG_SUCTION_ZONES;
                char *ptr = rx_buf + 14;
                for (int i = 0; i < 6; i++) {
                    msg->zones[i] = (uint8_t)strtol(ptr, &ptr, 10);
                }
            }

            rx_pos = 0;
            return true;
        } else if (rx_pos < UART_BUF_SIZE - 1) {
            rx_buf[rx_pos++] = c;
        }
    }
    return false;
}

/* ── Outgoing Messages ─────────────────────────────────────────────────── */

static void uart_send_line(const char *line) {
    uart_puts(HOST_UART, line);
    uart_puts(HOST_UART, "\n");
}

void uart_send_ack_arrived(int32_t x, int32_t y) {
    char buf[64];
    snprintf(buf, sizeof(buf), "ACK_ARRIVED %ld %ld", (long)x, (long)y);
    uart_send_line(buf);
}

void uart_send_ack_homed(void) {
    uart_send_line("ACK_HOMED");
}

void uart_send_err_stall(const char *axis) {
    char buf[32];
    snprintf(buf, sizeof(buf), "ERR_STALL %s", axis);
    uart_send_line(buf);
}

void uart_send_err_bounds(void) {
    uart_send_line("ERR_BOUNDS");
}
