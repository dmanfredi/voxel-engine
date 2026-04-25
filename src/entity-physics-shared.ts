/**
 * Physics constants shared by sphere/cube/interactions modules. Tuning
 * matches `movement.ts` so entities and player land on each other consistently.
 */

// Reference timestep; per-frame `t = dt / MC_TICK` rescales constants below.
export const MC_TICK = 0.05;

// Gravity per tick² (pre-scaling).
export const GRAVITY = 0.8;

// Hard floor on vy during long falls.
export const TERMINAL_VELOCITY = -39.2;

// Horizontal components below this are zeroed each tick (anti-drift).
export const NEGLIGIBLE = 0.05;

// Inward-speed threshold separating resting-contact (zero) from bounce
// (reflect with restitution). Prevents gravity-induced micro-bouncing.
export const RESTING_THRESHOLD = 2.0;
