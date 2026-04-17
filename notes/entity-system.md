# Entity System

## Overview

Entities are non-voxel objects in the world — currently enemies (starting with spheres); projectiles, particles, and the player itself may become entities later. The system has three core subsystems covered in this doc:

1. **Procedural mesh generation** — shapes defined as math, not art assets
2. **Render pipeline** — dedicated shader, reuses main bind groups
3. **Lifecycle management** — `EntityManager` owns spawn/update/draw/despawn

Physics and AI are separate subsystems documented elsewhere (`entity-physics.ts` / `entity-ai.ts`). This doc stops at "how entities exist and render."

## Files

- **`src/icosphere.ts`** — procedural icosphere mesh generation
- **`src/entity-renderer.ts`** — WGSL shader, pipeline, per-entity GPU resources, draw logic
- **`src/entity.ts`** — Entity interface, `EntityManager`, material table, spawn/update/draw

## 1. Procedural Meshes (`icosphere.ts`)

Platonic shapes are mathematically defined, so there's no need for a model loader. Each shape gets a pure function that produces a vertex buffer from geometric parameters.

### Icosphere generation

Start from an icosahedron (12 vertices, 20 triangles). Subdivide each triangle into 4 by adding midpoints, normalize new vertices to the unit sphere, repeat. Subdivision count is configurable; default is 3 (1,280 triangles — smooth without being expensive).

Midpoint caching during subdivision avoids duplicating shared edges. Cache key packs the pair of parent vertex indices via `lo * stride + hi`.

### Vertex format

```
position(3f) + normal(3f) + uv(2f) = 8 floats per vertex, 32 bytes
```

Normals equal position (unit sphere property). Non-indexed triangle list — three vertices per triangle emitted directly.

### Why non-indexed?

Indexed geometry would let us share vertices, but spherical UV mapping has a seam at `u = 0 / u = 1`. Triangles spanning the seam need split vertices with different UV values. Non-indexed lets us handle each triangle independently — no index remapping, no duplicate vertex tracking. Vertex count stays small enough (5,120 verts at subdivision 3 = ~164 KB) that the memory cost is negligible.

### UV seam handling

Spherical mapping: `u = atan2(z, x) / 2π + 0.5`, `v = asin(y) / π + 0.5`. For each triangle, after computing vertex UVs, check if the triangle crosses the seam (`max(u) - min(u) > 0.5`). If so, add 1.0 to any vertex u below 0.25. The texture sampler uses `repeat` wrap mode, so u-values > 1 sample correctly.

## 2. Render Pipeline (`entity-renderer.ts`)

A dedicated WebGPU pipeline, slotted into the render loop between voxel geometry + wireframe and the skybox.

### Bind groups

**Group 0 (shared)** — reuses the main shader's bind group exactly:

- binding 0: `uniformBuffer` (VP matrix, eye position, fog + lighting params)
- binding 1: block texture sampler
- binding 2: block texture array (`texture_2d_array<f32>`)
- binding 3: skybox sampler
- binding 4: skybox cubemap (`texture_cube<f32>`)

Entities share the texture array with blocks. A marble sphere samples the MARBLE layer — the same texture the voxel mesher uses for marble blocks. This is a clean byproduct of the material system (below) rather than a dedicated entity texture pipeline.

**Group 1 (per-entity)** — one uniform buffer, 80 bytes:

```wgsl
struct EntityUniforms {
    model: mat4x4f,   // 64 bytes
    texLayer: u32,    // 4 bytes
    texScale: f32,    // 4 bytes
    // struct pads to 80 per WGSL alignment
}
```

Written each frame via `updateEntityTransform` (model matrix) and once at spawn (texLayer, texScale).

### Vertex buffer layout

Matches icosphere's output: three attributes, 32-byte stride.

```ts
{ shaderLocation: 0, offset: 0,  format: 'float32x3' }   // position
{ shaderLocation: 1, offset: 12, format: 'float32x3' }   // normal
{ shaderLocation: 2, offset: 24, format: 'float32x2' }   // uv
```

### Shader

Vertex stage transforms position by `model * position`, then `VP * worldPos`. Normal is rotated by model (sphere uses uniform scale, so `normalize(mat3(model) * normal)` is correct). UV is multiplied by `entity.texScale` to keep texture density size-independent — without this, scaling the sphere stretches the marble pattern.

Fragment stage uses smooth diffuse lighting (`max(dot(n, LIGHT_DIR), 0)`) unlike the voxel shader's per-face step function. Same sky-tinted specular and distance fog as voxels, so entities blend with the scene.

### Why a separate pipeline from voxels?

Vertex format differs (no AO, no per-vertex texLayer), lighting model differs (smooth vs per-face), and entities don't need chunk-offset uniforms. Forcing voxels and entities through a single pipeline would add branches to both shaders and complicate the vertex layout.

### Draw order

Inside the main render pass: voxel geometry → wireframe (if enabled) → **entities** → skybox. Entities render with standard `less` depth test and write depth, so they correctly occlude and are occluded by terrain. Skybox's `less-equal` depth test renders behind all opaque geometry as usual.

### Mesh sharing

`EntityRenderer` is pipeline-only. Per-entity GPU state (uniform buffer + bind group + vertex buffer reference) is built by `createEntityRenderData`. The vertex buffer can be shared across entities of the same shape — `EntityManager` caches one buffer per Shape (see below).

## 3. Lifecycle (`entity.ts`)

`EntityManager` owns all live entities and drives per-frame updates.

### The 5 axes

Entities are defined by composable axes:

- **Shape** — mesh geometry, movement physics archetype, behavior palette (currently: `Sphere`, `Cube`). Drives which mesh is used and, eventually, which physics code runs.
- **Material** — texture + physical stats. Indexed into a static `materials` table holding `texLayer`, `textureScale`, `density`, `baseSpeed`, `hardness`, `restitution`.
- **Role** — AI strategy from the shape's palette (`Rush`, `Zone`, `Crush`). Interpreted by `entity-ai.ts` via dispatch.
- **Size** — scaling multiplier (stored as `scale` on the entity). Uniform; affects rendered size, collision radius, and eventually mass.
- **Traits** — bolt-on behavioral modifiers. Currently an unused `number[]`; reserved for future features like "splitter" (spawns copies on death), "bomber" (explodes on contact), etc.

### Entity interface

```ts
interface Entity {
    id, x, y, z,                            // identity + position
    vx, vy, vz,                             // velocity (physics consumes/writes)
    orientation: Float32Array<ArrayBuffer>, // mat4, accumulated visual rotation
    grounded: boolean,                      // set by physics, read by AI
    scale,                                  // size axis
    mass,                                   // cached at spawn from material+size
    restitution,                            // cached at spawn from material
    shape, material, role, traits,          // remaining axes
    renderData: EntityRenderData,           // GPU resources
}
```

Orientation is stored as a matrix rather than Euler angles so physics (visual rolling) can accumulate rotation around arbitrary axes without gimbal concerns.

`mass` and `restitution` are derived from the material table at spawn and cached on the Entity so hot paths (AI, physics, sphere-sphere resolution) don't re-look-up per frame. See `entity-physics-and-ai.md` for the mass derivation details.

### SpawnConfig

Spawn takes a config object rather than positional args:

```ts
entityManager.spawn({
    shape, material, role,
    x, y, z, size,
    vx?, vy?, vz?,     // optional initial velocity
    traits?,
});
```

Object form scales cleanly as new axes get added (future: `health`, `modelScale` vs `physicsScale`, etc.) without breaking every call site.

### Material table

Static `Record<Material, MaterialProperties>` defined at module scope. Consumed by:

- Render spawn — `texLayer` picks the texture array slice; `textureScale` + `size` compute per-entity `texScale`
- Spawn-time caching — `density` and entity `size` produce `mass`; `restitution` is copied to the Entity. Both then live on the Entity for hot-path access.
- Physics — `entity.restitution` combined via `max()` for wall bounces, player bounces, and sphere-sphere bounces; `entity.mass` drives mass-weighted depenetration and impulse for sphere-sphere collisions
- AI — `baseSpeed` scales thrust acceleration; `entity.mass` divides effective accel and dilates the drag time constant (heavy = sluggish in both directions)

Materials like `Marble`, `Brick`, `DarkMarble` currently cover the voxel block types (reusing those textures). New entity-specific materials would expand the table without changing call sites.

### Mesh caching

`EntityManager` holds a `Map<Shape, CachedMesh>`. First spawn of a shape runs the generator (e.g., `createIcosphere`) and uploads the vertex buffer. Subsequent spawns of the same shape reuse that vertex buffer — only the per-entity uniform buffer + bind group are freshly allocated. Makes spawning many enemies cheap.

### Per-frame pipeline

`update(dt, playerPos, playerHalfWidth, playerHeight)` called each frame from `main.ts`. Runs in **three passes** over the entity list:

**Pass 1 — per-entity AI + solo physics:**

1. **AI tick** — `entityAITick` writes to velocity (thrust toward player, drag, etc.)
2. **Physics tick** — `entityPhysicsTick` applies gravity, integrates position, resolves voxel + player collisions, wraps horizontal position, updates visual rolling

AI runs before physics within the same entity so velocity changes are integrated the same tick.

**Pass 2 — all-pairs sphere-vs-sphere resolution:**

`resolveSpherePair(a, b, ww)` invoked for each (i,j) sphere pair (O(n²)). Splitting this out of the per-entity loop means each pair sees finalized post-integration positions on both sides — pair-by-pair inside Pass 1 would be order-dependent and asymmetric.

**Pass 3 — per-entity render offset + upload:**

3. **Render offset** — compute wrap-aware offset vs. player position (same trick as chunk render offsets): if the entity is more than half a world away, shift display by ±worldWidth so it renders on the near wrap
4. **Upload transform** — build model matrix (`translation * orientation * scale`), apply render offset, write to entity's uniform buffer

### Block placement guard

`blockIntersectsEntity(bx, by, bz): boolean` — used by `tryPlaceBlock` (in `placement.ts`) to reject placements that would crush an entity. Wrap-aware: before the sphere-vs-AABB closest-point test, shift the block to the wrapped copy nearest the entity so border placements work correctly.

### What EntityManager doesn't own

- Physics math (in `entity-physics.ts`)
- AI decisions (in `entity-ai.ts`)
- Shader / pipeline / draw commands (in `entity-renderer.ts`)
- Block placement rules (in `placement.ts`)

`EntityManager` is a thin orchestrator — it holds state, delegates work, and passes the right arguments to each subsystem. New subsystems (e.g., particle effects on death) plug in at the same orchestration layer.

## Constants

Render-side constants in `entity-renderer.ts`:

| Constant | Value | Purpose |
|---|---|---|
| `ENTITY_UNIFORM_SIZE` | 80 | Group-1 uniform buffer size (WGSL-aligned) |

No tunables in `entity.ts` or `icosphere.ts` — icosphere subdivision count is an argument, material values are data.
