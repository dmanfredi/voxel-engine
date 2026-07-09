# Cube Tip — Placement Animation (Design)

**Status:** designed, not implemented (2026-05-02). Captured here so the next dev (or Claude session) doesn't have to redo the architecture work.

## What this is

When a cube tips, it scaffolds an N³ region of blocks beneath the destination cell (so it has ground to land on). Today those blocks **pop into existence** — instant `setBlock` + chunk remesh, no animation. Reads as abrupt; the cube feels like it's teleporting terrain into place.

Goal: make the scaffold blocks visibly *fall in* during the tip, landing exactly when the cube lands.

The cube tip animation itself (rotation around the pivot edge) is unaffected; this is purely about how the scaffold blocks appear.

## The design in one paragraph

`tryTipCube` is split into a pure-validation `canTipCube` and a `commitTipCube` that does no world mutation. If validation passes: spawn a single **slab entity** covering the entire scaffold volume, kick off the cube tip, and let both run their own clocks. The slab falls from somewhere above the destination toward the scaffold cells. When the slab's `progress` hits 1, an `onLand` callback fires that does the actual `setBlock`s + `onRegionChanged` and despawns the slab. The cube tip and slab fall share `entity.tipDuration`, so they finish on the same frame.

The whole architecture rides on one observation: **the cube doesn't need solid ground during its tip animation.** Tipping cubes are intentionally inert (see `entity.ts` Pass 1 — `if (entity.tip !== null) advanceCubeTip(...) else entityCubePhysicsTick(...)`), so no gravity check, no voxel collision, no requirement for solid terrain beneath. Ground is only needed *after* the tip ends, when normal physics resumes — and by that frame, the slab has landed and committed the blocks.

## Why this design vs. the alternatives

We considered four other shapes and rejected them. Worth knowing why so this isn't relitigated:

1. **One animation entity per scaffold cell.** For a size-20 cube (N=4 → 64 cells) you spawn 64 short-lived entities per tip. Heavy, and individual block animations don't visually cohere into a "the cube placed a slab" reading.

2. **Per-vertex "freshness" in the chunk mesh.** Add a `placeTime` u32 to the vertex format; shader scales/fades vertices based on age. Pure shader work, but: greedy mesher needs per-quad freshness tracking, fresh-vs-stale faces with same blockID and AO would no longer merge cleanly, and you carry +10% vertex-buffer overhead forever for a transient effect.

3. **Place blocks immediately as solid + suppress chunk remesh until animation ends.** Earlier draft of this design. Has a fatal flaw: blocks are *solid but invisible* during the animation window. A sphere flying through the air column would hit an invisible wall. Worse UX than option 4 below.

4. **Defer both `setBlock` and `onRegionChanged` to slab-land (chosen).** During the animation, the air column is genuinely air — anything can fly through. At slab-land, both world-data mutation and chunk remesh happen atomically. The only edge case is "entity inside scaffold cell at the moment of solidification," which is rare and resolves via existing collision squeeze-out (see Edge Cases below).

## Components to build

### New shape

- **`Shape.Slab`** in the `Shape` const in `entity.ts`. Add it to the `Shape` type union.
- **Plain (non-beveled) cube mesh.** Mirrors `createBeveledCube()` minus the bevel geometry — six flat faces, ~36 vertices, same vertex format (`pos + normal + uv + ao + texLayer`). New file or alongside the beveled one in `cube.ts`. The slab needs to look like the static voxel terrain, not like an entity Cube.
- **Mesh registration** in `EntityManager.generateMesh` switch.

### New animation state

```ts
interface SlabState {
  progress: number;            // 0..1 over duration
  duration: number;            // = source cube's tipDuration
  sourcePos: Float32Array;     // start position (somewhere above destination)
  destPos: Float32Array;       // landing position (= scaffold bbox center)
  blockId: number;             // material's texLayer, baked at spawn
  scaffoldCells: [number, number, number][];  // cells to setBlock at land
  bbox: { minBX, minBY, minBZ, maxBX, maxBY, maxBZ };  // for onRegionChanged
  onRegionChanged: (...) => void;
}
```

Lives on the `Entity` (similar to how `tip: TipState | null` lives on cubes). Slab entities have `slab: SlabState | null` set non-null at spawn, cleared at land.

### Slab tick in `EntityManager.update`

**Pass 1 branch** (or new dedicated pass): for `Shape.Slab` entities, advance `progress += dt / duration`. Lerp `entity.{x,y,z}` between `sourcePos` and `destPos`. When `progress >= 1`:
1. Re-check `blockIntersectsEntity` for each scaffold cell (entities may have moved into the volume during fall).
2. For each cell: `world.setBlock(cell, blockId)`. Apply chosen entity-intrusion strategy (see Edge Cases).
3. Call `onRegionChanged(bbox)`.
4. Despawn the slab.

No physics, no AI for slabs. Just position interpolation + a one-shot terminal callback.

### `tryTipCube` refactor

```ts
canTipCube(entity, direction): boolean    // pure check — current tryTipCube
                                          // minus the commit phase
commitTipCube(entity, direction, onRegionChanged):
    // collect scaffoldCells (validation already done by canTipCube)
    spawn Shape.Slab with blockId, scaffoldCells, bbox, onRegionChanged
    startCubeTip(entity, ...)
```

Order of operations matters: spawn the slab first (with the captured `onRegionChanged`), then `startCubeTip`. The slab now owns the entire commit — `tryTipCube`'s caller no longer needs to think about `setBlock` or remeshing.

The `cubeAITick` closure in `EntityManager.update` becomes:
```ts
cubeAITick(entity, playerPos, ww, dt, (e, dir) =>
    this.commitTipCube(e, dir, onRegionChanged),
);
```

…but only if `canTipCube` first returns true. Either `cubeAITick` runs both checks, or `commitTipCube` returns false on its own validation (cleaner — single entry point that internally guards).

### Slab-vs-other collision (during fall)

The slab is a moving solid. While falling it should block spheres and the player just like a cube does. **Reuse the cube collision path:** the slab is a Shape.Slab but for collision purposes it behaves identically to a static cube at its current position. `getCubeOBB` would need a tiny tweak — slab uses an *axis-aligned* box (no orientation, no tip), or you write a `getSlabAABB` and call `resolveSphereVsAABB` directly. Either works.

If you skip slab collision entirely, spheres pass through it during the fall and could end up inside the scaffold cells at land time, hitting the entity-intrusion path constantly. Slab collision is what makes that edge case rare.

## Sequence diagram

```
canTipCube?  ─┬─ no  → return false
              └─ yes → 
                       spawn Slab(progress=0, duration=tipDuration)
                       startCubeTip(progress=0, duration=tipDuration)
                       
              [each frame, both progress fields advance by dt/duration in lockstep]
              
              ...
              
Frame N (progress hits 1 for both):
              advanceCubeTip clears entity.tip, snaps orientation, no physics yet
              slab tick: re-validates cells, setBlock, onRegionChanged, despawn
              
Frame N+1:
              cube has no tip → entityCubePhysicsTick runs
              ground is now solid (just placed) → cube sits → done
```

## Timing constraint

**Slab duration must equal cube tipDuration.** Both progress fields advance with the same `dt / sameDuration`, so they reach 1 on the same frame.

What happens if mismatched:
- **Slab faster than tip:** scaffold appears mid-tip, beneath the still-rotating cube. Visually fine — looks like the cube is dropping the scaffold ahead of itself.
- **Slab slower than tip:** cube finishes tip, physics resumes next frame, no ground yet, cube falls (gravity·dt) for one frame. Slab lands one frame later, blocks placed, cube grounds. One-frame jitter — usually invisible at 60 FPS but pathological if `tipDuration` is short.

Match them. Both fields share `tipDuration` at spawn, both progress with the same `dt`. No drift possible.

## Edge cases

### Entity inside a scaffold cell at slab-land

Possible if a sphere or player teleports/jumps into the volume during the fall (slab collision should make this rare but not impossible, e.g. for very tall scaffolds where a sphere is already in the bottom cells before the slab is close enough to push them out).

Three strategies, increasing polish:

1. **Place anyway, let next-frame physics squeeze them out.** Sphere collision detects the new overlap and depenetrates along the nearest face normal (existing `resolveSphereVsCube` / sphere-vs-voxel logic both handle "sphere overlaps solid block"). Player collision is similar. Cheapest, occasionally jittery.

2. **Skip occupied cells.** Don't `setBlock` for cells with entity overlap; the slab "fails to place" those specific blocks. Leaves Swiss-cheese ground. Cube might fall through holes when physics resumes. Bad — don't pick this.

3. **Burst push, then place.** Apply a fling-style impulse to occupied entities (away from cell center, magnitude tuned by feel), then `setBlock`. Expensive, custom code, but reads as "the slab landed and shoved them out." Best polish if it bothers you.

**Recommendation:** ship with #1, upgrade to #3 only if it actually feels bad in playtest.

### Adjacent block change mid-animation

If something else (autoclimb, player right-click, another cube tipping nearby) triggers a remesh of one of the scaffold's chunks during the animation window, **nothing visible happens**. Why: in this design, scaffold cells are still air in world data during the animation. The chunk remeshes with the same air it had before. The slab entity (a separate render path) continues falling. No glitch.

This was an issue in the rejected option 3 (place-immediately-suppress-remesh) but not here.

### Cube tip cancelled mid-tip

Can't happen with current code. `advanceCubeTip` always runs to completion. If we ever add tip-cancellation, the slab would need cleanup too — its `onLand` should be a no-op when invoked from a cancellation path so we don't drop blocks where the cube isn't going.

## Slab fall motion

Open decision for impl time. Three candidates:

- **Linear lerp:** simple, robotic.
- **Ease-in (`t²` or `t³`):** starts slow, accelerates. Reads as gravity. Probably the right default.
- **Ease-out:** starts fast, decelerates onto target. Reads as "deliberately placed" rather than "fell." Good if cube AI is supposed to feel surgical.

Source position is also a knob — straight up from destination by N blocks gives a "drops from sky" feel; offset toward the source cube (mid-air arc) gives a "thrown by the cube" feel.

If you want polish budget here: ease-in fall + small squash on impact (compress Y, expand X/Z briefly via the slab's renderable scale, then snap to despawn).

## Texture matching

The slab must read as voxel terrain visually. UV density needs to match the chunk mesh, not the entity Cube convention.

- **`texLayer`** — same as the source cube's `material.base.texLayer`. Marble cube → MARBLE blocks → slab uses MARBLE layer.
- **`texScale`** — derive from blockSize and the material's `textureScale`, *not* from the cube's existing entity formula. Voxel mesh wraps once per `textureScale * blockSize` world units. For a slab with half-extent `N · blockSize / 2`, the right `texScale` is `(N · blockSize / 2) / (textureScale · blockSize) = N / (2 · textureScale)`. Verify visually against an adjacent voxel block — they should look continuous.

The existing entity Cube `texScale` formula (`config.size / (matBase.textureScale * 10)`) happens to give the right answer for slabs too because `size = N · blockSize / 2` and `blockSize = 10`. But that's coincidence — if `BLOCK_SIZE` ever changes, recheck.

## Files touched (estimated)

- `src/cube.ts` (or new `src/cube-plain.ts`) — non-beveled cube mesh.
- `src/entity.ts` — `Shape.Slab`, `SlabState`, slab branch in update, `commitTipCube`/`canTipCube` split, mesh registration.
- `src/cube-physics.ts` — possibly a `getSlabAABB` helper, or extend `getCubeOBB` to handle slabs.
- `src/entity-interactions.ts` — slab branch in pair resolution (or reuse cube path).
- No changes needed in `main.ts` — the API contract (`onRegionChanged` callback) doesn't change; just *when* it fires.

Roughly 150-200 lines net.

## Future polish (out of scope for the core feature)

- **Particles on landing.** The slab's land callback is the natural hook — burst dust at each scaffold cell, or a single bigger puff for the whole bbox.
- **Sound on landing.** Same hook.
- **Squash-and-stretch** on the slab at impact.
- **Cube tip easing.** Separate ~15-line polish discussed in the same conversation. Currently `tip.progress * tip.endAngle` is linear; replacing with smoothstep or an asymmetric "physics tip" curve adds weighty feel. Both `getCubeOBB` (collision) and `uploadTransform` (visual) must use the same curve so the OBB doesn't drift from the rendered cube.

## Open questions

- Does the slab need to be visible to the player while *behind* the cube (e.g., during a horizontal tip where the cube is between camera and slab)? Render order should be fine since both are in the entity pass with depth, but worth checking.
- For climb tips (180° handsprings), does dropping the scaffold from "above" make sense? The scaffold is the wall the cube climbs over — it sits between the cube's source and destination. A drop-from-above feels right for horizontal walks but might feel weird for climbs. Consider: per-tip-type source position heuristics.
- Does the slab interact with the fling system (if a sphere collides with the falling slab, does it get flung along Y)? Likely yes — slabs are tipping-cube-like in being moving infinite-mass entities. Reusing fling logic gets you that for free.
