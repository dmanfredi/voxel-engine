# AGENTS.md

This file provides guidance to AI coding agents working in this repository. It is adapted from `CLAUDE.md`; keep both files in sync when project guidance changes.

## Project Overview

Pillarman is a WebGPU-based voxel engine prototype written in TypeScript. It renders Minecraft-like voxel terrain using 3D Perlin noise generation, greedy mesh optimization, and a skybox cubemap. It requires a WebGPU-capable browser.

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

### Render Pipeline (`src/main.ts`)

The application runs a multi-chunk render loop with four ordered passes on the same `GPURenderPassEncoder`, using different pipelines:

1. Main geometry pass: textured voxel mesh with depth write.
2. Wireframe pass: optional barycentric debug overlay with additive blend.
3. Entity pass: non-voxel objects. Own pipeline, reuses main bind group 0 for shared view-projection and textures.
4. Skybox pass: cubemap rendered at depth `1.0` with `less-equal` depth testing.

The game loop uses `requestAnimationFrame` for continuous physics, AI, and rendering. Rendering also triggers on resize.

### Chunk And Mesh Generation

- `src/block-builder.ts` generates a `Uint8Array` block array per chunk. Multiple terrain generators live there.
- `src/greedy-mesh.ts` is an AO-aware pure greedy mesher. It takes padded block data plus flat property arrays, returns vertex data, and does not depend on `World`.
- `src/mesh-worker.ts` exposes the mesher through Comlink. It receives `BlockProps` once at init and processes mesh requests with transferred buffers.
- `src/mesh-scheduler.ts` is a single-worker scheduler with key-based deduplication, revision-checked stale result rejection, and interactive/streaming priority queues.

Important mesher invariants:

- `World.buildPaddedBlocks()` assembles a chunk plus a 1-block border from all neighbors so face and AO lookups stay flat and local.
- AO is packed into mask values, so greedy merges require matching direction and matching AO at all four corners.
- UVs are world-aligned, not quad-relative. Do not invert V or break axis-specific texture orientation without checking the downstream visual result.
- Triangulation may flip to reduce AO interpolation artifacts.
- Vertex format is `pos(3) + normal(3) + uv(2) + ao(1) + texLayer(1 as u32)`, for 10 floats / 40 bytes. The wireframe shader assumes this stride.

### Physics And Collision

- `src/movement.ts` implements Minecraft-like tick-based player physics. It supports physics movement and freecam.
- `src/collision.ts` resolves AABB-vs-voxel-grid collision axis-by-axis in X, Z, then Y order.
- The player is intentionally not an entity. See `notes/systems/entity-physics-and-ai.md` before revisiting player-as-entity work.

### Entity System

The entity system is centered on `EntityManager` in `src/entity.ts`. Entities are composed from Shape, Material, Role, Size, and Traits. The material table is the primary tuning surface for rendering, physics, and AI.

Per-frame entity flow runs in three passes:

1. AI then physics for each entity.
2. Pairwise sphere collision resolution.
3. Render offset and transform upload.

Relevant files:

- `src/entity-renderer.ts`: dedicated entity pipeline and per-entity uniforms.
- `src/icosphere.ts`: procedural non-indexed unit icosphere.
- `src/entity-physics.ts`: sphere-vs-voxel and sphere-vs-sphere collision.
- `src/entity-ai.ts`: role-dispatched AI. `Role.Rush` is implemented.

See `notes/systems/entity-system.md` and `notes/systems/entity-physics-and-ai.md` for design rationale and deferred decisions.

### Projectile And Tool System

The player's interface to the world lives in `src/tool.ts`, `src/projectile.ts`, `src/projectile-manager.ts`, and `src/projectile-renderer.ts`.

- Tools are singletons held in `gameState.tools`; the selected slot is `gameState.selectedToolIndex`.
- Each tool bundles an LMB projectile action and an RMB block placement action resolved through a `BuildProfile`.
- `canFire(tool, side, gameState)` is the one-place gate before firing.
- LMB and RMB support autofire; cooldowns are the rate limiter and persist across slot switches.
- Projectiles spawn at a camera-local offset, travel straight, and break each solid block their OBB overlaps until strength is exhausted.
- Each projectile carries a `sourceTool` back-reference so break callbacks can dispatch tool-specific effects without attached closures.

See `notes/systems/projectile-and-tool-system.md` for details.

### Block Placement

`world.setBlock` is the low-level mutation primitive for terrain generation, chunk streaming, block breaking, and other rule-free writes.

Gameplay-driven placement should go through `tryPlaceBlock(world, entityManager, bx, by, bz, blockId)` from `src/placement.ts`, which currently rejects placements overlapping an entity. Use `tryPlaceBlock` for right-click placement, auto-scaffold, future enemy placement, and similar rule-aware paths unless bypassing gameplay rules is intentional.

### Shaders

All WGSL shaders are TypeScript string constants:

- `src/shader.ts`: main voxel vertex/fragment shader.
- `src/wireframe.ts`: barycentric edge detection with smooth antialiasing.
- `src/skybox.ts`: cubemap sampling, texture loading, and mipmap generation.
- `src/shared.ts`: reusable WGSL binding declarations.
- `src/entity-renderer.ts`: embedded WGSL for entity rendering.

### Supporting Modules

- `src/block.ts`: block IDs, registry, block properties, and worker serialization helpers.
- `src/world.ts`: chunk-based world storage with horizontal wrapping in X/Z.
- `src/chunk-loader.ts`: vertical chunk streaming around the player.
- `src/auto-climb.ts`: scaffolding mechanic; uses `tryPlaceBlock`.
- `src/raycast.ts`: DDA voxel raycasting for block targeting.
- `src/game-state.ts`: BP counter, hotbar tools, and selected slot.
- `src/toolbar.ts`: hotbar UI and selection input.
- `src/debug.ts`: stats.js FPS counter and Tweakpane debug panel.

### Camera And Input

The camera is FPS-style with pointer lock. Movement uses layout-independent key codes such as `KeyW`. Mouse pitch is clamped.

## TypeScript Configuration

The project uses strict TypeScript with additional flags including `exactOptionalPropertyTypes`, `noImplicitReturns`, and `noFallthroughCasesInSwitch`. `noUncheckedIndexedAccess` is off. Target is ES2022 with ESNext modules, WebGPU types from `@webgpu/types`, and `verbatimModuleSyntax`, so use `import type` for type-only imports.

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

- Avoid version refs such as `v1`.
- Avoid specific tuning values in prose when the code already owns the value.
- Avoid specific block, tool, or material names in cross-cutting docs when the concept is enough.
- Avoid historical anchors like `old behavior` once the predecessor is gone.
- Use prospective flags such as `(TODO when art lands)` or `(future)` when incompleteness matters.
- Use durable external references such as `Minecraft-style` or `Amanatides & Woo` when helpful.

Dead code kept as a warning record is fine when it explains why a tempting path was rejected.

## Key Dependencies

- `wgpu-matrix`: vector and matrix math.
- `noisejs`: Perlin noise terrain generation.
- `tweakpane`: debug UI controls.
- `stats.js`: FPS monitoring.
- `comlink`: worker message passing.

## Further Reading

Deeper design rationale and deferred decisions live in `notes/`. Start at `notes/_index.md`:

- `notes/systems/entity-system.md`: entity taxonomy, mesh generation, render pipeline, lifecycle.
- `notes/systems/entity-physics-and-ai.md`: physics model, AI dispatch, wrap handling, material table, deferred work.
- `notes/systems/spawning-and-despawning.md`: enemy lifecycle and Director pacing.
- `notes/systems/flow-field.md`: shared BFS pursuit field.
- `notes/systems/sticky-spheres.md`: flow-field invalidation and sphere drop-zone spawning.
- `notes/systems/cube-enemy.md`: cube enemy design and phased implementation plan.
- `notes/proposals/cube-tip-placement-animation.md`: designed-not-built tip-scaffold animation.
- `notes/systems/projectile-and-tool-system.md`: tool and projectile system details.
- `notes/systems/void-floor.md`: rising void hazard.
- `notes/systems/physics-and-collision.md`: player physics and AABB-vs-voxel collision.
- `notes/systems/skybox-integration.md`: skybox setup.
- `notes/TECHNICAL-ROADMAP.md`: phased plan and current progress.
- `notes/GAME-DESIGN.md`: game concept and design pillars.
