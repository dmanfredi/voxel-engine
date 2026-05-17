# Flow Field

## What we landed on

A 3D BFS distance field anchored at the player's eye cell, refreshed when the player crosses a voxel boundary or terrain inside the field changes. Sphere AI samples the gradient at an offset point (halfway toward the contact surface when attached) to choose a pursuit direction. Falls back to wrap-aware direct delta when the entity is outside the field, in an unreachable cell, or the gradient is degenerate.

Three modules:

- **`src/flow-field.ts`** — `FlowField` class. Solidity cache, near-surface dilation, BFS, central-difference gradient sampling.
- **`src/entity-ai.ts`** — `rush()` computes the sample point, reads the gradient, falls back if needed.
- **`src/entity.ts`** — `EntityManager` owns one shared field, refreshes it per tick, exposes `invalidateFlowField()` for terrain mutations.

`tryPlaceBlock`, the left-click break path, the cube scaffold path, and auto-climb all invalidate after world writes. Pathfinding handles terrain edits on the next tick.

## Why flow field rather than per-agent A\*

All spheres share a target (the player). A single BFS produces directions every sphere reads in O(1). Per-agent A\* would re-pay search cost for each sphere; flow field amortizes one O(V) build across N agents.

A\* still beats flow fields when N is small and search spaces are huge, or when agents need different goals. Neither applies for us. Future roles (zone, ranged) can read the _same_ field with different interpretations — sample distance, invert gradient, etc. — without their own searches.

## Why cell-based BFS with Chebyshev-K dilation

The naive "BFS through air cells" floods deep open shafts where surface-bound spheres can't actually follow the gradient. The naive "BFS through air cells with any solid 6-cardinal neighbor" can't wrap convex edges — to step "over a pillar lip" cardinally, BFS has to pass through an air cell whose 6-neighbors are all air, and the filter rejects it. The sphere ends up stranded on top of the pillar with the gradient invisible.

The fix is a Chebyshev-K dilation: a cell is sphere-pathable iff it's air AND any solid block sits within a (2K+1)³ cube around it. The cube captures diagonal neighbors of convex corners, so BFS can cardinally step over them. `K = max(1, ceil(maxSphereRadius / blockSize))`.

A face-graph (one node per exposed voxel face) would handle the topology more rigorously but multiplies data by ~6× and adds bookkeeping. Cubic dilation is a strict subset — same effect at the corners that matter, much less code.

## The offset-sample (load-bearing detail)

A sphere of radius `r` attached to a wall has its center exactly `r` from the contact surface. For `r ≈ blockSize`, the center cell can sit _two_ Chebyshev cells from the solid (sphere on flat ground is the canonical case — contact at the block's top face, center at `(Y+2)*blockSize`, solid cell at `Y`). K=1 dilation doesn't cover it; `sampleDirection` returns UNREACHABLE; AI falls back to direct rush.

The fix: when attached, sample the field at `sphere.center - contactN * blockSize/2` rather than at the center. The sample point is ½ a blockSize from the contact surface along the inward normal — its cell is guaranteed Chebyshev ≤ 1 from a solid. K=1 then covers every attached geometry: flat ground, wall, concave wedge, convex edge, 3D vertex.

Airborne spheres sample at center — no contact normal, and they pursue horizontally anyway.

## The off-by-one we removed

The coord conversion in `sampleDirection` originally used `(centerBX + 0.5) * blockSize` as the reference, which shifted `floor` by half a cell. Sphere positions in the lower half of any cell rounded to cell-1 instead of the correct cell, so the lookup was reading the wrong grid entry. Symptoms were intermittent: sometimes the wrong cell happened to be reachable too and the AI looked fine, sometimes it didn't and the fallback fired. Fixed by referencing the cell's _left edge_ (`centerBX * blockSize`).

If you're tempted to add a `+0.5` here for "centered" semantics — don't. The cell-index lookup wants left-edge alignment.

## Constants

| Constant      | Value    | Rationale                                                                            |
| ------------- | -------- | ------------------------------------------------------------------------------------ |
| `FLOW_RADIUS` | 24 cells | 49³ ≈ 117K cells per BFS. Comfortable on the main thread at current density.         |
| `K` dilation  | ≥ 1      | Smallest band that wraps convex corners; auto-grows with max sphere radius in cells. |

## Deferred

- **Long-range pursuit.** Spheres outside the 24-cell field fall back to direct rush. Fine for distant enemies that aren't visually scrutinized. If long-range stalemates show up, a coarse second field at 4× block size (same V budget, ~64× volume) is cheaper than HPA\* and probably enough.
- **Worker offload.** BFS runs synchronously on the main thread. Profile says fine for now; revisit if it shows up as hitches with denser terrain or larger radius.
- **Per-role consumption.** Field is currently consumed only by `Role.Rush`. Zone/Crush will read the same field with different semantics when implemented.
- **Incremental updates.** Any terrain edit invalidates the whole field. Sandbox build-heavy moments could thrash; partial-update algorithms (D\*/LPA\*) would help, but the current cost isn't bad enough to justify the complexity.
