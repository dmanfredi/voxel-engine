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

The application runs a single-chunk render loop with three ordered passes:
1. **Main geometry pass** — textured voxel mesh with depth write
2. **Wireframe pass** — optional barycentric debug overlay (additive blend)
3. **Skybox pass** — cubemap rendered at depth=1.0 with `less-equal` test

The game loop uses `requestAnimationFrame` for continuous ticking (physics + rendering). Rendering also triggers on resize.

### Chunk & Mesh Generation

- **block-builder.ts** generates a 128×128×128 block array using 3D Perlin noise (frequency 0.081). Blocks indexed as `blocks[y][z][x]`, block size = 10 world units. Solid blocks where `perlin3 > 0`.
- **greedy-mesh.ts** — AO-aware greedy meshing. See "Greedy Mesher Details" below.

### Greedy Mesher Details (src/greedy-mesh.ts)

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
  1. *World-aligned origins*: UVs use absolute block position (`originU/scale`, `originV/scale`), not quad-relative. Adjacent quads that couldn't merge still tile seamlessly at any `textureScale`.
  2. *No V-inversion*: UV = `position / scale` directly. Inverting V breaks world-alignment because V at a given position would depend on quad origin + size.
  3. *Axis 0 rotation*: X-facing faces swap U/V so texture V always maps to world Y (keeps textures upright on walls).
- **Triangulation flip**: when `ao0 + ao2 > ao1 + ao3`, splits along v1-v3 diagonal instead of v0-v2 to avoid AO interpolation artifacts.
- **Winding order**: positive=CCW, negative=CW. Combined with flip: 4 triangle orderings total.

**Vertex format**: `pos(3) + normal(3) + uv(2) + ao(1) + color(1 as u8×4) = 10 floats = 40 bytes`. The wireframe shader reads the same buffer as storage, striding by `10u`.

### Physics & Collision (src/movement.ts, src/collision.ts)

Minecraft-style physics with tick-based simulation:
- **movement.ts** — Minecraft-like physics tick: gravity, jump velocity, ground/air drag, horizontal acceleration. Uses `MC_TICK = 0.05` as the reference timestep; all physics values scale by `dt/MC_TICK`. Two modes: physics movement (default) and freecam (`FREECAM` function, toggled via debug panel).
- **collision.ts** — AABB-vs-voxel-grid collision. `moveAndCollide()` resolves axes independently (X → Z → Y order). Player AABB is defined relative to eye position: feet at `pos.y - height`, top at `pos.y`. Returns per-axis collision flags (`onGround`, `collidedX`, `collidedZ`, `collidedCeiling`).

### Shaders

All WGSL shaders are defined as TypeScript string constants:
- **shader.ts** — main vertex/fragment with `mat4x4` view-projection uniform, per-face brightness (top=1.0, Z-sides=0.8, X-sides=0.6, bottom=0.5), per-vertex AO multiplied into final color
- **wireframe.ts** — barycentric edge detection with smooth antialiasing
- **skybox.ts** — cubemap sampling using `viewDirectionProjectionInverse` uniform; also handles cubemap texture loading and mipmap generation
- **shared.ts** — reusable WGSL binding declarations

### Supporting Modules

- **Block.ts** — block type as string constants (`DIRT`, `NOTHING`), `Block` class wrapping a type
- **debug.ts** — stats.js FPS counter + Tweakpane panel (wireframe toggle, freecam toggle, vertex count)

### Camera & Input

FPS-style camera with pointer lock. WASD movement, Space jump (or freecam up), Shift freecam down. Mouse look with pitch clamped to ±88°. Uses `KeyW`-style codes (layout-independent).

## TypeScript Configuration

Strict mode with additional flags: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. Target ES2022, ESNext modules. WebGPU types via `@webgpu/types`. Uses `verbatimModuleSyntax` (requires `import type` for type-only imports).

## Code Style

Respect the TypeScript and ESLint configurations as they are. Do not suppress lint rules with `eslint-disable` comments (e.g. `@typescript-eslint/no-non-null-assertion`). If the checker complains, fix the underlying type issue instead — use narrower types, union types, or runtime guards so the code is provably correct without escape hatches.

ESLint uses `strictTypeChecked` + `stylisticTypeChecked` rulesets. Two rules are explicitly turned off: `prefer-optional-chain` and `no-unnecessary-condition` (due to `noUncheckedIndexedAccess` making many conditions technically necessary).

After making code changes, always run `npx prettier --write "src/**/*.ts"` to format before committing or finishing.

## Key Dependencies

- **wgpu-matrix** — vec3/mat4 math
- **noisejs** — Perlin noise terrain generation
- **tweakpane** — debug UI controls
- **stats.js** — FPS monitoring
