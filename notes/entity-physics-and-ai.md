# Entity Physics & AI

## Overview

Entities move and behave through two per-tick subsystems invoked from `EntityManager.update()`:

1. **AI** (`entity-ai.ts`) — writes to `entity.v{x,y,z}` based on role
2. **Physics** (`entity-physics.ts`) — integrates velocity, applies gravity, resolves collisions

AI runs first, physics runs second — velocity changes the AI makes get integrated into position the same tick.

## Files

- **`src/entity-ai.ts`** — role dispatch + Rush behavior
- **`src/entity-physics.ts`** — integration, sphere-vs-voxel, sphere-vs-player, visual rolling

## The integration model

Semi-implicit (symplectic) Euler: `v += a*dt; x += v*dt`. Mirrors the player's physics model in `movement.ts` — same `MC_TICK = 0.05` reference timestep, same `GRAVITY = 0.8/tick`, same `TERMINAL_VELOCITY`, same exponential-drag form.

**Why match the player:** the player and entities occupy the same world, should fall at the same rate, and should feel like they inhabit the same physics. Future entity types should keep matching unless there's a specific reason not to (e.g., "floaty ghost enemy" ignores gravity intentionally).

## Impactful decisions — Physics

### Closest-point narrowphase, contact-normal response

Sphere-vs-voxel uses **closest-point-on-AABB** for narrowphase and resolves velocity along the **contact normal**, not per-axis. This differs from the player's axis-separated AABB-vs-voxel model (`collision.ts`) which is fine for boxes but would make spheres feel like rounded boxes — snagging on corners, jittering on edges.

Any future non-box entity (capsules, ellipsoids) should use the same closest-point + contact-normal pattern. Boxes (cube enemies) can continue to use the axis-separated approach.

### Restitution is a pair property, combined with max()

Every material has a `restitution` value (entity-side in `materials` table; block-side on `BlockProperties`). Collisions combine the two with `max()` — the bouncier surface dominates. Rationale: when we introduce a "bouncy" block or enemy trait, its property should be visible regardless of what it hits. Product/min would hide the feature behind compatibility checks.

### Resting contact threshold

The single biggest "without this it looks broken" detail. Gravity adds tiny velocity each frame; collision bounce reflects it; result is infinite micro-bouncing. Fix: if the inward component of velocity at contact is below `RESTING_THRESHOLD` (1.0 unit/tick), zero the inward component instead of reflecting. The sphere settles.

Any future impulse-based collision code (sphere-sphere, sphere-player after refactor) must replicate this pattern — it's the difference between "bounces and settles" and "never stops jittering."

### Center-inside-box fallback

When a block is placed around a sphere's center (or the sphere gets shoved inside), the closest-point distance is zero and the normal is undefined. Fallback: find the nearest AABB face, push out along that face normal. Rare in practice but critical when player is placing blocks at running enemies.

### World wrap is a cross-cutting concern

Three places in physics handle wrap:

1. **Sphere-vs-voxel**: block coords in the sphere's AABB may extend past world edges. `world.getBlock()` wraps internally, so `isSolid` returns correct values; positions stay in un-wrapped coords so the distance math works naturally.
2. **Sphere-vs-player**: player AABB gets shifted to the wrapped copy nearest the entity before the closest-point test. Without this, a sphere at the border can't bump the player on the other side.
3. **After collision, entity position is wrapped** to `[0, worldWidth)`. Matches the player's own position wrap. Prevents positions drifting to huge values that would break render offsets.

Any new "entity interacts with something" code needs to think about wrap. The pattern is always the same: shift the non-entity participant's position to the wrapped copy closest to the entity before doing geometry.

### Visual rolling is cosmetic only

Rolling rotation is accumulated into `entity.orientation` (a mat4) each frame, derived from horizontal velocity. **No angular physics.** Collisions don't change angular momentum, mass doesn't have a moment of inertia, rolling doesn't convert linear to angular. Spheres look like they roll but are internally point-masses with a rendered orientation.

When we eventually want real angular physics (tumbling cubes, spinning enemies after impact), it's a separable addition — add angular state, integrate torques, make collision response write to both linear and angular channels. Until then, the visual illusion is sufficient.

## Impactful decisions — AI

### Thrust + drag, not velocity-set

Rush AI applies **force** (acceleration per tick) toward the player, not a velocity vector. Combined with drag, this gives natural acceleration curves, a terminal speed, and turning inertia *for free*. Setting velocity directly would mean instant direction changes — unphysical and hard to tune.

Any new role that drives movement should apply forces, not set velocities. Velocity is owned by physics; AI suggests, physics integrates.

### Role is the dispatch axis

AI dispatches on `entity.role` via a switch. Rush, Zone, Crush, and future roles are peers — each is a separate function called based on the role field. Not OO inheritance, not function pointers stored per-entity, just a switch. Extends linearly.

Shape does NOT dispatch AI. A cube with Rush role would still run straight-line pursuit (once cube physics lands). Shape and role are independent axes per the taxonomy in `entity-system.md`.

### Mirror player physics constants

Rush uses the same drag values as the player (`GROUND_DRAG = 0.546`, `AIR_DRAG = 0.91`) and analogous acceleration (`RUSH_GROUND_ACCEL = 2.5` vs player's `GROUND_ACCEL = 3.0`). Terminal speed lands in the player's neighborhood — enemies feel relatable, not supernatural. Material's `baseSpeed` scales this multiplicatively, giving per-material feel (DarkMarble is faster than Marble).

### Mid-air steering enabled

Rush applies thrust in air too, just with a weaker `RUSH_AIR_ACCEL`. Matches how the player can adjust mid-jump. The alternative ("can only steer when grounded") is more physical but feels bad — if a player bumps a sphere off a ledge, the sphere should still turn toward the player after landing rather than falling in a fixed direction.

### Wrap-aware targeting

Direction to the player is computed wrap-aware: same shift-to-nearest-copy pattern used everywhere else. Without this, a sphere near the border chases the long way around the world.

## Cross-cutting patterns

### The material table is the central tuning surface

`materials: Record<Material, MaterialProperties>` in `entity.ts` is read by:

- **Spawn** — `texLayer`, `textureScale` for rendering
- **Physics** — `restitution` for bounces (`density` eventually for mass)
- **AI** — `baseSpeed` for thrust scaling (`hardness` eventually for damage resistance)

New stats should go here. New materials are a table row. This is the lever you'll pull most often when tuning.

### Wrap-aware geometry is a shared discipline

Every interaction between two things (entity-voxel, entity-player, block-placement-vs-entity) needs wrap-aware distance. The pattern is always the same: compute `dx = other.x - self.x`, then `if (dx > hw) dx -= ww; else if (dx < -hw) dx += ww`. Apply in both horizontal axes. Forget this and gameplay silently breaks near the world border.

### AI → Physics → Render ordering

Inside `EntityManager.update()`, each entity flows AI → physics → render in that order every frame. The ordering is load-bearing: AI writes velocity, physics reads + integrates, render reflects the new position. Swapping or interleaving breaks causality.

## Deferred by design

These have been explicitly put off; new work should respect these boundaries.

### Player is not an entity

`resolveSphereVsPlayer` treats the player as an immovable AABB — spheres bounce off, but player velocity is never modified. Asymmetric on purpose (see memory: `project_deferred_player_entity.md`). When enemy count / complexity makes uniformity worthwhile, the player becomes `Shape.Cube` (or Capsule), merges into the entity pipeline, and the sphere-vs-sphere impulse math gets implemented once and reused for sphere-vs-player.

Until then: don't add sphere→player impulse-back. It's throwaway code.

### Sphere-vs-sphere collision

Only relevant when multiple entities exist. The math is classical impulse-based rigid body:

```
j = -(1 + e) * vInward / (1/mA + 1/mB)
vA -= j * n / mA
vB += j * n / mB
```

When this lands, mass matters for the first time — time to decide whether `mass = density * size³` (realistic, but numbers blow up fast at large sizes) or a scaled alternative. The decision affects knockback feel across all material combinations.

### Mass-affected acceleration

Rush AI currently applies acceleration directly — heavy and light spheres accelerate at the same rate, only `baseSpeed` differentiates them. "Heavy feels ponderous" requires dividing thrust by mass. Meaningful only when multiple material types exist to compare; defer until that's testable.

### Pathfinding / obstacle avoidance

Rush is strict straight-line. Spheres push against walls they can't climb, forever. This is acceptable rusher behavior — the player reaching high ground is a valid escape. If a role needs actual navigation, that's new work (A* on the voxel grid, steering with local avoidance, etc.) — not an extension of Rush.

## Constants

Physics constants in `entity-physics.ts` — mostly mirror player values:

| Constant | Value | Matches player? |
|---|---|---|
| `MC_TICK` | 0.05 | Yes |
| `GRAVITY` | 0.8 | Yes |
| `TERMINAL_VELOCITY` | -39.2 | Yes |
| `NEGLIGIBLE` | 0.05 | Yes |
| `RESTING_THRESHOLD` | 1.0 | N/A (player doesn't need this) |
| `PLAYER_RESTITUTION` | 0.6 | Entity-only constant |
| `DEFAULT_BLOCK_RESTITUTION` | 0.3 | Entity-only constant |

AI constants in `entity-ai.ts`:

| Constant | Value | Rationale |
|---|---|---|
| `RUSH_GROUND_ACCEL` | 2.5 | Below player's 3.0 — rushers slightly slower than sprinting player |
| `RUSH_AIR_ACCEL` | 0.5 | Above player's 0.26 — enemies steer better in air (design choice) |
| `GROUND_DRAG` | 0.546 | Matches player |
| `AIR_DRAG` | 0.91 | Matches player |
| `MAX_H_SPEED` | 8 | Safety cap, well above natural terminal |
