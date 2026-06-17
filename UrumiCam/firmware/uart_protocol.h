/**
 * ============================================================================
 *  URUMICAM — UART PROTOCOL (Header)
 * ============================================================================
 */

#ifndef UART_PROTOCOL_H
#define UART_PROTOCOL_H

#include <stdbool.h>
#include <stdint.h>

/* Message types from Pi 4 */
typedef enum {
    MSG_MOVE_TO,
    MSG_HOME,
    MSG_ABORT,
    MSG_SUCTION_SPEED,
    MSG_SUCTION_ZONES,
    MSG_UNKNOWN,
} host_msg_type_t;

/* Parsed message */
typedef struct {
    host_msg_type_t type;
    int32_t x;
    int32_t y;
    int32_t speed;
    uint8_t zones[6];
} host_msg_t;

/* Initialize host UART */
void uart_protocol_init(void);

/* Try to read a complete message. Returns true if message available. */
bool uart_protocol_read(host_msg_t *msg);

/* Send responses to Pi 4 */
void uart_send_ack_arrived(int32_t x, int32_t y);
void uart_send_ack_homed(void);
void uart_send_err_stall(const char *axis);
void uart_send_err_bounds(void);

#endif /* UART_PROTOCOL_H */
