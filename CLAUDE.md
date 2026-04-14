# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pillarman is a WebGPU-based voxel engine prototype written in TypeScript. It renders Minecraft-like voxel terrain using 3D Perlin noise generation, greedy mesh optimization, and a skybox cubemap. Requires a WebGPU-capable browser.

## Commands

```bash
npm run dev          # Start Vite dev server (localhost:5173)
npm run build        # TypeScript type-check + Vite production build
npm run typecheck    # TypeScript type checking only
npm run lint         # ESLint with strict TypeScript rules
npm run lint:fix     # Auto-fix lint issues
npm run preview      # Preview production build locally
```

No test framework is configured.

## Architecture

### Render Pipeline (src/main.ts)

The application runs a multi-chunk render loop with four ordered passes (same `GPURenderPassEncoder`, different pipelines):

1. **Main geometry pass** — textured voxel mesh with depth write
2. **Wireframe pass** — optional barycentric debug overlay (additive blend)
3. **Entity pass** — non-voxel objects (enemies). Own pipeline, reuses main bind group 0 (shared VP + textures)
4. **Skybox pass** — cubemap rendered at depth=1.0 with `less-equal` test

The game loop uses `requestAnimationFrame` for continuous ticking (physics + AI + rendering). Rendering also triggers on resize.

### Chunk & Mesh Generation

- **block-builder.ts** generates a `Uint8Array(32³)` block array per chunk. Multiple generators available (Perlin terrain, Menger sponge, etc.), selected in block-builder.ts.
- **greedy-mesh.ts** — AO-aware greedy meshing. Pure function: takes a padded block array + flat property arrays, returns vertex data. No World dependency — runs identically on main thread (sync initial load) or in a web worker (async runtime). See "Greedy Mesher Details" below.
- **mesh-worker.ts** — Comlink-exposed web worker that runs `greedyMesh`. Receives `BlockProps` once at init, then processes mesh requests with transferred buffers.
- **mesh-scheduler.ts** — Single-worker scheduler with key-based dedup, revision-checked stale result rejection, and priority queue (interactive > streaming). Main thread code submits jobs via `scheduleMesh()` and receives results via callback.

### Greedy Mesher Details (src/greedy-mesh.ts)

The mesher is a pure function: `greedyMesh(paddedBlocks, cx, cy, cz, blockSize, blockProps)`. It takes a `Uint8Array((CHUNK_SIZE+2)³)` — the chunk's blocks plus a 1-block border from all 26 neighbors — so every block lookup (including diagonal AO reads) is a single flat array access. `World.buildPaddedBlocks()` assembles this on the main thread by pre-fetching 26 neighbor chunks and copying border cells directly from their block arrays.

The mesher runs in three phases and has several non-obvious design decisions:

**Phase 1 — Mask Building (per slice):**

- Sweeps all 3 axes. For each axis, `u = (axis+1)%3`, `v = (axis+2)%3`.
- Checks blockA (at `d`) vs blockB (at `d+1`) — solid/air boundary = face.
- AO is computed here: for each face's 4 corners, checks 3 neighbor blocks on the air side (2 edge-adjacent + 1 diagonal). Standard `vertexAO` formula: both sides solid → 0, otherwise `3 - count`.
- AO is packed into the mask value: `direction * (1 + aoPacked)` where `aoPacked` is 8 bits (2 per corner). This means merge checks (`mask[a] === mask[b]`) inherently enforce matching direction AND AO.

**Phase 2 — Greedy Merge (per slice):**

- Standard greedy rectangle expansion: extend width along u, then height along v.
- Conservative AO merging: faces only merge if mask values are identical (same direction + same AO at all 4 corners). Stricter than edge-compatible merging but guarantees correct GPU interpolation.

**Phase 3 — Quad → Vertex Conversion:**

- **Normals**: derived from `axis` + `positiveFacing`.
- **AO**: integer 0-3 mapped through `AO_CURVE = [0.2, 0.45, 0.7, 1.0]` to a per-vertex float.
- **UVs** — three invariants:
    1. _World-aligned origins_: UVs use absolute block position (`originU/scale`, `originV/scale`), not quad-relative. Adjacent quads that couldn't merge still tile seamlessly at any `textureScale`.
    2. _No V-inversion_: UV = `position / scale` directly. Inverting V breaks world-alignment because V at a given position would depend on quad origin + size.
    3. _Axis 0 rotation_: X-facing faces swap U/V so texture V always maps to world Y (keeps textures upright on walls).
- **Triangulation flip**: when `ao0 + ao2 > ao1 + ao3`, splits along v1-v3 diagonal instead of v0-v2 to avoid AO interpolation artifacts.
- **Winding order**: positive=CCW, negative=CW. Combined with flip: 4 triangle orderings total.

**Vertex format**: `pos(3) + normal(3) + uv(2) + ao(1) + texLayer(1 as u32) = 10 floats = 40 bytes`. The wireframe shader reads the same buffer as storage, striding by `10u`.

### Physics & Collision (src/movement.ts, src/collision.ts)

Minecraft-style physics with tick-based simulation:

- **movement.ts** — Minecraft-like physics tick: gravity, jump velocity, ground/air drag, horizontal acceleration. Uses `MC_TICK = 0.05` as the reference timestep; all physics values scale by `dt/MC_TICK`. Two modes: physics movement (default) and freecam (`FREECAM` function, toggled via debug panel).
- **collision.ts** — AABB-vs-voxel-grid collision. `moveAndCollide()` resolves axes independently (X → Z → Y order). Player AABB is defined relative to eye position: feet at `pos.y - height`, top at `pos.y`. Returns per-axis collision flags (`onGround`, `collidedX`, `collidedZ`, `collidedCeiling`).

The player is **not** an entity — deliberate, see `notes/entity-physics-and-ai.md`. Revisit when building sphere-vs-sphere collision.

### Entity System (src/entity.ts, src/entity-renderer.ts, src/icosphere.ts, src/entity-physics.ts, src/entity-ai.ts)

Non-voxel objects (enemies, future projectiles). Managed by `EntityManager` in `src/entity.ts`. Entities are defined by 5 composable axes: **Shape** (mesh geometry, e.g. Sphere), **Material** (texture + physical stats from the `materials` table), **Role** (AI strategy: Rush / Zone / Crush), **Size** (scale), **Traits** (bolt-on modifiers, currently empty). The material table is the primary tuning surface — read by rendering (texture layer, tile density), physics (restitution), and AI (baseSpeed).

Per-frame flow for each entity: `entityAITick` → `entityPhysicsTick` → render-offset → `uploadTransform`. AI writes to velocity; physics integrates velocity into position, resolves collisions; render reflects final position. Ordering is load-bearing.

- **entity-renderer.ts** — Dedicated pipeline slotted between wireframe and skybox passes. Per-entity group-1 uniform (`model: mat4x4f, texLayer: u32, texScale: f32`, 80 bytes). Shares block texture array — entity materials map to block texture layers.
- **icosphere.ts** — Procedural unit-icosphere via midpoint subdivision. Non-indexed triangle list to sidestep UV-seam index splits.
- **entity-physics.ts** — Semi-implicit Euler mirroring `movement.ts`. Sphere-vs-voxel uses **closest-point narrowphase + contact-normal response** (not axis-separated — spheres need surface normals). Restitution is a pair property combined with `max()`. Resting-contact threshold prevents gravity-induced micro-bouncing. Wrap-aware throughout.
- **entity-ai.ts** — Role-dispatched behaviors. Only `Role.Rush` implemented: wrap-aware straight-line thrust toward player, drag-driven natural turning, mid-air steering enabled. Uses material's `baseSpeed` to scale acceleration. New roles = new switch case.

See `notes/entity-system.md` and `notes/entity-physics-and-ai.md` for deeper design rationale and deferred decisions.

### Block Placement (src/placement.ts)

`world.setBlock` is the low-level mutation primitive (for terrain gen, chunk streaming, block breaking — anything without gameplay rules). **Gameplay-driven placement** (right-click, auto-scaffold, future enemy AI) goes through `tryPlaceBlock(world, entityManager, bx, by, bz, blockId)`, which currently rejects placements that would overlap an entity. When adding new block-placing code paths, use `tryPlaceBlock` unless you specifically need to bypass the rules.

### Shaders

All WGSL shaders are defined as TypeScript string constants:

- **shader.ts** — main vertex/fragment with `mat4x4` view-projection uniform, per-face brightness (top=1.0, Z-sides=0.8, X-sides=0.6, bottom=0.5), per-vertex AO multiplied into final color
- **wireframe.ts** — barycentric edge detection with smooth antialiasing
- **skybox.ts** — cubemap sampling using `viewDirectionProjectionInverse` uniform; also handles cubemap texture loading and mipmap generation
- **shared.ts** — reusable WGSL binding declarations
- **entity-renderer.ts** (embedded WGSL) — smooth-diffuse + sky-tinted specular for spheres; UV scaled by per-entity `texScale` for size-independent texture density

### Supporting Modules

- **block.ts** — `BlockId` as numeric constants (`AIR`, `MARBLE`, `BRICK`, `DARK_MARBLE`), `BlockRegistry` mapping IDs to properties (solid, textureScale, restitution). `BlockProps` interface + `extractBlockProps()` for serializing registry data to workers.
- **world.ts** — Chunk-based world (`Map<string, Chunk>`), horizontal wrapping via modular arithmetic. `getBlock`/`setBlock`/`isSolid` wrap X/Z internally.
- **chunk-loader.ts** — Vertical chunk streaming around player.
- **mesh-scheduler.ts / mesh-worker.ts** — Worker-based meshing with priority queue, key-based dedup, revision-checked stale-result rejection.
- **auto-climb.ts** — Places a BRICK block at player's feet when there's a gap (scaffolding mechanic). Uses `tryPlaceBlock`.
- **raycast.ts** — DDA raycasting into the voxel grid for block targeting.
- **game-state.ts** — BP counter and other persistent gameplay state.
- **debug.ts** — stats.js FPS counter + Tweakpane panel (wireframe toggle, freecam toggle, vertex count, hitch detector, fog/lighting tuning)

### Camera & Input

FPS-style camera with pointer lock. WASD movement, Space jump (or freecam up), Shift freecam down. Mouse look with pitch clamped to ±88°. Uses `KeyW`-style codes (layout-independent).

## TypeScript Configuration

Strict mode with additional flags: `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. `noUncheckedIndexedAccess` is **off**. Target ES2022, ESNext modules. WebGPU types via `@webgpu/types`. Uses `verbatimModuleSyntax` (requires `import type` for type-only imports).

## Code Style

Respect the TypeScript and ESLint configurations as they are. Do not suppress lint rules with `eslint-disable` comments (e.g. `@typescript-eslint/no-non-null-assertion`). If the checker complains, fix the underlying type issue instead — use narrower types, union types, or runtime guards so the code is provably correct without escape hatches.

ESLint uses `strictTypeChecked` + `stylisticTypeChecked` rulesets. Two rules are explicitly turned off: `prefer-optional-chain` and `no-unnecessary-condition`.

After making code changes, always run `npx prettier --write "src/**/*.ts"` to format before committing or finishing.

## Key Dependencies

- **wgpu-matrix** — vec3/mat4 math
- **noisejs** — Perlin noise terrain generation
- **tweakpane** — debug UI controls
- **stats.js** — FPS monitoring
- **comlink** — worker message passing (wraps postMessage into async function calls)

## Further Reading

Deeper design rationale and "what's deferred and why" notes live in `notes/`:

- `notes/entity-system.md` — entity taxonomy, mesh generation, render pipeline, lifecycle
- `notes/entity-physics-and-ai.md` — physics model, AI dispatch, cross-cutting patterns (wrap handling, material table), explicitly deferred work
- `notes/physics-and-collision.md` — player physics and AABB-vs-voxel collision (predates entity work)
- `notes/skybox-integration.md` — skybox setup
- `notes/TECHNICAL-ROADMAP.md` — phased plan + current progress
- `notes/GAME-DESIGN.md` — game concept and design pillars
