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

### Phase 3 — Tipping movement primitive

- Discrete state machine: `idle → tip → settle → idle`. While tipping, `entity.orientation` interpolates the rotation around the pivot edge.
- Position is grid-aligned at rest. During a tip, the rendered position arcs around the pivot, but the canonical `x/y/z` should probably **snap to the destination cell at tip start and animate rotation only**, rather than tracking arc position. Simpler.
- Mid-tip collision behavior is the open question:
  - Option A: cube is non-collidable to spheres mid-tip (brief, simple, slightly cheaty)
  - Option B: swept AABB across the arc
  - Defer until we're actually animating one.
- AI not wired yet — drive a tip via debug key to validate the animation feels right.

### Phase 4 — Navigation + climbing

- Direction selection toward player (one of 6 axes per step). Walk if the destination cell is empty and the cell beneath the destination is solid.
- If the destination beneath is empty: try `tryPlaceBlock` to place a scaffold block. If accepted, walk. If rejected (entity in the way), blocked → the cube stalls. Stalling is a feature.
- Going up: needs the "place forward, then place above forward" sequence. Probably two consecutive ticks of the state machine — first tick places the side block (turning a horizontal step into a wall to climb), next tick triggers the climb-up sequence.

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
