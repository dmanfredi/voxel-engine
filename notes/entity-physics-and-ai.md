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

## Mass derivation

Every sphere has a mass, computed once at spawn from its material's density and its size:

```
mass = (density * size^MASS_SIZE_POWER) / NORMALIZATION
```

Normalized so a reference sphere (density 2, size 10 — roughly player-height modal size) has mass = 1. This keeps the AI base constants interpretable: a `mass = 1` sphere uses them as written; heavier/lighter spheres scale them.

**The power matters.** `n = 2` (current) vs `n = 3` (volumetric, physically honest) determines how aggressively size influences mass. With n=3, doubling size means 8× heavier; with n=2, 4×. We picked 2 after finding 3 too dramatic at the size range we use (3–30). It's a one-line change in `entity.ts` if we want to revisit.

**What mass scales:**

- Thrust acceleration in Rush AI (`a = F/m`)
- Drag time constant in Rush AI (`drag^(1/m)` — heavy decelerates slowly)
- Sphere-vs-sphere collision impulse and depenetration

**What mass does NOT scale:**

- Gravity — physically correct (all masses fall identically in vacuum). If we want air-resistance differentiation later, that's separate.
- Sphere-vs-voxel bounces — the wall has infinite mass, so the impulse formula `j = -(1+e)v / (1/m + 1/∞)` reduces to `dv = -(1+e)v` regardless of sphere mass. Real physics matches gameplay here.

`mass` is cached on Entity at spawn (alongside `restitution`) so hot paths don't re-look-up the materials table per frame.

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

Four places in physics handle wrap:

1. **Sphere-vs-voxel**: block coords in the sphere's AABB may extend past world edges. `world.getBlock()` wraps internally, so `isSolid` returns correct values; positions stay in un-wrapped coords so the distance math works naturally.
2. **Sphere-vs-player**: player AABB gets shifted to the wrapped copy nearest the entity before the closest-point test. Without this, a sphere at the border can't bump the player on the other side.
3. **Sphere-vs-sphere**: vector from B to A is wrap-adjusted to the nearest copy before computing contact normal and depenetration. Two spheres on opposite sides of the boundary collide correctly.
4. **After collision, entity position is wrapped** to `[0, worldWidth)`. Matches the player's own position wrap. Prevents positions drifting to huge values that would break render offsets.

Any new "entity interacts with something" code needs to think about wrap. The pattern is always the same: shift the non-entity participant's position to the wrapped copy closest to the entity before doing geometry.

### Visual rolling is cosmetic only

Rolling rotation is accumulated into `entity.orientation` (a mat4) each frame, derived from horizontal velocity. **No angular physics.** Collisions don't change angular momentum, mass doesn't have a moment of inertia, rolling doesn't convert linear to angular. Spheres look like they roll but are internally point-masses with a rendered orientation.

When we eventually want real angular physics (tumbling cubes, spinning enemies after impact), it's a separable addition — add angular state, integrate torques, make collision response write to both linear and angular channels. Until then, the visual illusion is sufficient.

### Sphere-vs-sphere collision

Pair resolution lives in `resolveSpherePair(a, b, ww)`, called once per frame per (i,j) pair from `EntityManager.update()` after solo physics ticks. Single resolution pass — no iterative solver. Dense piles may jitter; rare in current gameplay.

**Three-pass update structure.** Splitting `EntityManager.update()` into (1) per-entity AI+physics, (2) all-pairs sphere-sphere, (3) per-entity render upload means each pair sees finalized post-integration positions on both sides. Resolving pair-by-pair inside the per-entity loop would be order-dependent and asymmetric.

**Mass-weighted depenetration.** Each sphere is pushed back along the contact normal by a share inversely proportional to its mass: `aPush = penetration * (1/mA) / (1/mA + 1/mB)`. Heavy moves less. A size-15 DarkMarble vs a size-5 Marble means the small one gets bullied across the contact.

**Impulse-based velocity response.** Standard rigid-body formula:

```
j = factor * inwardSpeed / (1/mA + 1/mB)
dvA = (j/mA) * n
dvB = -(j/mB) * n
```

Where `factor = 1 + max(eA, eB)` for bouncing, or `factor = 1` for resting contact (zero inward component, no bounce). Resting threshold reused from wall contacts (`RESTING_THRESHOLD = 2.0`) — same micro-jitter prevention.

**Momentum conservation.** Equal-and-opposite impulse on both spheres: `mA*dvA + mB*dvB = 0`. Falls out of the impulse derivation; no special-casing needed.

**Center-coincidence fallback.** When `dist² < 1e-6` (centers at the same point — happens if two spheres spawn on top of each other), we synthesize an up-pointing normal. The first frame separates them; subsequent frames use the real normal.

**Grounded flag inheritance.** A sphere stacked atop another gets `grounded = true` (when the contact normal points substantially upward, `n.y > 0.5`). Lets the AI use ground-state thrust/drag while balanced on another sphere. Symmetric for the bottom sphere if `n.y < -0.5`.

**Why no broad phase.** O(n²) over <20 entities is sub-microsecond per frame. When we get into many-enemy scenarios, swap the pair loop for a uniform-grid hash. Won't change `resolveSpherePair` itself — only how it's invoked.

**What's not modeled:** angular momentum exchange (oblique hits don't induce spin), rolling friction, deformation. The `updateRolling` cosmetic rotation continues to be visual-only.

## Impactful decisions — AI

### Thrust + drag, not velocity-set

Rush AI applies **force** (acceleration per tick) toward the player, not a velocity vector. Combined with drag, this gives natural acceleration curves, a terminal speed, and turning inertia *for free*. Setting velocity directly would mean instant direction changes — unphysical and hard to tune.

Any new role that drives movement should apply forces, not set velocities. Velocity is owned by physics; AI suggests, physics integrates.

### Role is the dispatch axis

AI dispatches on `entity.role` via a switch. Rush, Zone, Crush, and future roles are peers — each is a separate function called based on the role field. Not OO inheritance, not function pointers stored per-entity, just a switch. Extends linearly.

Shape does NOT dispatch AI. A cube with Rush role would still run straight-line pursuit (once cube physics lands). Shape and role are independent axes per the taxonomy in `entity-system.md`.

### Reference-sphere base constants, mass-scaled per entity

Rush base constants (`RUSH_GROUND_ACCEL = 1.0`, `GROUND_DRAG = 0.9`, etc.) describe the _reference_ sphere — mass = 1, the size-10 density-2 archetype. They sit in the player's neighborhood by design: a reference sphere accelerates and turns at roughly player rates, so enemies feel relatable when you encounter the typical case.

Per-entity, mass scales these constants in opposite directions on the velocity curve:

- `effectiveAccel = baseAccel * baseSpeed / mass` (heavy ramps up slowly)
- `effectiveDrag = baseDrag^(1/mass)` (heavy decelerates slowly)

Terminal speed stays roughly mass-invariant; only the time constant changes. So a heavy DarkMarble eventually catches up to a light Brick — it just takes longer to get there and longer to stop. Material's `baseSpeed` is now a per-material "how hard the sphere pushes" knob, orthogonal to mass: a sluggish-but-eager material can have low density and low baseSpeed; a powerful-but-ponderous one can have high density and high baseSpeed.

### Mid-air steering enabled

Rush applies thrust in air too, just with a weaker `RUSH_AIR_ACCEL`. Matches how the player can adjust mid-jump. The alternative ("can only steer when grounded") is more physical but feels bad — if a player bumps a sphere off a ledge, the sphere should still turn toward the player after landing rather than falling in a fixed direction.

### Wrap-aware targeting

Direction to the player is computed wrap-aware: same shift-to-nearest-copy pattern used everywhere else. Without this, a sphere near the border chases the long way around the world.

## Cross-cutting patterns

### The material table is the central tuning surface

`materials: Record<Material, MaterialProperties>` in `entity.ts` is read by:

- **Spawn** — `texLayer`, `textureScale` for rendering; `density` and `restitution` cached on Entity (as `mass` and `restitution`) so hot paths don't re-look-up the table per frame
- **Physics** — `entity.restitution` for wall and pair bounces; `entity.mass` for sphere-sphere depenetration and impulse
- **AI** — `baseSpeed` for thrust scaling; `entity.mass` divides effective accel and dilates the drag time constant

New stats should go here. New materials are a table row. This is the lever you'll pull most often when tuning. `hardness` is reserved for future damage resistance.

### Wrap-aware geometry is a shared discipline

Every interaction between two things (entity-voxel, entity-player, block-placement-vs-entity) needs wrap-aware distance. The pattern is always the same: compute `dx = other.x - self.x`, then `if (dx > hw) dx -= ww; else if (dx < -hw) dx += ww`. Apply in both horizontal axes. Forget this and gameplay silently breaks near the world border.

### AI → Physics → Render ordering

Inside `EntityManager.update()`, each entity flows AI → physics → render in that order every frame. The ordering is load-bearing: AI writes velocity, physics reads + integrates, render reflects the new position. Swapping or interleaving breaks causality.

## Deferred by design

These have been explicitly put off; new work should respect these boundaries.

### Player is not an entity

`resolveSphereVsPlayer` treats the player as an immovable AABB — spheres bounce off, but player velocity is never modified. Asymmetric on purpose (see memory: `project_deferred_player_entity.md`). When enemy count / complexity makes uniformity worthwhile, the player becomes `Shape.Cube` (or Capsule), merges into the entity pipeline, and the sphere-vs-sphere impulse math gets implemented once and reused for sphere-vs-player.

Until then: don't add sphere→player impulse-back. It's throwaway code.

### Pathfinding / obstacle avoidance

Rush is strict straight-line. Spheres push against walls they can't climb, forever. This is acceptable rusher behavior — the player reaching high ground is a valid escape. If a role needs actual navigation, that's new work (A* on the voxel grid, steering with local avoidance, etc.) — not an extension of Rush.

## Constants

Physics constants in `entity-physics.ts` — mostly mirror player values:

| Constant                    | Value | Matches player?                          |
| --------------------------- | ----- | ---------------------------------------- |
| `MC_TICK`                   | 0.05  | Yes                                      |
| `GRAVITY`                   | 0.8   | Yes (mass-independent — real physics)    |
| `TERMINAL_VELOCITY`         | -39.2 | Yes                                      |
| `NEGLIGIBLE`                | 0.05  | Yes                                      |
| `RESTING_THRESHOLD`         | 2.0   | Wall AND sphere-sphere contacts          |
| `PLAYER_RESTITUTION`        | 0.6   | Entity-only                              |
| `DEFAULT_BLOCK_RESTITUTION` | 0.3   | Entity-only                              |

AI constants in `entity-ai.ts` — these are **base** values; per-entity, accel is divided by `mass` and drag is exponentiated by `1/mass`:

| Constant            | Value | Rationale                                                    |
| ------------------- | ----- | ------------------------------------------------------------ |
| `RUSH_GROUND_ACCEL` | 1.0   | Base; reference-sphere accel sits near player feel           |
| `RUSH_AIR_ACCEL`    | 0.5   | Base; mid-air steering still allowed                         |
| `GROUND_DRAG`       | 0.9   | Base; per-tick decay = `0.9^(t/mass)`                        |
| `AIR_DRAG`          | 0.91  | Base; same exponentiation                                    |
| `MAX_H_SPEED`       | 8     | Safety cap, well above natural terminal                      |

Mass constants in `entity.ts` — derive `mass` from material density and entity size at spawn:

| Constant                  | Value | Rationale                                                          |
| ------------------------- | ----- | ------------------------------------------------------------------ |
| `MASS_SIZE_POWER`         | 2     | Size exponent; raise to 3 for volumetric (more dramatic) scaling   |
| `MASS_REFERENCE_SIZE`     | 10    | Normalization — size-10 density-2 sphere has mass = 1              |
| `MASS_REFERENCE_DENSITY`  | 2     | Same                                                               |
