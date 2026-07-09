# Session Notes — Mar 28-29, 2026

## What We Did

Implemented horizontal world wrapping and vertical chunk streaming. The world now wraps on X/Z (toroidal topology) and dynamically loads/unloads chunks vertically as the player climbs. This completes the core chunk loading item from Phase 2 of the technical roadmap, adapted to fit the vertical game design — horizontal is bounded and wrapping, vertical is infinite and streamed.

Also implemented per-chunk render offsets so chunks near the horizontal seam render at the correct wrapped position. The player can look across the world border and see terrain on the other side seamlessly.

---

## Decisions & Rationale

### Wrapping before chunk loading

We implemented horizontal wrapping first, then chunk loading. Wrapping is a small, contained change to the World class (modular arithmetic on block coords). Once wrapping is in place, the horizontal dimension is bounded, which simplifies the chunk loader — it only needs to stream vertically. If we'd done loading first, we would have needed to retrofit wrapping-aware distance calculations and seam handling into the loader.

### Vertical-only streaming

The game is a vertical climber — the player mostly moves up. The horizontal arena is bounded by wrapping (currently 8 chunks = 256 blocks wide). All horizontal chunks stay loaded at every Y-layer. Only the vertical axis streams around the player.

This avoids the complexity of horizontal chunk loading (wrapping-aware distances, load priority across the seam) while directly serving the game's movement pattern. If the world width grows beyond what fits in memory, horizontal streaming can be added later — the vertical infrastructure extends naturally.

Math on keeping all horizontal chunks loaded:

| Width (chunks) | Chunks per Y-layer | Block data memory |
|----------------|--------------------|--------------------|
| 8              | 64                 | 2 MB               |
| 16             | 256                | 8 MB               |
| 32             | 1024               | 32 MB              |

GPU memory is heavier per chunk (~800KB worst case for a dense mesh), but empty/solid chunks get no GPU buffer. At WORLD_WIDTH=8-16, this is very manageable.

### Per-chunk render offsets for seam rendering

Without this, chunks near the horizontal seam render at their raw world position (thousands of units from the camera). A chunk at x=0 has vertices at x=0, but if the camera is at x=2500, the wrapped distance is only 60 units — yet the GPU would draw it 2500 units away.

The fix is a per-chunk `vec3` offset applied in the vertex shader. For each chunk, we compute whether it's "across the seam" from the camera:

```typescript
const dx = chunkWorldX - cameraPos[0];
offsetX = dx > halfWidth ? -worldWidth : dx < -halfWidth ? worldWidth : 0;
```

Most chunks get offset (0, 0, 0). Only chunks across the seam get shifted by ±worldWidth. The offset is uploaded to a per-chunk uniform buffer and applied in both the main and wireframe vertex shaders.

This required switching from `layout: 'auto'` to explicit pipeline layouts so both pipelines can share a common bind group layout for the offset (group 1). The explicit layouts also make the binding structure more maintainable.

### ChunkLoader: data + GPU lifecycle

The `ChunkLoader` class owns all load/unload decisions. It takes callbacks for `meshChunk` and `unmeshChunk` so GPU resource management stays in `main.ts` (where the device, pipelines, and bind group layouts live). The loader itself only deals with block data.

Key parameters (all tunable):

- `VERTICAL_RADIUS = 6` — chunks above/below the player to keep loaded
- `loadsPerFrame = 4` — max chunks generated+meshed per tick
- Hysteresis buffer of 1 chunk on unloads to prevent thrashing at boundaries

Initial load is synchronous (`loadInitial`) to prevent the player falling through unloaded terrain. Subsequent loads are incremental (queue-based, closest Y first).

### World class: wrapping at the block level

Wrapping is implemented as `wrapX`/`wrapZ` private methods on the World class, applied in `getBlock`, `setBlock`, and `isSolid`. The wrapped coords are always in `[0, widthBlocks)`, so chunk coord calculation is a simple `Math.floor(wx / CHUNK_SIZE)` with no negative-modulo concerns. Y stays unwrapped.

`isSolid` delegates to `getBlock`, so it wraps automatically. All existing systems (collision, raycast, meshing, auto-climb) go through the World abstraction and got wrapping for free — zero changes to those files.

---

## Bugs Fixed

### 1. Stale mesh on neighbor chunk at world border (AO z-fighting)

**Symptom:** Placing blocks at the world border caused flickering triangular artifacts — z-fighting between stale geometry and offset-rendered geometry from the other side.

**Root cause:** `onBlockChanged` detects chunk-boundary blocks and remeshes neighbors, but the neighbor coordinate calculation didn't wrap. Placing a block at x=0 would try to remesh chunk cx=-1 (doesn't exist) instead of cx=7 (the wrapped neighbor). Chunk 7 kept its stale mesh with faces that should have been suppressed, causing coplanar geometry with incorrect AO.

**Fix:** Wrap X/Z neighbor chunk coordinates through `world.widthChunks` in `onBlockChanged`.

### 2. Ghost blocks when breaking across world border

**Symptom:** Breaking a block across the world border removed the physical block (collision worked correctly) but the mesh didn't update — a visual ghost block remained.

**Root cause:** The raycast returns raw stepped coordinates (e.g., `blockPos = [-1, y, z]` when stepping past x=0 from the other side). `world.setBlock(-1, ...)` wraps correctly and removes the block. But `onBlockChanged(-1, ...)` computes `cx = Math.floor(-1 / 32) = -1`, tries to remesh chunk -1, and silently fails. The actual chunk (cx=7) is never remeshed.

**Fix:** Wrap bx/bz at the top of `onBlockChanged` before computing chunk coordinates.

---

## Files Changed

| File | Change |
|------|--------|
| `src/chunk-loader.ts` | **New**: `ChunkLoader` class — vertical streaming with `loadInitial` and per-tick `update` |
| `src/world.ts` | Added `widthChunks`, `wrapX`/`wrapZ`, wrapping in `getBlock`/`setBlock`. Added `removeChunk`, `hasChunk` |
| `src/main.ts` | Replaced fixed grid with `ChunkLoader`. Added explicit pipeline layouts, per-chunk offset buffers/bind groups, offset computation in render loop. Wrapped block coords in `onBlockChanged`, wrapped neighbor chunks at world border |
| `src/shader.ts` | Added `@group(1) chunkOffset` uniform, applied to vertex position and worldPos varying |
| `src/wireframe.ts` | Added `@group(1) chunkOffset` uniform, applied to storage-buffer position read |
| `src/block-builder.ts` | Commented out unused generator imports (lint fix) |

---

## What Stayed the Same

The Phase 1 World abstraction continues to pay dividends. These files needed **zero changes** for wrapping or chunk loading:

- `collision.ts` — uses `world.isSolid()`, wraps transparently
- `movement.ts` — no direct world access
- `raycast.ts` — uses `world.isSolid()`, wraps transparently
- `auto-climb.ts` — uses `world.setBlock()`, wraps transparently
- `highlight.ts` — pure rendering utility
- `block.ts` — registry is independent of world topology
- `greedy-mesh.ts` — cross-chunk lookups go through `world.getBlock()`, wrapping and AO at the world border work automatically
- `skybox.ts`, `debug.ts`, `game-state.ts` — no world awareness

---

## What's Next

Remaining Phase 2 items:

- **Frustum culling** — skip draw calls for chunks outside the view frustum. Per-chunk AABB test against the view-projection matrix.
- **Auto-climb mechanic tuning** — hold space to scaffold blocks beneath you. The mechanic exists but may need tuning for the climbing game feel.
- **BP system** — building points as the core resource.

Future considerations discussed but deferred:

- **Seamless terrain at the world border** — current terrain has a discontinuity at the wrapping seam (the menger sponge pattern doesn't match). Fixable with the 4D noise trick: map 2D world coordinates onto circles in 4D space so the noise function naturally wraps.
- **Tiled rendering (see-your-own-back)** — rendering the world multiple times at offset positions so the player can see it repeat. 9x draw calls (3x3 tiling). Cool effect but not needed for gameplay.
- **Horizontal chunk streaming** — if WORLD_WIDTH grows beyond ~32, loading all horizontal chunks becomes expensive. The vertical streaming infrastructure would extend naturally.
