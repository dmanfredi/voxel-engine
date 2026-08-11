# Notes Index

This folder is organized by note purpose, not by freshness. A doc can contain both durable decisions and stale status notes; when that happens, keep it in the folder that best describes what kind of note it is and mark freshness inside the file.

## Top Level

Project-wide docs and loose notes that do not need a narrower home yet.

- `GAME-DESIGN.md` - game concept and design pillars. Git-ignored.
- `TECHNICAL-ROADMAP.md` - phased plan and progress snapshot. Git-ignored; some status is known stale.
- `Parquet-Parquet-Parquet.txt` - tiny loose scrap.

## systems/

Durable subsystem references and implementation design notes. These are the first stop when changing code in a specific area.

- `cube-enemy.md` - cube enemy design, tipping, climbing, Breacher trait, and Crush/Zone role notes.
- `entity-physics-and-ai.md` - entity physics model, AI dispatch, deferred decisions.
- `entity-system.md` - entity taxonomy, mesh generation, render pipeline, lifecycle.
- `flow-field.md` - shared BFS pursuit field and invalidation model.
- `physics-and-collision.md` - player movement and AABB-vs-voxel collision.
- `projectile-and-tool-system.md` - tools, projectiles, hitboxes, rendering, input flow.
- `skybox-integration.md` - skybox setup notes and commit pointers.
- `spawning-and-despawning.md` - enemy lifecycle, director, spawn radius/pathing coupling.
- `sticky-spheres.md` - sticky sphere locomotion and drop-zone behavior.
- `void-floor.md` - rising void hazard, bands, chunk-delete floor, deferred visuals.
- `water-geometry-reflections.md` - water reflection attempts and active approach notes.

## sessions/

Dated after-action reports. These are historical context and decision records, not live status dashboards.

- `session-2026-02-23.md` - world abstraction, block registry, texture array.
- `session-2026-03-04-cubic-chunks.md` - cubic chunks and per-chunk meshing.
- `session-2026-03-28-world-wrapping-chunk-loading.md` - horizontal wrapping and vertical streaming.
- `session-2026-03-31-worker-meshing.md` - worker meshing and scheduler design.
- `session-2026-04-05-gc-investigation.md` - GC investigation and profiler lessons.

## proposals/

Designed but not implemented, or intentionally parked implementation plans.

- `cube-tip-placement-animation.md` - proposed falling-slab animation for cube scaffold placement.

## reference/

Copied research, learning notes, snippets, and external-formula material.

- `graphics-and-lighting.txt` - rendering/lighting research brainstorm. Git-ignored.
- `notes-on-performance.txt` - performance and frame-budget learning notes.
- `orginal-movement-reference/` - copied movement formula references.
- `water-reflect-offset.txt` - shader snippet for water reflection offset.
- `webgpu-fundementals-enviroment-maps.txt` - copied WebGPU environment-map reference.

## Known Follow-Ups

- `TECHNICAL-ROADMAP.md` still says cube enemy behavior is unimplemented, but cube behavior and Crush are now partly live.
