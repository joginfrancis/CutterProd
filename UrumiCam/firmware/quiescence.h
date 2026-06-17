/**
 * ============================================================================
 *  URUMICAM — QUIESCENCE MONITOR (Header)
 * ============================================================================
 */

#ifndef QUIESCENCE_H
#define QUIESCENCE_H

#include <stdbool.h>
#include <stdint.h>

/* Initialize ADXL345 and quiescence GPIO */
bool quiescence_init(void);

/* Check if ADXL345 is available */
bool quiescence_has_accel(void);

/* Start monitoring after motion complete. Sets GPIO HIGH when settled. */
void quiescence_start_monitoring(uint32_t move_distance_steps);

/* De-assert GPIO (called before next move) */
void quiescence_deassert(void);

/* Process accelerometer readings (call from main loop) */
void quiescence_poll(void);

#endif /* QUIESCENCE_H */
