# Cube Enemy — Design & Phasing

## Status

Forward-looking plan. The `Cube` shape exists as a stub in the entity Shape enum, and `Role.Zone` / `Role.Crush` are listed in `entity-ai.ts` dispatch as unimplemented cases. No mesh, no physics, no AI yet. Expected to span several sessions; this doc is the running reference.

## Concept (original notes)

The basic cube enemy works like so:

- To make them a little more visually distinct, we bevel the edges. There's an old branch that tried this with chunk meshes — may be useful reference.
- They move along the world axes, but they do **not** slide. Instead they "walk" — imagine a cube sitting flat on a table; to roll, it would rise up on an edge then fall on its side. This is not just cosmetic; the cube hit logic needs to take it into account.
- For cube-on-sphere collision, keep it simple: a cube is unmovable. Spheres collide with it like they do any block. It's a solid wall to them.
- Cubes can navigate in **any** direction — including up into the air.
- When climbing (no solid block to path on), the cube attempts to **create a block beneath itself**. If it fails, it cannot climb. Moving up may mean creating two blocks: one in front, then one atop that for the cube to climb onto. The exact sequencing is open.
- In practice, a cube does not roll fast. It's roll-over → pause → roll-over → pause, not a continuous tumble.

## Architectural fit

What's already in place that this design leans on:

- **Shape enum + mesh cache.** `EntityManager` keys its `Map<Shape, CachedMesh>` by shape, so adding a cube generator is purely additive — first `Cube` spawn runs the generator, subsequent spawns reuse the buffer. Same as spheres.
- **Entity render pipeline.** Already takes `pos+normal+uv` (32-byte stride). A beveled cube fits the same vertex format and pipeline. Smooth diffuse lighting already in the shader produces correct per-face shading on flat faces.
- **`entity.orientation` matrix.** Already exists for spheres' visual rolling. Naturally extends to cube tip animation — a tipping cube is just rotating around an edge.
- **`tryPlaceBlock` placement guard.** Already rejects placements that would crush an entity. Directly relevant: a cube trying to place a climb-block under another entity will fail, which is the desired behavior.
- **Material table.** Cubes pick up texture, density, restitution from the same table as spheres. A marble cube samples MARBLE; a brick cube samples BRICK. No new system needed.

## Phasing

### Phase 1 — Beveled cube mesh + static spawn

- New `src/cube.ts` mirrors `src/icosphere.ts`: pure function returning vertex data in the existing entity format (`pos+normal+uv`, 32-byte stride). Bevel radius is a parameter.
- Smooth normals across the bevel, hard normals at the flats → requires split vertices at the bevel/flat boundary. Non-indexed is fine (icosphere already established this pattern).
- Per-face planar UVs; bevels eat a sliver of texture along each edge. The entity shader's smooth diffuse lighting will produce per-face shading on the flats and a soft highlight along bevels — no shader changes needed.
- Spawn one in `main.ts` for visual verification. Walk around it from all angles.
- **Reference:** the old chunk-mesh bevel branch. Worth peeking at before starting; even if the geometry doesn't transfer 1:1 (chunks bevel cross-block edges, an entity bevels its own 12 edges), corner/edge math may save time.

### Phase 2 — Cube physics: gravity + AABB-vs-voxel, sphere bounces off cubes

- Cube-vs-world collision is AABB-vs-voxel, axis-separated — the same model the player uses. Don't reuse the sphere closest-point path; cubes have flat faces and corners, not radii.
- Sphere-vs-cube: extend the sphere narrowphase to include cube entities as additional AABBs. From the sphere's POV it's "a block at an arbitrary position." The cube treats sphere impacts as immovable — infinite-mass case of the existing impulse formula falls out cleanly (cube velocity unchanged, sphere reflects).
- No movement yet — cubes just fall and sit.

### Phase 3 — Tipping movement primitive ✅

Implemented. Resolved decisions:

- **State machine.** Two states: `idle` (`entity.tip === null`) and `tipping` (populated `TipState`). No separate settle phase — the commit step at `progress >= 1` folds the 90° rotation into `entity.orientation` and returns directly to idle.
- **Position snap.** Entity `x/y/z` snaps to the destination cell at tip start. `TipState` stores the pivot, source→pivot offset, rotation axis, and pre-tip orientation so the render transform can arc the cube visually from the source to the destination while the canonical position stays grid-aligned. Keeps physics and pair collision simple (they see a stable post-snap position, though pair checks are skipped for tipping cubes regardless).
- **Composite transform.** `M = T(pivot + wrap) · R(axis, θ) · T(sourceOffset) · baseOrientation · S(scale)`. Wrap offset is absorbed into the outermost translation to match horizontal world wrapping. `sourceOffset = sourceCenter − pivot` is `(−dx·s, s, −dz·s)` for the 4 axis-aligned directions. Rotation axis is `cross(up, direction) = (dz, 0, −dx)`; 90° around this maps `+Y → direction` (top face becomes the leading face).
- **Mid-tip collision: Option A.** Tipping cubes skip physics entirely (no gravity, no voxel collision) and are excluded from sphere-vs-cube pair resolution — spheres pass through them for the ~0.4s arc. The cheat is brief and the alternative (swept AABB across the arc) isn't worth the complexity until a concrete gameplay case demands it.
- **Feasibility check.** Rejects a tip if any destination cell is solid, or if any cell directly below the destination footprint is air (nothing to land on). Failed tips log `console.warn` — debug-only for now, AI will just pick a different direction.
- **Tip duration.** `TIP_DURATION = 0.4` seconds, linear easing. Ease-in/out deferred — easy swap inside `advanceCubeTip`.
- **AI integration.** Not wired yet. Debug trigger: `KeyT` keybind calls `EntityManager.tipAllCubesTowardPlayer`, which picks the dominant horizontal axis from each cube to the player and calls `startCubeTip`.
- **Textures tumble with the cube.** `baseOrientation` is captured at tip start and composed into the transform; the final rotation folds into `entity.orientation` at commit. Directional textures (brick) rotate with the cube across tips — intended.
- **Corners intentionally excluded.** Only the 4 axis-aligned edge pivots; no diagonal / corner tipping.

### Phase 4 — Navigation + climbing

**Horizontal walk + auto-scaffold (in progress).** `EntityManager.tryTipCube` wraps `startCubeTip` with a scaffolding step: before delegating to the physics primitive, it fills any air cells in the N³ region directly beneath the destination with the cube's own material (dark-marble cube → DARK_MARBLE blocks, etc.). Two-phase commit — validate all scaffold cells against entity overlap first, then mutate + remesh together. If any cell would crush an entity, the whole tip stalls; no partial scaffold. `onBlockChanged` is passed in by the caller (matches the `autoClimb` pattern) and gets one call per placed block.

Simplifications kept per spec:

- Always places the full N³ sub-cube, even when only N×N×1 is geometrically needed — deep pits get filled in. Simpler than calculating the minimal fill, and the "cube leaves a trail" look is intentional.
- Existing solid blocks beneath destination are never overwritten. Only air cells become scaffold.
- Scaffold is free (no BP cost). Deferred until the economy needs it.

Debug trigger still `KeyT` — calls `tipAllCubesTowardPlayer` which now routes through `tryTipCube`. No autonomous AI cadence yet; will add per-cube idle timer + direction-selection once scaffold is playtested.

**Climbing (done).** Climb is a 180° single-rotation tip around the top-forward edge of the adjacent wall (shared with the cube's top-leading edge) — a handspring arc. `direction` now carries a `dy` component: `dy=0` is horizontal (90°), `dy=1` is climb (180°). `startCubeTip` branches on dy for pivot Y offset (`-s` horizontal, `+s` climb), sourceOffset Y (inverted), and `endAngle` (π/2 vs π). The rotation axis and destination-beneath scaffold formula are identical — the N³-beneath-destination region is "the ground" for horizontal and "the wall" for climb, and filling its air cells handles both "fill pit" and "complete/create wall" cases with no special-casing.

`tipAllCubesTowardPlayer` now uses a greedy climb fallback: try horizontal first, fall back to climb in the same direction if horizontal is blocked (typically by a wall). Fallback succeeds whenever the upper destination cells are clear.

Intentional geometry note: the 180° arc sweeps the cube up and over through a peak ~s·√2 above the pivot before landing on top of the wall. Reads as a handspring / pole-vault motion. Option A (tipping cubes non-collidable) hides any awkwardness during the arc. Revisit with easing curves or split-primitive climbs if the motion looks bad in playtest.

**Option-A vertical zigzag (done).** A single edge-pivot tip can't land straight up (any arc around a cube edge ends horizontally displaced from the start), so "pure vertical climb" is achieved by alternating climb directions: tip east-up, then west-up, netting +2·edge vertical and zero horizontal across each pair. Per-cube state `lastClimbDx/Dz` tracks the most recent climb's horizontal direction and gets flipped on the next vertical-intent tip. Both-zero state means "never climbed" — the first climb seeds direction from the dominant horizontal axis to the player. Only climb tips (dy=1) update `lastClimbDx/Dz`; horizontal walks leave it alone so the zigzag resumes intact after a detour.

`tipAllCubesTowardPlayer` now branches: player Δy > edge → vertical-intent mode (alternating climb); otherwise horizontal walk with same-direction climb fallback. Scaffold trail roughly doubles compared to a single-direction climb (pillars on alternating sides), which is the visible cost of staying within the tipping aesthetic rather than adding a separate pillar-jump primitive.

**Still to do:**

- Cross-axis horizontal fallbacks (if the preferred axis is blocked both horizontal and climb, try the other axis).
- Autonomous AI cadence — per-cube idle timer so cubes tip every ~1s rather than on debug key.

### Phase 5 — Roles on top

- `Role.Zone` and `Role.Crush` become **targeting strategies** layered on the same movement primitive — they don't reimplement movement.
- Zone: pick cells around the player to wall them in.
- Crush: pick cells above the player and try to drop on them.

## Open questions (resolve per-phase, not up front)

- **Cube size.** Always 1 block, or scaled like spheres? 1 block is much simpler — navigation is grid-cell-based. Bigger cubes need multi-cell footprint reasoning. Default: 1 block, revisit if the design wants variety.
- **BP cost for cube-placed blocks.** Do cubes spend BP to scaffold? Free is simpler; costing BP creates a resource economy where the player can starve a cube by denying terrain.
- **Mid-tip collision.** Phase 3 decision. See options above.
- **Multiple cubes on the same path.** Two cubes wanting the same destination cell — first-come-first-served, or some negotiation? Probably ignore until it actually happens.
- **Cube-vs-cube collision.** Two stationary cubes occupying adjacent cells is fine. Two tipping cubes converging on the same cell — Phase 3/4 problem.

## Why this phasing

Phase 1 is bounded and visually verifiable on its own — proves the entity render pipeline handles non-spherical shapes without committing to any of the harder downstream decisions. Each subsequent phase keeps physics, animation, and AI as independent layers, so a half-built cube is always in a runnable state (it falls but doesn't move, then it tips but doesn't path, then it paths but doesn't climb). No phase requires the next to be functional.
