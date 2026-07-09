# Skybox Integration

Pre skybox commit: main 9cfedec8079fd8604b4770c4edcdc6a4c41fd9c6
Final skybox commit main 1670d14a873ccc8d21f48d08c7163572c3218da4

See the diff to get an idea as to what was finalized.

git diff 9cfedec..1670d14 --stat # summary
git diff 9cfedec..1670d14 # full diff

## Changes

**src/skybox.ts** - Refactored from single `buildSkybox` function into:

- `initSkybox(device, presentationFormat)` - Creates pipeline, loads cubemap textures, creates uniform buffer/sampler/bind group. Called once at startup.
- `drawSkybox(pass, device, resources, viewMatrix, projectionMatrix)` - Computes `viewDirectionProjectionInverse`, uploads uniforms, issues draw call. Called each frame.

**src/main.ts** - Integration points:

- Import `initSkybox`, `drawSkybox`, `SkyboxResources`
- Call `initSkybox` after wireframe bind group creation
- Call `drawSkybox` in render loop after geometry/wireframe, before `pass.end()`
- Moved animation loop startup to end of `main()` to avoid race condition with async init

## Key Details

- Separate uniform buffer for skybox (different matrix than main shader)
- Skybox uses `depthWriteEnabled: false` and `depthCompare: 'less-equal'`
- Rendered last - only fills pixels where depth buffer is still 1.0
- `viewDirectionProjectionInverse` = `inverse(projection * viewMatrixWithoutTranslation)`

## Fixes Applied

- `import type { Mat4 }` - type-only import for TypeScript
- `Float32Array<ArrayBuffer>` cast for WebGPU buffer compatibility
- Animation loop moved after all async initialization to prevent accessing uninitialized resources
