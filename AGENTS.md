# AGENTS.md

This file provides guidance to AI coding agents working in this repository. It is adapted from `CLAUDE.md`; keep both files in sync when project guidance changes.

## Project Overview

Pillarman is a WebGPU-based voxel engine prototype written in TypeScript. It renders chunked, Minecraft-like terrain from procedural generators, supports player mining and construction tools, and runs shape-specific enemy AI and physics. It requires a WebGPU-capable browser.

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

### Runtime And Render Pipeline (`src/main.ts`)

The `requestAnimationFrame` loop advances player movement, the rising void, auto-climb, spawning, entities, projectiles, growths, tool cooldowns, and held-button autofire. Runtime world mutations notify the chunk remesher and invalidate the shared enemy flow field where appropriate.

Rendering uses one `GPURenderPassEncoder` with different pipelines in this order:

1. Textured voxel terrain with depth writes.
2. Optional barycentric wireframe overlay.
3. Entities.
4. Projectiles.
5. Skybox at depth `1.0` with `less-equal` depth testing.
6. Translucent void-floor planes.
7. Crush telegraph beams over the scene.

Rendering also runs on resize. The former targeted-block highlight was removed; do not assume an outline or ghost-preview pipeline still exists.

### Chunk And Mesh Generation

- `src/block-builder.ts` selects procedural generators and returns one `Uint8Array` per chunk. The active terrain is composed from the selected generators; Perlin and other alternatives remain available but are not necessarily active.
- `src/greedy-mesh.ts` is an AO-aware pure greedy mesher. It takes padded block data plus flat property arrays, returns vertex data, and does not depend on `World`.
- `src/mesh-worker.ts` exposes the mesher through Comlink. It receives `BlockProps` once at initialization and processes mesh requests with transferred buffers.
- `src/mesh-scheduler.ts` is a single-worker scheduler with key-based deduplication, revision-checked stale-result rejection, and interactive/streaming priority queues.

Important mesher invariants:

- `World.buildPaddedBlocks()` assembles a chunk plus a one-block border from all 26 neighbors so face and AO lookups stay flat and local.
- AO is packed into mask values, so greedy merges require matching direction and matching AO at all four corners.
- UVs are world-aligned, not quad-relative. Do not invert V or break axis-specific texture orientation without checking the downstream visual result.
- Triangulation may flip to reduce AO interpolation artifacts.
- Vertex format is `pos(3) + normal(3) + uv(2) + ao(1) + texLayer(1 as u32)`, for 10 floats / 40 bytes. The wireframe shader assumes this stride.

### Player Physics And Collision

- `src/movement.ts` implements Minecraft-like tick-scaled player physics and freecam.
- `src/collision.ts` resolves the player's AABB against the voxel grid axis-by-axis in X, Z, then Y order.
- `src/auto-climb.ts` can place a scaffold beneath the player during the post-jump activation window. It is a gameplay placement path and spends BP.

The player is intentionally not an entity. Player-vs-entity interactions are routed explicitly through the entity physics/interaction code. Read `notes/systems/entity-physics-and-ai.md` before revisiting player-as-entity work.

### Entity System

`EntityManager` in `src/entity.ts` owns enemy lifecycle, mesh caching, flow-field refresh, shape-dispatched simulation, interactions, despawning, and transform upload. Entities are composed from Shape, Material, Role, Size, and Traits.

- Shapes are Sphere and Cube. `src/icosphere.ts` and `src/cube.ts` generate their meshes.
- Materials have a shared base plus optional shape-specific tuning. Spawning validates material/shape compatibility.
- Live behaviors are `Role.Rush` for spheres and `Role.Crush` for cubes. `Role.Zone` remains a deferred behavior.
- `Trait.Breacher` is cube-only. Breachers can carve blocked tip destinations and swept climb volume; use `traitSupportsShape()` in authoring/debug paths.

The per-frame entity flow is:

1. Rebuild the shared `FlowField` on its bounded cadence when player-cell, terrain, or maximum sphere reach changes.
2. Run shape-specific AI and solo physics: flow-field-guided sticky sphere pursuit, or greedy cube tipping/crush progression.
3. Resolve sphere/sphere and sphere/cube pairs. Cubes act as infinite mass against spheres; cube/cube resolution is deferred.
4. Resolve player/cube contact against the cube's true oriented box.
5. Advance despawn/death state, then upload player-relative wrapped transforms.

Relevant files:

- `src/entity.ts`: entity data, material tables, lifecycle orchestration, cube scaffold/carve integration, death and Crush payloads.
- `src/entity-ai.ts` and `src/flow-field.ts`: sphere pursuit and shared BFS navigation.
- `src/sphere-physics.ts`: sticky sphere-vs-voxel/player physics.
- `src/cube-ai.ts` and `src/cube-physics.ts`: greedy tip selection, grid-aligned tipping, and cube collision.
- `src/entity-interactions.ts`: sphere/sphere, sphere/cube, and player/cube responses plus player-hit lockout.
- `src/entity-physics-shared.ts`: shared physics constants.
- `src/entity-renderer.ts`: shared entity pipeline and per-entity uniforms/tints.
- `src/crush-beam-renderer.ts`: Crush lane telegraph rendering.

Any terrain mutation that affects navigation must invalidate the flow field. Batch invalidation and remeshing for multi-cell operations rather than notifying once per cell.

### Spawning And Despawning

`src/spawner.ts` combines a constant-pressure Director stub with terrain-driven spawning. A successful spawn finds a bounded, exposed, uniform solid cluster near the player, consumes it, inherits its material, and creates an enemy in the cavity. Shape biases the vertical search band, and eligible cubes have a small chance to receive the Breacher trait.

The spawner uses bounded per-search work and a retry cooldown. A full population pauses one outstanding spawn ticket rather than accumulating spawn debt. Keep spawn radius, flow-field reach, and no-path despawn timing coupled; see `notes/systems/spawning-and-despawning.md`.

Shape dispatch also controls death: spheres run a telegraphed self-destruct and terrain-carving blast, while cubes use their own lifecycle, including the Crush telegraph/carve/plummet sequence and petrification paths described in the system notes.

### Projectile, Tool, And Growth Systems

The player's interface to the world lives in `src/tool.ts`, `src/projectile.ts`, `src/projectile-manager.ts`, `src/projectile-renderer.ts`, `src/timing.ts`, and `src/growth.ts`.

- Tools are singletons stored in nullable `gameState.tools` hotbar slots; `gameState.selectedToolIndex` selects the active slot. Mutable cooldowns persist across slot switches.
- LMB fires the tool's mining projectile. RMB either fires a paired build projectile/growth profile or, for tools without that pair, performs raycast-dependent instant placement through a `BuildProfile`.
- `canFire(tool, side, gameState)` is the shared gate for cooldown, BP, and player-hit lockout checks. LMB and RMB autofire while held when their mode supports it.
- `ProjectileEffect.Mine` sweep-breaks every solid cell reported by its hitbox, then spends strength by block hardness. `ProjectileEffect.Build` stops at its first solid contact and reports an `ImpactContext`; it does not mine.
- Projectile motion supports normalized timing functions from `src/timing.ts`. The manager differences the timing curve over each frame and collision-samples motion in at most half-block substeps to prevent tunneling.
- Projectiles use OBB or compound hitboxes, wrap canonically in X/Z, and apply player-relative wrapping only to rendering. They currently phase through entities.

A build impact hands off to `GrowthManager`:

- `GrowthProfile` is frozen design data held by a Tool.
- `GrowthPlanner` is a pure `ImpactContext -> ordered cells` function. All build-type geometry belongs in planners; the manager must not branch on build type.
- Plans are computed once and never rerouted. Growth advances at a per-cell rate, skips blocked cells without charging, stops when its plan or budget is exhausted, and batches remesh/flow-field notification across the frame.
- The manager deliberately does not depend on `GameState`; affordability and player-overlap policy arrive through callbacks so future non-player sources can reuse it.
- `buildProjectile` and `growth` are an invariant pair enforced by `defineTool()`.

See `notes/systems/projectile-and-tool-system.md` and `notes/systems/growth-and-build-projectiles.md` before changing these seams. The previous multi-cell ghost outline was built and removed; its rationale is recorded in `notes/sessions/session-2026-08-18-build-pivot.md`.

### Block Placement

`world.setBlock` is the low-level mutation primitive for terrain generation, chunk streaming, block breaking, and other rule-free writes.

Gameplay-driven single-cell placement should go through `tryPlaceBlock(world, entityManager, bx, by, bz, blockId)` from `src/placement.ts`, which rejects entity overlap and invalidates the flow field after a successful write. Use it for instant RMB placement, auto-climb, and similar rule-aware paths unless bypassing gameplay rules is intentional.

Multi-cell/rate-based placers such as `GrowthManager` use `canPlaceBlock()` first. It is stricter than `tryPlaceBlock()` because it also requires the destination to be air. After validating and charging, the manager writes directly and emits one batched invalidation/remesh notification.

### Rising Void

`src/void-floor.ts` owns the presentation-independent rising hazard. It tracks one surface Y plus Safe, Grace, and Lethal bands; the lethal boundary is also the chunk-deletion floor. `src/void-floor-renderer.ts` draws the current placeholder planes. Effects and death handling are callbacks rather than GPU or UI dependencies in the logic module.

### Shaders

WGSL is stored as TypeScript string constants:

- `src/shader/voxel.ts`: main voxel vertex/fragment shader.
- `src/shader/wireframe.ts`: barycentric edge detection with smooth antialiasing.
- `src/shader/shared.ts`: reusable material and binding declarations.
- `src/shader/crush-beam.ts`: Crush telegraph shader.
- `src/shader/void-floor.ts`: void-floor shader seam.
- `src/skybox.ts`: cubemap sampling, texture loading, and mipmap generation.
- Entity and projectile WGSL remain embedded in their renderer modules.

### Supporting Modules

- `src/block.ts`: block IDs, registry, properties, and worker serialization helpers.
- `src/world.ts`: chunk-based storage with horizontal X/Z wrapping. Block queries wrap internally.
- `src/chunk-loader.ts`: vertical streaming and deletion below the void floor.
- `src/raycast.ts`: DDA voxel raycasting for block targeting.
- `src/game-state.ts`: BP, hit lockout, nullable hotbar slots, and selected slot.
- `src/toolbar.ts`: stateless hotbar UI and selection input.
- `src/debug.ts`: stats.js FPS counter and Tweakpane controls/hooks.

### Camera And Input

The camera is FPS-style with pointer lock. Movement uses layout-independent key codes such as `KeyW`; mouse pitch is clamped. LMB/RMB held state is sampled by the frame loop, with tool cooldowns acting as rate limiters.

## TypeScript Configuration

The project uses strict TypeScript with additional flags including `exactOptionalPropertyTypes`, `noImplicitReturns`, and `noFallthroughCasesInSwitch`. `noUncheckedIndexedAccess` is off. Target is ES2022 with ESNext modules, WebGPU types come from `@webgpu/types`, and `verbatimModuleSyntax` requires `import type` for type-only imports.

## Code Style

Respect the TypeScript and ESLint configurations as they are. Do not suppress lint rules with `eslint-disable` comments, including `@typescript-eslint/no-non-null-assertion`. Fix the underlying type issue with narrower types, unions, or runtime guards.

ESLint uses `strictTypeChecked` and `stylisticTypeChecked` rulesets. Two rules are explicitly disabled: `prefer-optional-chain` and `no-unnecessary-condition`.

After making code changes, always run:

```bash
npx prettier --write "src/**/*.ts"
```

Use the command list above for verification appropriate to the change, usually `npm run typecheck`, `npm run lint`, or `npm run build`.

### Comment Discipline

Comments should carry load-bearing why: non-obvious design choices, invariants the code cannot enforce, future pointers that prevent premature generalization, and pointers to `notes/` design docs. Avoid comments that restate the next line, repeat architecture already documented here or in notes, stack adjectives, or narrate obvious fall-through paths.

Keep comments timeless:

- Avoid version references such as `v1`.
- Avoid copying tuning values or layout dimensions into prose when code already owns them.
- Avoid specific block, tool, or material names in cross-cutting docs when the concept is enough.
- Avoid historical anchors such as `old behavior` once the predecessor is gone.
- Use prospective flags such as `(TODO when art lands)` or `(future)` when incompleteness matters.
- Use durable external references such as `Minecraft-style` or `Amanatides & Woo` when helpful.

Dead code kept as a warning record is acceptable when it explains why a tempting path was rejected.

## Key Dependencies

- `wgpu-matrix`: vector and matrix math.
- `noisejs`: Perlin noise terrain generation.
- `tweakpane`: debug UI controls.
- `stats.js`: FPS monitoring.
- `comlink`: worker message passing.

## Further Reading

Start at `notes/_index.md`. System notes contain durable subsystem decisions, session notes are historical context, and proposals describe designed but unimplemented work. Some top-level status snapshots are explicitly stale, so verify status against code and recent commits.

- `notes/systems/entity-system.md`: entity taxonomy, rendering, lifecycle, traits, and shape dispatch.
- `notes/systems/entity-physics-and-ai.md`: physics model, AI dispatch, wrapping, and deferred decisions.
- `notes/systems/spawning-and-despawning.md`: terrain-driven spawning, Director pacing, death, and despawn coupling.
- `notes/systems/flow-field.md`: shared BFS pursuit field and invalidation model.
- `notes/systems/sticky-spheres.md`: surface locomotion and drop-zone behavior.
- `notes/systems/cube-enemy.md`: cube tipping, climbing, Breacher, and Crush behavior.
- `notes/proposals/cube-tip-placement-animation.md`: designed-not-built scaffold settling animation.
- `notes/systems/projectile-and-tool-system.md`: tools, projectiles, hitboxes, timing, rendering, and input flow.
- `notes/systems/growth-and-build-projectiles.md`: build projectiles, planners, growth rate, and deliberately excluded routing.
- `notes/sessions/session-2026-08-18-build-pivot.md`: build-system pivot and abandoned outline rationale.
- `notes/systems/void-floor.md`: rising hazard, bands, chunk-deletion floor, and deferred visuals.
- `notes/systems/physics-and-collision.md`: player physics and AABB-vs-voxel collision.
- `notes/systems/skybox-integration.md`: skybox setup.
- `notes/systems/water-geometry-reflections.md`: water reflection experiments and active approach notes.
- `notes/TECHNICAL-ROADMAP.md`: phased plan and a progress snapshot; known to contain stale status.
- `notes/GAME-DESIGN.md`: game concept and design pillars.
