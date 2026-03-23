# Shader-Based Bevel (Current Approach)

After extensive attempts at geometry-based beveling (see notes 01-05), we landed on a
fragment shader approach that fakes beveled edges by perturbing normals. It produces a
visually similar result with none of the mesh complexity.

## Why Not Geometry Beveling

The geometry approach (modifying the greedy mesher to emit chamfered edges) ran into
compounding problems:

- **Corner topology** — where 3 beveled edges meet at a block corner, you need carefully
  constructed triangles to fill gaps. Every fix for one case broke another.
- **Greedy mesh interaction** — bevels break greedy merging. Faces can no longer merge
  freely because bevel geometry at block boundaries differs based on neighbor topology.
  This increases vertex count significantly.
- **Boundary cases** — chunk boundaries, world edges, and mixed block types all need
  special handling. The combinatorial explosion of edge cases was the real killer.

The bevel size we actually wanted was subtle — about 0.4 world units on a 10-unit cube
(4%). At that scale, the visual difference between real geometry and faked normals is
negligible. The shader approach was the clear winner.

## How It Works

### The Core Idea

For each fragment, compute how close it is to a block edge. Near edges, tilt the surface
normal to simulate a chamfer. The existing per-face lighting then naturally darkens/lightens
the bevel region. No geometry changes, no extra vertices, no mesh changes at all.

### Geometry-Aware Neighbor Checks (3D Voxel Map)

The first version beveled every block boundary — including where two solid blocks sit
flush against each other. This looked wrong (grid lines everywhere on flat surfaces).

The fix: a `r8uint` 3D texture (`voxelMap`) that stores solid/air for every block in the
world. The fragment shader samples it to check neighbors:

- **Exposed edge** (neighbor is air) → apply bevel. This is a convex edge where the
  surface turns a corner.
- **Internal edge** (neighbor is solid) → no bevel. The surface continues flat or the
  edge is concave.

This correctly bevels only the visible silhouette edges of the geometry.

### Fragment Shader Walkthrough (`bevelNormal` in `shader.ts`)

```
1. Early out if bevelSize uniform is 0 (toggle off)
2. Compute block position: floor((worldPos - normal * 0.5) / BLOCK_SIZE)
   - The normal offset ensures faces sitting exactly on block boundaries
     resolve to the correct block (not the neighbor)
3. Compute block-local fraction: fract(worldPos / BLOCK_SIZE)
4. For each of the two in-plane axes (not the face normal axis):
   a. Distance to nearest edge: min(frac, 1 - frac)
   b. Bevel strength: smoothstep from bevelFrac to 0
   c. If strength > 0, determine which edge we're near (+1 or -1)
   d. Check if neighbor in that direction is solid (textureLoad on voxelMap)
   e. If neighbor is AIR → tilt the normal toward that edge
5. Normalize the result
```

The `smoothstep` gives a gradual transition from flat face to tilted bevel, avoiding
hard seams.

### CPU Side (`main.ts`)

- A `texture_3d` with `dimension: '3d'` and `r8uint` format stores the voxel grid
- `uploadVoxelMap()` fills it at init from the World's block data
- `updateVoxelTexel()` patches a single texel when a block is placed/broken
- `bevelSize` is passed as a uniform (part of the Uniforms struct alongside the
  view-projection matrix), controlled by the debug panel toggle + slider

## Performance

- **Fragment cost:** 4 `textureLoad` calls per fragment (integer, no filtering). Cheap
  and cache-friendly since nearby fragments check nearby blocks.
- **Texture memory:** 1 byte per block. 128^3 world = 2 MB. Negligible.
- **Per-block updates:** Single texel write. O(1).
- **Scaling concern:** A single 3D texture doesn't work for infinite worlds. Future fix:
  a clipmap (fixed-size texture centered on player, updated as chunks load/unload).

## Tradeoffs vs Geometry

| | Shader Bevel | Geometry Bevel |
|---|---|---|
| Visual quality at 4% bevel | Excellent | Excellent |
| Silhouette (grazing angles) | Flat (no actual geometry) | Correct |
| Implementation complexity | ~30 lines WGSL | Hundreds of lines, many edge cases |
| Greedy meshing | Unchanged | Breaks merging, increases verts |
| Vertex count impact | Zero | Significant |
| Toggle on/off | Uniform flip, instant | Full remesh required |
| Adjustable at runtime | Slider, instant | Full remesh per change |

For a subtle bevel, the shader approach wins on every axis except grazing-angle
silhouettes — which are invisible at 4% bevel size anyway.
