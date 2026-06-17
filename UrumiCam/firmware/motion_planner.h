/**
 * ============================================================================
 *  URUMICAM — MOTION PLANNER (Header)
 * ============================================================================
 */

#ifndef MOTION_PLANNER_H
#define MOTION_PLANNER_H

#include <stdint.h>
#include <stdbool.h>

/* Initialize motion planner and RS485 */
void motion_init(void);

/* Move to absolute position (steps). Returns false if bounds exceeded. */
bool motion_move_to(int32_t target_x, int32_t target_y);

/* Home both axes */
void motion_home(void);

/* Emergency stop */
void motion_abort(void);

/* Get current position */
void motion_get_position(int32_t *x, int32_t *y);

/* Get distance of last move (for dwell calculation) */
uint32_t motion_get_last_distance(void);

/* Check if motion is complete */
bool motion_is_idle(void);

#endif /* MOTION_PLANNER_H */
