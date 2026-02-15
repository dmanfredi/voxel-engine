# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pillarman is a WebGPU-based voxel engine prototype written in TypeScript. It renders Minecraft-like voxel terrain using Perlin noise generation, greedy mesh optimization, and a skybox cubemap. Requires a WebGPU-capable browser.

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

Rendering is on-demand: frames only redraw on user input or UI changes via `requestRender()`.

### Chunk & Mesh Generation

- **block-builder.ts** generates a 128×128×128 block array using Perlin noise (frequency 0.1). Blocks indexed as `blocks[y][z][x]`, block size = 10 world units.
- **greedy-mesh.ts** implements greedy meshing across all 3 axes, merging coplanar adjacent faces into larger quads. Culls interior faces between solid blocks. Output is a triangle list with vertex format: `[position(3) + uv(2) + color(1)] × 4 bytes = 24 bytes/vertex`.

### Shaders

All WGSL shaders are defined as TypeScript string constants:
- **shader.ts** — main vertex/fragment with `mat4x4` view-projection uniform, nearest-filtered texture
- **wireframe.ts** — barycentric edge detection with smooth antialiasing
- **skybox.ts** — cubemap sampling using `viewDirectionProjectionInverse` uniform; also handles cubemap texture loading and mipmap generation
- **shared.ts** — reusable WGSL binding declarations

### Supporting Modules

- **Block.ts** — block type enum (`DIRT`, `NOTHING`)
- **debug.ts** — stats.js FPS counter + Tweakpane panel (wireframe toggle, vertex count)

### Camera & Input

FPS-style camera with pointer lock. WASD movement, QE vertical, mouse look. Pitch clamped to ±88°. Speed: 500 units/sec. Uses `KeyW`-style codes (layout-independent).

## TypeScript Configuration

Strict mode with additional flags: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. Target ES2022, ESNext modules. WebGPU types via `@webgpu/types`.

## Code Style

Respect the TypeScript and ESLint configurations as they are. Do not suppress lint rules with `eslint-disable` comments (e.g. `@typescript-eslint/no-non-null-assertion`). If the checker complains, fix the underlying type issue instead — use narrower types, union types, or runtime guards so the code is provably correct without escape hatches.

## Key Dependencies

- **wgpu-matrix** — vec3/mat4 math
- **noisejs** — Perlin noise terrain generation
- **tweakpane** — debug UI controls
- **stats.js** — FPS monitoring
