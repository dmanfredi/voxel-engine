# GC Investigation — After Action Report

**Date:** 2026-04-05 to 2026-04-06
**Participants:** Dylan, Claude (Opus 4.6), prior work with Codex

## The Problem

Under 6x CPU throttle in Chrome DevTools, the engine exhibited frequent Major GC events (10 in ~15 seconds). Each pause was 20-25ms, collecting 500-1500 KB, and produced partially presented frames. The hitches were more frequent during active play (running, placing blocks) and rare when standing still. A prior investigation with Codex had stripped the engine to the floor without isolating the cause, concluding it was likely browser/profiler noise.

## Investigation Timeline

### Phase 1: Code Analysis (wrong theory)

Walked the entire hot path: `tick` -> `physicsTick` -> `moveAndCollide`, `raycast`, `render`, `scheduleMeshChunk` -> `buildPaddedBlocks`, and `autoClimb` -> `onBlockChanged`.

Initial hypothesis: **per-frame allocation churn** was flooding the GC with garbage. Identified candidates:
- wgpu-matrix creating temporary Float32Arrays per frame (mat4.perspective, lookAt, vec3 ops)
- `chunkKey()` template strings from collision and raycast (~50 per frame)
- `buildPaddedBlocks` allocating 39KB Uint8Arrays eagerly, some superseded before worker pickup
- Object literals returned from collision resolve functions

Estimated ~100 KB/sec steady churn + ~275 KB burst per block placement. This matched the 500-1500 KB collection figure and explained the activity correlation.

### Phase 2: Allocation Sampling (inconclusive)

Used Chrome DevTools Memory tab -> Allocation Sampling. Results were sparse and showed minified function names (`A`, `c`, `push`) pointing to `VM698:1`. Source maps were not being applied despite running `npm run dev`.

**Lesson:** Allocation Sampling is statistical (samples ~1 per 512KB of total allocation). Small-but-frequent allocations are nearly invisible. Minified names without source maps make the results unreadable.

### Phase 3: Performance Panel with Memory Checkbox

Enabled Memory checkbox in the Performance tab. Observed:
- Sawtooth heap rises and falls
- Not every drop corresponded to a visible GC event in the flame chart
- Some drops were from **Minor GC (Scavenge)** — too fast to render as blocks in the flame chart
- Chains of small arrows before Major GC pauses: **V8 incremental marking steps** — the mark phase broken into small slices interleaved with app code

**Lesson:** Minor GC can reclaim the same amount as Major GC but in sub-millisecond time. Major GC is expensive because it scans the entire old generation, regardless of how much garbage it finds. The cost scales with total heap size, not garbage volume.

### Phase 4: Allocation Instrumentation on Timeline (the pivot)

Used "Allocation instrumentation on timeline" (not sampling). This records every allocation with full call stacks. Recorded ~30 seconds of active play.

Key finding: **steady-state gameplay barely allocated anything on the JS side.** Excluding the first ~100ms of the recording, total non-buffer allocations were ~70 KB over 30 seconds. The per-frame churn from vec3/mat4/chunkKey was negligible.

The dominant entry was `system / JSArrayBufferData x1,422` at **45,880 KB** (62% of heap). Each entry was exactly 32.8 KB = CHUNK_SIZE^3 = 32,768 bytes. These were the live chunk block arrays — the loaded world, not garbage.

**This disproved the allocation churn theory.** The engine was allocation-lean during gameplay.

### Phase 5: Reframing — Large Live Heap

With churn eliminated, the theory shifted: **V8's Major GC pauses are driven by the large live heap, not garbage creation rate.**

V8 tracks ArrayBuffer backing stores as external memory. Each `JSArrayBuffer` has an `ArrayBufferExtension` that the GC must mark and the sweeper must iterate. With 1,422 separate ArrayBuffers totaling 45 MB:
- External memory pressure triggers Major GC via `kExternalMemoryPressure`
- Per-buffer bookkeeping (marking/sweeping 1,422 extensions) adds overhead
- V8 v8.3 release notes specifically called out a 50% pause time reduction for ArrayBuffer-heavy workloads

An independent web search confirmed:
- ArrayBuffer backing stores live outside V8's heap but count toward GC scheduling thresholds (V8 source: `heap.cc`)
- Buffer count matters independently of total bytes (V8 source: `js-array-buffer.h`)
- **Correction to our wording:** V8 is NOT scanning 45 MB byte-for-byte during Major GC. The backing stores are off-heap. The cost is external-memory-triggered marking + per-buffer extension bookkeeping.

### Phase 6: Quick Validation

Reduced `WORLD_WIDTH` from 10 to 4 and `VERTICAL_RADIUS` from 6 to 2. This dropped loaded chunks from ~1,300 to ~80 (41 MB -> 2.5 MB). Under 6x throttle, Major GC pauses were less frequent and caused fewer partial frames. Consistent with the theory.

Native-speed Major GC was confirmed at **3-4ms** — well within the 16.6ms frame budget at 60fps.

### Phase 7: ArrayBuffer Pooling Implementation

Built a `ChunkBlockPool` class that pre-allocates a single large ArrayBuffer and hands out Uint8Array views via `subarray()`. V8 tracks 1 ArrayBufferExtension instead of 1,422.

Files changed:
- **Created** `src/chunk-block-pool.ts` — pool with free-list slot management
- **Modified** `src/chunk.ts` — Chunk stores `poolSlot` for release on unload
- **Modified** `src/block-builder.ts` — accepts output Uint8Array instead of allocating
- **Modified** `src/chunk-loader.ts` — acquires/releases pool slots
- **Modified** `src/main.ts` — creates pool, passes to ChunkLoader

### Phase 8: In-App Hitch Detector

Added a hitch detector to the debug panel (`debug.ts`) that tracks `requestAnimationFrame` deltas exceeding 20ms. Counts hitches and records worst frame time. This allows A/B testing **without DevTools open**, eliminating profiler overhead as a variable.

### Phase 9: A/B Testing (the conclusion)

Ran 5 trials each, ~30 seconds of active play, DevTools closed:

| Version | Hitches | Worst Frames |
|---------|---------|-------------|
| Unchanged | 2, 2, 0, 3, 3 | 24, 24, -, 48, 24 ms |
| Pooled | 0, 2, 2, 2, 2 | -, 42, 48, 48, 48 ms |

**No measurable difference.** Both versions showed 0-3 hitches with worst frames of 24-48ms. The worst-frame values cluster at multiples of ~16.6ms (vsync period), indicating missed vsyncs from browser-level scheduling, not GC pauses.

## Conclusion

The Major GC pauses observed under 6x CPU throttle were real V8 events, but they were **not a real-world performance problem.** At native speed, Major GC takes 3-4ms — comfortably within one frame. The 20-25ms pauses only existed because:

1. 6x CPU throttle linearly scales GC pause duration
2. DevTools itself adds V8 debugging overhead
3. Together, these amplified a non-issue into an apparent bottleneck

The occasional 24-48ms hitches visible in the in-app detector exist regardless of the ArrayBuffer strategy and are browser-level noise (vsync misses, compositor work, OS scheduling).

## What We Learned

### V8 GC Internals
- **Minor GC (Scavenge):** cleans the young generation in sub-millisecond time. Invisible in flame charts but visible as heap drops.
- **Major GC (Mark-Compact):** scans the entire old generation. Cost scales with heap size, not garbage collected. The incremental marking arrows in the flame chart are the lead-up; the final pause is the stop-the-world sweep.
- **ArrayBuffer external memory:** backing stores are off-heap but tracked by V8 for GC scheduling. Each JSArrayBuffer has an ArrayBufferExtension that the GC must mark/sweep. Buffer count matters, not just total bytes.
- **`kExternalMemoryPressure`:** V8 can trigger Major GC specifically because external (ArrayBuffer) memory exceeds thresholds, even with zero JS-heap garbage.

### Profiling Methodology
- **CPU throttle is misleading for GC analysis.** It linearly scales pause duration, making normal GC look pathological. Useful for algorithmic bottlenecks, not GC tuning.
- **DevTools adds overhead.** The observer affects the observed. Always validate findings with DevTools closed.
- **Allocation Sampling is statistical.** Misses small/frequent allocations. Use "Allocation instrumentation on timeline" for complete data.
- **In-app measurement is ground truth.** A simple rAF-delta hitch counter eliminates all profiler variables.
- **Worst-frame clustering at vsync multiples** (~16.6ms, ~33ms, ~50ms) indicates scheduling/compositor hitches, not application-level pauses.

### Real Hardware vs CPU Throttle
Chrome's CPU throttle simulates slowness by inserting execution delays. Real weak hardware is typically **worse than linear** because:
- Slower memory / smaller caches cause cache miss stalls during GC's pointer-chasing workload
- Fewer cores reduce V8's ability to run concurrent marking off the main thread
- Thermal throttling on thin laptops can degrade performance over sustained sessions

A 3-4ms native Major GC would need roughly 5x real-world CPU slowdown to become a dropped frame. That's deep into budget-device territory.

## Artifacts

- Hitch detector added to debug panel (`src/debug.ts`) — kept for future use
- ArrayBuffer pooling implementation — reverted (no measurable benefit)
- Memory entry: `feedback_gc_profiling.md`
