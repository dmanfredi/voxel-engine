# Sticky Spheres

## What we landed on

All spheres are sticky-by-default: they cling to any voxel surface and pursue the player in 3D across floors, walls, ceilings, and around convex edges. No trait gate.

Three mechanisms in `src/sphere-physics.ts`:

1. **Gravity gated by `attached`** — off whenever the sphere is in contact with any surface; on the instant contact is lost.
2. **Contact shell (`SHELL = 0.5`)** — the resolver depenetrates only on real overlap, but records `attached` + contact normal for any block within `r + SHELL`. Without this a resting sphere oscillates frame-to-frame (gravity-dip → resolver-push-out → no-overlap → gravity-dip ...) and AI thrust gets sabotaged on alternate frames.
3. **Snap-back projection (`SNAP = 4`)** — after the per-voxel resolver, `applySnap` projects the center to exactly `r` from the closest solid in a wider band, zeroing normal-component velocity. Bends the trajectory around convex edges — rolling off a platform lip arcs around the corner instead of detaching into air.

AI lives in `rushAttached` (`entity-ai.ts`): thrust toward the player projects onto the contact tangent plane, drag applies on all three axes (without vy drag, climbing with no gravity would let vy grow unbounded).

## Why sticky-by-default rather than opt-in

Spheres started as physics-y rolling objects with an optional `Sticky` trait. We removed the trait and made the climb behavior the default.

- **Realistic spheres create edge cases.** Falling off ledges, hesitating at corners, getting stuck under overhangs — every "but what if the sphere..." costs design and code.
- **Designable threats beat emergent threats.** A sphere that always climbs is predictable for both player and AI to reason about.
- **Heavy-feel survives.** Mass-scaled accel/drag still gives "heavy turns slowly" without needing momentum loss in awkward places.

`Reckless` (an explicit opt-out variant that would fall off ledges) is deferred until a specific gameplay case asks for it.

## Why snap-back instead of a full kinematic constraint

A "true sticky" model would put the sphere on an offset surface and solve a kinematic constraint every frame (center always exactly `r` from the closest solid). The snap-back patch is a strict subset: project center back, but only when the sphere was attached last frame, and only as a final pass on top of the existing per-voxel resolver.

What we get: continuous attachment across convex edges, momentum (`vx, vy, vz` and mass-scaled accel) survives intact, no rewrite of sphere-vs-cube or sphere-vs-sphere impulse paths.

If we hit behaviors the patch can't produce — concave-corner weirdness at speed, saddle-point jitter, etc. — graduate to the full constraint with a concrete bug list driving the rewrite. Don't speculatively rebuild.

## The `preAttached` gate

`applySnap` always projects position and zeros normal velocity. It only writes `attached`/`grounded`/`contactN*` when `preAttached === false` (i.e., the per-voxel resolver found nothing this frame, so snap is the sole source of contact info).

This matters at concave wedges. Sphere pressed into floor + wall: per-voxel resolver sums `(0,1,0) + (-1,0,0)` → `(-0.71, 0.71, 0)` diagonal-out. AI thrust toward the player above keeps a +Y tangent component → climb.

Without the gate, snap's single-closest-point would arbitrarily collapse the multi-surface contact to whichever block won the bx/by/bz iteration tiebreak (the floor, in practice). AI projects onto a floor-only tangent plane → +Y killed → sphere pushes horizontally into the wall, can't climb.

Single-closest-point is still right at convex edges (only one block is "the corner"), so snap still writes contact state in that case — `preAttached` is correctly false because the resolver's `r + SHELL` band has been left.

## Drop-zone (overhead un-stick)

Sticky-by-default has a failure mode: a sphere that climbs up and over the player clings to whatever surface it's on instead of dropping. The player can exploit it by air-gapping — stay below an overhang and the sphere hangs above.

The fix is a **drop-zone**: a vertical cylinder above the player (radius `DROP_ZONE_RADIUS_BLOCKS`, unbounded in height). Inside it, `entityPhysicsTick` makes two changes, because two different mechanisms pin a sphere depending on the surface it's stuck to:

1. **Skip `applySnap`** — the **ledge-top** case. Snap-back is the only thing arcing a sphere back under a convex edge; without it the sphere carries off the lip, loses contact, and falls.
2. **Force gravity even while `attached`** — the **directly-overhead / ceiling** case, where the sphere is held by the real per-voxel resolver (not snap-back), so skipping snap does nothing. This rides an asymmetry: on a ceiling/lip the pull is *away* from the surface, so the resolver records the shell contact but doesn't cancel the velocity (`penetration <= 0` → early return) and the sphere accelerates off; on a floor the pull is *into* the surface, the resolver zeroes it, and a resting sphere in the zone is unaffected (modulo a sub-pixel dip-and-correct jitter).

Why overhead needs gravity rather than snap suppression: with the player directly below, the pursuit direction is parallel to the contact normal, so `rushAttached`'s tangent projection collapses to ~zero. The sphere can't slide along the surface to escape and the shell keeps gravity gated off — a stable hover that only a downward force breaks.

"Above" is measured against the player's eye, so a sphere merely level with the player keeps full stickiness (it's about to reach them anyway). The trigger is a cylinder, not a cone, on purpose: a cone's radius grows with height, committing off-axis spheres to long plunges from overhead; the cylinder keeps the trigger tight and predictable.

## Constants

| Constant                 | Value | Rationale                                                                     |
| ------------------------ | ----- | ----------------------------------------------------------------------------- |
| `SHELL`                  | 0.5   | Stable resting band; per-frame integration error is ~0.5 at terminal velocity |
| `SNAP`                   | 4     | Convex-edge wrap radius; ~30× the per-frame drift at v=8                      |
| `DROP_ZONE_RADIUS_BLOCKS`| 3     | Overhead un-stick cylinder; small so only spheres genuinely above you drop    |

## Deferred

- **Pathfinding.** Tangent-projected straight-line pursuit. Pursues around corners and walls but won't find non-obvious routes. Flow fields were sketched and reverted — premature without a confident movement profile.
- **Graduated detach.** Currently any motion that clears `SNAP` in one frame detaches. Sphere-sphere bonks and cube tips do this naturally. If we want bump-vs-launch differentiation, add a per-impulse normal-velocity threshold.
- **`Reckless` trait.** Opt-out variant that falls off ledges. Add only when a specific scenario asks for it.
