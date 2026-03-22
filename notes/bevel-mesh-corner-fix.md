# Bevel Mesh Corner Fix

## Summary

The visible blue gaps were real holes in the generated triangle mesh, not a shader problem.

The original bevel mesher made bevel decisions at whole-edge granularity:

- an edge was considered beveled if both adjacent faces were exposed
- and the edge-diagonal voxel was air

That worked for simple convex cases, but it broke at concave edge endpoints and more complex multi-block corner arrangements.

## Root Cause

### 1. Whole-edge decisions were too coarse

The original logic stored bevel state in `edgeBev[fA][fB]`.

That means the code answered this question:

"Should this entire edge be beveled?"

But the failing cases needed a different question:

"Should this specific endpoint of this edge be beveled?"

In a simple 3-block `L` shape, an edge can be valid in the middle but terminate into a concave notch at one end. The old code still inset both face corners as if the bevel extended cleanly to both ends. That produced open gaps where face quads, chamfer quads, and corner caps no longer met.

### 2. Tapered chamfers were still emitted as quads

Once beveling became endpoint-sensitive, some chamfers naturally collapsed to a point at one end.

The old chamfer code still emitted these as 2-triangle quads. In those cases:

- one triangle became degenerate
- the remaining triangle could wind the wrong way
- backface culling then made the geometry disappear from only one side

This is why some holes only appeared from one view direction in wireframe.

### 3. Rare saddle cases had no local owner

After fixing endpoint ownership, there were still rare neighborhood configurations where three boundary edges formed a triangular hole but no single block naturally emitted the missing cap.

These were not the common `L`-shape failures, but they did show up in broader random neighborhood testing.

## Fix

### 1. Endpoint-aware bevel state

Added `edgeEndBev[fA][fB][end]` to track bevel validity per edge endpoint instead of only per edge.

Each endpoint now checks:

- the two faces that define the edge
- the third face at that endpoint
- the corner-diagonal voxel at that endpoint

This lets a bevel continue at one end and collapse at the other, which is required for concave notch cases.

Face corner inset now uses endpoint-aware queries instead of whole-edge flags.

### 2. Tapered chamfers become triangles

Added a `writeTriangle(...)` helper for oriented triangle emission.

If a chamfer collapses at one end:

- emit one triangle instead of a fake 2-triangle quad

If both ends remain distinct:

- emit the normal chamfer quad

This removed degenerate triangles and fixed the one-sided disappearing geometry.

### 3. Corner caps use endpoint-aware checks

Corner cap generation now requires all three participating edge endpoints at that exact corner to be valid, instead of relying on coarse whole-edge bevel flags.

That keeps caps aligned with the updated face and chamfer geometry.

### 4. Final triangular-hole repair pass

Added a final post-pass over the generated mesh:

- count undirected triangle edges
- any edge seen once is a boundary edge
- if three boundary edges form a closed triangular loop, emit a repair triangle

The repair triangle uses:

- a normal derived from the loop geometry and surrounding normals
- averaged AO from the boundary vertices
- the most common texture layer among those vertices

This is a safety net for rare saddle cases that are awkward to assign to one block during local generation.

## Validation

The fix was tested at the triangle-mesh level, not just visually.

I compiled the mesher and ran it against synthetic voxel neighborhoods, then checked:

- closed topology
  - every undirected edge should appear exactly twice
- no degenerate triangles
  - triangle area must be non-zero
- correct winding
  - geometric triangle normal should agree with the stored shading normal

### Deterministic test cases

These hand-built cases were checked:

- isolated block
- 2-block line
- `2x2` plate
- `2x2x2` cube
- 3-block `L`
- 3-axis corner cluster
- stair-step arrangement

The original version already failed on the 3-block `L`, which made the problem reproducible in a minimal case.

### Random sampling

After the endpoint and tapered-chamfer fixes, I ran random `3x3x3` occupancy samples.

That found one remaining saddle-case triangular hole, which led to the repair pass.

After the repair pass:

- 500 random sampled neighborhoods passed
- no open boundary edges
- no flipped triangles
- no degenerate triangles

### Project checks

The final version also passed:

- `npm run typecheck`
- `npm run build`

## Notes

One earlier attempted fix was discarded because it changed the geometry too aggressively and produced visibly incorrect triangulation. The final fix instead addresses the actual ownership and winding issues:

- endpoint-aware bevel ownership
- tapered chamfer triangulation
- exact-corner cap validation
- final repair pass for rare triangular holes
