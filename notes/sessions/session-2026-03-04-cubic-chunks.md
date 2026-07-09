# Session Notes — Mar 4, 2026

## What We Did

Implemented cubic chunks: the engine now stores the world as a map of 32x32x32 chunks instead of a single flat array. Per-chunk meshing, per-chunk GPU buffers, multi-draw rendering, and boundary-aware remeshing all land in this change. This is the core architecture piece of Phase 2 from the technical roadmap.

Scope was intentionally limited to **core infrastructure** — a fixed 4x4x4 grid of chunks with no dynamic loading/unloading. The goal was to validate the chunk data flow end-to-end before adding the complexity of streaming.

---

## Decisions & Rationale

### Chunk size: 32x32x32

Considered 16x16x16 (faster individual remesh, but 8x more chunks in the same volume and more draw calls). Went with 32 because:

- Matches the existing world dimensions (the old single-chunk was already 32³), so the transition is a clean upgrade rather than a rescaling.
- Fewer chunks = fewer draw calls, fewer GPU buffers, less overhead from the chunk management layer.
- Individual chunk remesh is still fast enough at 32³ — the greedy mesher is O(n) in volume and 32K blocks processes in well under a frame.

If perf becomes an issue later (e.g. worker-thread meshing taking too long per chunk), 16³ can be revisited.

### Fixed grid, not dynamic loading

The roadmap lists chunk loading/unloading as part of Phase 2, but we split it out. Reasons:

- Loading logic adds a load queue, priority sorting (distance-based), and async mesh generation — significant complexity that's orthogonal to the data structure change.
- A fixed grid lets us validate that chunk boundaries are seamless (AO, meshing, collision, raycast) without confounding variables from loading order or missing chunks.
- The `RENDER_DISTANCE` constant makes the grid size trivially adjustable for testing.

### Chunk class: pure data, no GPU resources

`Chunk` holds only block data (`Uint8Array`) and coordinates. GPU resources (vertex buffer, wireframe bind group, vertex count) are tracked separately in `main.ts` via a `ChunkRenderData` map keyed by `chunkKey`.

Why not put GPU state on the Chunk? Because:

- Chunk is a data structure. GPU resources require a `GPUDevice` reference, bind group layouts, etc. Mixing them forces the data layer to know about the rendering layer.
- Separation makes it easy to have chunks loaded (in memory with block data) but not meshed (no GPU resources) — important for future dynamic loading where you might load block data first and mesh lazily.
- The `ChunkRenderData` map naturally parallels the chunk map and is easy to iterate for rendering.

### World class: `Map<string, Chunk>`, not bounded dimensions

The old World had `sizeX/Y/Z` and returned AIR for out-of-bounds access. The new World has no dimension constraints — it's just a map of chunks. `getBlock` returns AIR if the requested chunk doesn't exist.

This means:

- No artificial world boundaries. Chunks can exist at any coordinates (including negative).
- `setBlock` returns false if the target chunk doesn't exist, which is the right behavior — you can't place blocks into unloaded space.
- Collision and raycast continue to work because they already treated out-of-bounds as air.

### Negative coordinate handling

JavaScript's `%` operator gives negative results for negative inputs (`-1 % 32 === -1`), which would produce invalid array indices. The fix is the double-modulo pattern:

```ts
const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
```

`Math.floor` for chunk coordinate calculation already handles negatives correctly: `Math.floor(-1 / 32) === -1`, and the local coordinate works out to 31 (the last block in the neighbor chunk). This was verified to be correct before implementation.

### Mesher: offset-based, not local-copy

Two approaches were considered for per-chunk meshing:

1. **Offset approach** (chosen): The mesher iterates chunk-local coordinates (0 to 31) but adds a world-block offset (`cx * 32, cy * 32, cz * 32`) to all `getBlock` and `isSolid` calls. Cross-chunk boundary lookups at the sweep edges (`x[axis] = -1` and `x[axis] = CHUNK_SIZE`) go through World and resolve to neighbor chunks automatically.

2. **Padded copy approach** (rejected): Copy the chunk's blocks plus a 1-block border from all 6 neighbors into a temporary 34x34x34 buffer, then mesh that. Avoids the offset math but requires 6 neighbor lookups, allocation, and copying for every mesh build.

The offset approach was chosen because:

- It reuses the existing World abstraction — the same `getBlock` call that handles in-chunk access also handles cross-chunk access.
- No allocation or copying overhead.
- The actual code change was mechanical: every `world.getBlock(x[0], x[1], x[2])` became `world.getBlock(ox + x[0], oy + x[1], oz + x[2])`.

### UV origins: world-space, not chunk-local

UVs for texture tiling use world-block-space origins (`offsets[u] + i` instead of just `i`). This ensures textures tile seamlessly across chunk boundaries. If we used chunk-local UVs, there would be visible texture seams at every chunk edge because the tiling pattern would restart at 0.

### Boundary-aware remeshing

When a block is placed/broken, we remesh the containing chunk. But if the block is on a chunk boundary (local coordinate 0 or 31 on any axis), the neighbor chunk's AO could be affected — the mesher reads 1 block into neighbor space for AO lookups. So we also remesh the relevant neighbor chunk(s).

This is at most 4 extra remeshes (corner case: block at a chunk corner touches 3 neighbors plus the containing chunk), but usually 1-2. The check is cheap (modulo + comparison) and avoids visible AO seams when editing at boundaries.

### Water disabled

The water plane was hardcoded to the old single-chunk dimensions (`CHUNK_SIZE_X * BLOCK_SIZE`). Rather than make it work with a fixed chunk grid that will change again when dynamic loading arrives, we disabled it with a TODO comment. It's a visual effect, not a gameplay system — can return later.

### Camera spawn at world center

The old camera spawned at `(CHUNK_SIZE_X / 2 * BLOCK_SIZE, BLOCK_SIZE * 3, ...)`. With a 4x4x4 grid, the world center is `(4 * 32 * 10) / 2 = 640` on each axis. Camera spawns there. With 3D Perlin noise the terrain is a cave system, so spawn position is somewhat arbitrary — the player can break out if they land in rock.

---

## What Stayed the Same

The Phase 1 World abstraction paid off exactly as designed. These files needed **zero changes**:

- `collision.ts` — uses `world.isSolid()`, which transparently routes through chunks
- `movement.ts` — calls `moveAndCollide()`, no direct block access
- `raycast.ts` — uses `world.isSolid()` and `world.blockSize`, both unchanged
- `highlight.ts` — pure rendering utility, takes block coordinates
- `block.ts` — registry is global, block IDs don't care about storage
- All shaders (`shader.ts`, `wireframe.ts`, `skybox.ts`) — vertex format unchanged, no world awareness
- `debug.ts` — UI only

This was the entire point of building the World abstraction in Phase 1 before touching chunks.

---

## Files Changed

| File | Change |
|------|--------|
| `src/chunk.ts` | **New**: `Chunk` class (coords + `Uint8Array(32³)`), `CHUNK_SIZE = 32`, `chunkKey()` |
| `src/world.ts` | `Map<string, Chunk>` storage, chunk-routed `getBlock`/`setBlock`, `addChunk`/`getChunk`/`forEachChunk` |
| `src/block-builder.ts` | `buildChunkBlocks(cx, cy, cz)` with world-offset noise coordinates |
| `src/greedy-mesh.ts` | Per-chunk meshing with `(world, cx, cy, cz)` signature, offset block/AO/vertex/UV lookups |
| `src/main.ts` | `ChunkRenderData` map, multi-draw loop, `onBlockChanged()` with boundary remesh, fixed 4x4x4 grid, water disabled |

---

## What's Next

Remaining Phase 2 items from the roadmap:

- **Dynamic chunk loading/unloading** — load chunks in a radius around the player, prioritized by distance. Unload far chunks (keep block data longer than GPU resources).
- **Frustum culling** — skip draw calls for chunks outside the view frustum. Cheap per-chunk AABB test.
- **Auto-climb mechanic** — hold space to scaffold blocks beneath you. Needs block placement (done) + chunks loading above you.

Future optimization opportunities (not urgent):

- **Worker-thread meshing** — move greedy mesh to a web worker so it doesn't block the main thread during chunk loads.
- **Chunk mesh caching** — don't remesh clean chunks on load if their neighbors haven't changed.
- **Indirect draw / multi-draw-indirect** — batch all chunk draws into a single GPU call.
