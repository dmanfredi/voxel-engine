# Physics & Collision System

## Overview

The engine has Minecraft-inspired movement physics with AABB collision against the block grid. The player always sprints. There are two camera modes: FPS (physics-based) and freecam (no-clip fly mode), toggled via the debug panel.

## Files

- **`src/movement.ts`** — physics tick, freecam, movement direction calculation
- **`src/collision.ts`** — AABB-vs-block-grid collision with per-axis resolution
- **`src/main.ts`** — tick loop, player state initialization, camera/input

## Collision (`collision.ts`)

### Why collide against the block array, not the mesh?

The greedy mesh merges faces into larger quads for rendering. That's a visual optimization — it makes collision *harder*, not easier, because you'd be testing against arbitrary-sized quads with no spatial structure. The block array `blocks[y][z][x]` is already a perfect spatial lookup: given a world position, the block index is `Math.floor(pos / BLOCK_SIZE)`, which is O(1).

### Axis-separated resolution

Movement is resolved one axis at a time: X, then Z, then Y. After applying movement on each axis, we compute which blocks the player's AABB overlaps and push the player out of any solid blocks along that axis.

This approach gives wall sliding for free. If you walk diagonally into a north-facing wall, only Z gets blocked — X keeps moving and you slide along the wall. If all axes were resolved simultaneously, you'd stop dead.

### Player AABB

The camera position is the player's eye (top of head). The AABB extends downward by `playerHeight` and outward by `playerHalfWidth` in X/Z:

```
X: [camX - halfWidth, camX + halfWidth]
Y: [camY - height,    camY]
Z: [camZ - halfWidth, camZ + halfWidth]
```

Currently `halfWidth = BLOCK_SIZE / 4` (half a block wide) and `height = BLOCK_SIZE * 2 * 0.9` (~2 blocks tall).

### Collision result

`moveAndCollide` returns `{ onGround, collidedX, collidedZ, collidedCeiling }` so the physics tick can zero velocity on the correct axes and track ground state.

### Out of bounds

Blocks outside the chunk dimensions are treated as air. The player can walk off the edge of the world.

## Physics (`movement.ts`)

### Tick model

Originally we used a fixed 20Hz timestep (matching Minecraft) with interpolation for smooth rendering. We ditched this because:

- We're single-player with one entity — no need for server-tick-rate constraints
- The interpolation added complexity (prev position tracking, lerping)
- A 20Hz physics rate at 60fps means most frames have no position change, causing visible stutter without interpolation

Instead, `physicsTick` runs once per frame and receives `dt` (frame delta in seconds). Constants are defined in terms of the original tick duration (`MC_TICK = 0.05s`) and scaled at runtime:

- **Drag** scales exponentially: `drag^(dt/MC_TICK)` — this preserves the decay curve regardless of framerate
- **Additive values** (acceleration, gravity) scale linearly: `value * (dt/MC_TICK)`
- **Displacement** scales linearly: `velocity * (dt/MC_TICK)`
- **One-time impulses** (jump velocity, jump boost) are applied as-is since they fire once

### Two movement regimes

**Ground**: high drag (0.546 per tick), high acceleration. You reach top speed quickly and stop quickly. The formula is `vel = vel * drag + accel * direction`.

**Air**: low drag (0.91 per tick), low acceleration (0.26 vs 3.0 on ground). You keep most of your speed but can barely steer. This is why jumping while moving is faster — you build speed on the ground frame, then barely lose it in air.

### Jumping

- Sets vertical velocity to `JUMP_VELOCITY` (4.2)
- 0.5s cooldown when holding Space (auto-jump). Releasing Space resets the cooldown immediately, so tapping gives instant re-jumps
- Jump boost (`SPRINT_JUMP_BOOST`) adds horizontal velocity toward facing, but only when a movement key is held — prevents lurching forward from a stationary jump

### Vertical physics

Applied after movement each frame: subtract gravity, multiply by vertical drag, clamp to terminal velocity. Ceiling collision and floor collision both zero vertical velocity. Floor collision sets `onGround = true`.

### Direction calculation

`getMovementDirection` projects WASD input onto the horizontal plane using cross products (same technique as the old FPS camera, just returning a normalized direction vector instead of applying movement directly). Diagonal input is normalized so you don't move faster at 45 degrees.

## Freecam

`FREECAM` is the original fly-mode camera — direct position mutation proportional to `dt * speed`, no physics, no collision. Uses the full 3D camera front vector (not ground-projected), so you fly in the direction you're looking. Toggled via the debug panel's "Freecam" checkbox.

## Constants

All constants live at the top of `movement.ts`. The base values come from Minecraft's movement formulas (scaled x10 for our 10-unit block size), but several have been tuned for feel:

| Constant | Value | What it controls |
|---|---|---|
| `GROUND_ACCEL` | 3 | How fast you reach top speed on ground |
| `AIR_ACCEL` | 0.26 | How much you can steer in air |
| `GROUND_DRAG` | 0.546 | How quickly you stop on ground (lower = snappier) |
| `AIR_DRAG` | 0.91 | How much speed you keep in air (higher = more momentum) |
| `JUMP_VELOCITY` | 4.2 | Initial upward velocity on jump |
| `GRAVITY` | 0.8 | Downward acceleration per tick |
| `VERTICAL_DRAG` | 0.98 | Air resistance on vertical movement |
| `TERMINAL_VELOCITY` | -39.2 | Max falling speed |
| `SPRINT_JUMP_BOOST` | 2.8 | Horizontal velocity added when jump-moving |
| `JUMP_COOLDOWN` | 0.5 | Seconds between auto-jumps when holding Space |
| `NEGLIGIBLE_THRESHOLD` | 0.05 | Velocity below this is snapped to zero |
