# Session Notes — Mar 30-31, 2026

## What We Did

Moved the greedy mesher off the main thread and into a web worker. Block placement/destruction previously caused frame hitches because `greedyMesh()` ran synchronously in the mousedown handler — 21ms at 6x CPU throttle (88% of the handler). After this session, the mousedown handler dropped to ~6ms, then to ~2ms after optimizing `buildPaddedBlocks`.

---

## Architecture

### The Data Boundary

The design is built around a single clean seam: the **padded block array** (`Uint8Array(34³)`). Everything on the main thread side needs `World` and `GPUDevice`. Everything on the worker side is pure computation on flat arrays.

```
Main Thread                              Worker
──────────────────────────────────────────────────────
World (live state)
  |
buildPaddedBlocks()       -- Uint8Array(34³) -->    greedyMesh()
  (26 neighbor lookups,                              pure function,
   direct array copies)                              no World dependency
                                                        |
applyMeshResult()         <-- Float32Array --       vertex data
  |
GPU buffers
```

Both the padded input and the vertex output are transferred (zero-copy) via Comlink.

### File Responsibilities

- **`block.ts`** — `BlockProps` interface (flat `isSolid[]`, `textureScale[]` arrays) decouples the mesher from the singleton `BlockRegistry`. `extractBlockProps()` bridges the two.
- **`world.ts`** — `buildPaddedBlocks(cx, cy, cz)` is the snapshot function. Pre-fetches 26 neighbor chunks (6 face + 12 edge + 8 corner) with 26 Map lookups total, then fills border cells via direct array reads with bitwise `& MASK` coordinate mapping. No per-cell string allocation.
- **`greedy-mesh.ts`** — Pure function. Takes `paddedBlocks`, `cx/cy/cz`, `blockSize`, `blockProps`. No `World` import, no `blockRegistry`. Runs identically on main thread (sync initial load) or in a worker (async runtime).
- **`mesh-worker.ts`** — Thin Comlink wrapper. Receives `BlockProps` once at init, then processes mesh requests. ~30 lines.
- **`mesh-scheduler.ts`** — Orchestration layer. Single worker, job queue with key-based dedup, revision checks (stale result rejection), priority (interactive > streaming), cancel support. Main thread code never talks to the worker directly.
- **`main.ts`** — Three mesh paths: `meshChunkSync` (initial load, calls greedyMesh directly), `scheduleMeshChunk` (runtime, goes through scheduler), `applyMeshResult` (shared GPU buffer creation, swap-then-destroy).
- **`chunk-loader.ts`** — Minimal change. Callback renamed from `meshChunk` to `scheduleMeshChunk`.

### The Padded Block Array (34x34x34)

The mesher reads blocks in the range `[-1, CHUNK_SIZE]` on each axis (boundary reads for AO). Instead of giving the worker access to the full `World`, we assemble a 34x34x34 array that contains the chunk's 32x32x32 blocks plus a 1-block border from all neighbors. This captures everything the mesher needs — interior blocks, boundary faces, and diagonal AO lookups — in one transferable buffer.

Interior is copied row-by-row from the chunk's block array. Border is filled by iterating 26 neighbor directions, fetching each chunk once, and reading directly from its blocks array. Coordinate mapping uses `& (CHUNK_SIZE - 1)` since CHUNK_SIZE is a power of 2.

### Revision-Based Stale Result Rejection

Each `scheduleMesh` call bumps a revision counter for that chunk key. When the worker result arrives, the scheduler checks if the revision still matches. If the player modified the same chunk again while the worker was busy, the old result is silently dropped. Combined with `world.hasChunk()` check in `applyMeshResult`, this handles both rapid edits and chunk unloads during in-flight jobs.

### Swap-Then-Destroy Buffer Logic

The old implementation destroyed GPU buffers before building the new mesh. With async meshing, the old buffers must stay alive (keep rendering) until the new result arrives. `applyMeshResult` creates the new buffers, updates `chunkRenderMap`, then destroys the old ones.

---

## Decisions & Rationale

### One worker, not a pool

Profiling showed the single worker handles meshing with room to spare — the worker thread was never the bottleneck. A pool adds complexity (round-robin, idle tracking) for no measurable gain. The scheduler interface (`scheduleMesh`, `cancel`) supports upgrading to a pool internally without changing any call sites.

### Copy over SharedArrayBuffer

SAB would eliminate the padded array copy but requires COEP/COOP headers, a custom memory allocator for chunk slots, and careful race condition handling. The copy cost (~0.5ms native for `buildPaddedBlocks`) is negligible compared to mesh time. SAB can be adopted later by changing only `buildPaddedBlocks` — the mesher and scheduler are oblivious to the backing storage.

### Comlink for worker messaging

The worker API surface is narrow (init + mesh), so raw `postMessage` would have been fine too. Comlink was chosen for cleaner ergonomics — async function calls instead of message wiring. ~5KB, well-maintained, TypeScript-friendly.

### Sync path preserved for initial load

`loadInitial` + `meshChunkSync` still runs greedyMesh directly on the main thread so the world is fully visible on the first frame. The refactored pure function works in both contexts without code duplication.

### buildPaddedBlocks optimization (v1.1)

The initial implementation called `world.getBlock()` per border cell (~6,500 calls), each creating a `chunkKey` string + Map lookup. This showed up as 50% of the mousedown handler at 6x throttle, with Major GC from the string allocations. Replaced with a 26-chunk prefetch + direct array reads. Same 6,536 cells copied, but with 26 Map lookups instead of 6,500 and zero allocations in the hot loop.

---

## Performance Results (6x CPU Throttle)

| Metric                        | Before workers | After workers | After buildPaddedBlocks opt |
|-------------------------------|---------------|---------------|----------------------------|
| mousedown handler (main)      | 23.9ms        | 6.4ms         | ~2ms                       |
| greedyMesh on main thread     | 21.0ms (88%)  | 0ms (moved)   | 0ms                        |
| buildPaddedBlocks (main)      | n/a           | 3.2ms (50%)   | <0.5ms                     |
| greedyMesh on worker          | n/a           | 2.8ms         | ~2.8ms                     |
| GPU upload (writeBuffer)      | 0.3ms         | 0.3ms         | 0.3ms                      |

---

## Extension Points

These are clean and don't require rearchitecting:

- **Worker pool** — Change `MeshScheduler` internals only. Public interface unchanged.
- **Terrain gen offloading** — Add `generateAndMesh` to worker API. Scheduler gets a new job type. Additive.
- **New block types** — Register in `BlockRegistry`, `extractBlockProps()` picks it up automatically.
- **Lighting (Phase 4)** — Second padded array for light values. Mesher gains a parameter. Scheduler/worker plumbing unchanged.
- **SharedArrayBuffer** — Replace `buildPaddedBlocks` backing storage. Mesher still receives a `Uint8Array`. Everything downstream is oblivious.

## Deferred Items

1. **Multi-worker pool** — Only if chunk streaming becomes a bottleneck.
2. **Terrain gen offloading** — `buildChunkBlocks` still runs on main thread during chunk loading. Profile during rapid vertical movement.
3. **Async initial load** — Could make startup non-blocking (world pops in). Cosmetic.
4. **Optimistic visual updates** — Broken block lingers 1-2 frames. Only address if perceptible at native speed.
5. **Frustum culling** — Unrelated to workers, still on roadmap. Reduces draw calls as chunk count grows.
