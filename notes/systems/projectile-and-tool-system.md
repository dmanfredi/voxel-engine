# Projectile & Tool System

## Overview

Tools are the player's only interaction with the world — block-breaking and block-placing both route through them. The system has two halves:

1. **Tool** — frozen design data (cooldowns, costs, projectile template, build profile) plus mutable cooldown state. One per hotbar slot.
2. **Projectile** — live entity spawned by a Tool's LMB; flies, collides with voxels, breaks them, disposes.

LMB fires a projectile. RMB resolves the Tool's `BuildProfile` against the raycast target and places cells. Both clocks tick independently and both autofire while their button is held.

Projectiles carry a back-reference to their `sourceTool` so the break callback can dispatch per-tool effects (BP payout, future FX) without the projectile system having to know about Tools.

## Files

- **`src/tool.ts`** — `Tool` + `BuildProfile` types, `defineTool()` factory, `canFire`, `tickToolCooldowns`, concrete tool instances (currently `pickaxeTool`)
- **`src/projectile.ts`** — `Hitbox` interface, `obbHitbox()` SAT factory, `orientationFromDirection()`, `Projectile` + `ProjectileProfile` types
- **`src/projectile-manager.ts`** — runtime: spawn, per-tick move/collide/break, render-time wrap, dispose
- **`src/projectile-renderer.ts`** — dedicated pipeline + shader, render-data lifecycle

## 1. Tool (`tool.ts`)

### Anatomy

```ts
interface Tool {
  // Identity
  name, icon, model,
  // LMB (fire)
  projectile, lmbCooldown, lmbCost, bpPerBreak,
  // RMB (build)
  buildProfile, rmbCooldown,
  // Geometry
  spawnOffset,     // camera-local [right, up, forward], world units
  // Fire mode
  chargeTime,      // null = autofire on hold
  // Runtime state
  lmbCooldownRemaining, rmbCooldownRemaining,
}
```

Construct via `defineTool(spec)` — initializes runtime state to 0 and asserts invariants the type system can't (positive cooldowns, non-negative costs). One central place to add new guards.

### Mutable state lives on the Tool

Tools are singletons (the hotbar holds references), so per-tool cooldown state is a mutable field rather than a separate runtime table. Switching from slot 1 to slot 2 mid-cooldown doesn't reset anything — state never went anywhere; the same `Tool` object is still the target, just unselected for a moment. Switching back finds whatever time remained still ticking down.

### BuildProfile

```ts
interface BuildProfile {
  blockId,
  costPerBlock,
  targetSelector(hit: RaycastHit, cameraDir): VoxelCoord[],
}
```

`targetSelector` is **the single source of truth for "where would this RMB land?"**. The committer calls it and places each returned cell; the (deferred) ghost previewer would call the same function and render each cell as a translucent ghost. Adding the previewer later doesn't change the type — the consumer just doesn't exist yet.

`singleBlockBuild(blockId, costPerBlock)` covers the trivial case (one block on the targeted face). Richer profiles (walls, stairs, scaffolds) become new `BuildProfile` factories.

### canFire as the one-place gate

```ts
canFire(tool, side, gameState) → boolean
```

Currently checks cooldown ready + sufficient BP. New gates (target validity, projectile budget, charge state, etc.) bolt on here so input handlers stay a single boolean check.

### Cooldowns

`tickToolCooldowns(tools, dt)` ticks every slot toward zero each frame, skipping nulls. The fire path resets `*CooldownRemaining` to the configured cooldown only on a successful action — RMB-into-open-air doesn't penalize the player with a wait.

### chargeTime as a field-shaped hole

`chargeTime: number | null` is the seam for charge-up tools. `null` = autofire-on-hold (current branch). A positive number would mean "hold for this many seconds, release to fire." Only the null branch is wired into the tick; the non-null case grows alongside when a charge-up tool actually needs it.

### spawnOffset

Camera-local axes `[right, up, forward]` in world units. The fire function computes `cameraRight = normalize(cross(cameraFront, cameraUp))` at emit time and reconstructs the world-space origin as `cameraPos + right·off[0] + up·off[1] + front·off[2]`. The hip-fire nudge keeps the projectile outside the camera frustum so it doesn't briefly occlude the view on emit.

## 2. Projectile (`projectile.ts`)

### Profile vs instance

- **`ProjectileProfile`** is design data, frozen and shared across spawns: `strength`, `speed`, `hitbox`, `maxLifetime`, `visualSize`.
- **`Projectile`** is the live instance: `position`, `velocity`, `orientation`, mutable `strength`, `age`, `sourceTool`, plus a reference back to the profile.

### Hitbox abstraction

```ts
interface Hitbox {
  cellsAt(position, orientation, blockSize): VoxelCoord[]
}
```

Stateless and shareable across instances. Returns the voxel cells the shape overlaps, sorted leading-edge first along the projectile's forward direction (`orientation` column 2).

The shipped implementation is `obbHitbox(halfSize)` — oriented bounding box vs axis-aligned voxel cell via SAT (15 axes: 3 OBB local + 3 world + 9 cross products). Candidate cells are enumerated from the OBB's world-AABB; each is tested in constant time.

### Iterate-until-solid

Consumers walk the returned list and process the **first solid cell**, skipping over air. Wide hitboxes can have many cells with tied forward projection; taking only `cells[0]` and giving up if it's air would lose contact when (e.g.) the leading-edge cell is the just-broken air pocket and the side cells are clipping into a wall. The leading-edge order only ranks meaningfully along the travel direction.

### Hardness rule: every contact breaks

- Every block a projectile contacts **breaks** — it never stops without destroying something.
- `strength` decrements by the block's `hardness` on every break.
- The projectile disposes once `strength ≤ 0`, so the killing blow still lands a break: the leftover strength is spent on it rather than evaporating against a wall it can't afford.
- Disposes on: `strength ≤ 0` after a break, or `age ≥ maxLifetime`.

Strength gates **penetration depth**, not whether a given block breaks. A weak projectile still clears one block per shot against an arbitrarily hard wall (the killing blow breaks regardless of hardness) — so there's no such thing as an indestructible block. Add a `hardness === Infinity` guard if one is ever wanted.

### One-impact-one-block per tick

Each update tick processes at most one break per projectile, even if the hitbox overlaps multiple solid cells. Subsequent solid cells remain reachable on later ticks while the hitbox still overlaps them. Avoids the explosion case where a fast wide projectile clears a 6-cell line in one frame.

### sourceTool back-reference

`Projectile.sourceTool: Tool` is opaque to the manager — it's stamped at spawn and threaded to `onBlockBroken(bx, by, bz, sourceTool)`. The callback (set up in `main.ts`) dispatches BP off `sourceTool.bpPerBreak` and could grow per-tool particle / sound dispatch the same way.

Pattern note: this matches `BlockRegistry` (data identifies type, behavior dispatches) rather than a closure-attached `onBreak` field. No closure-as-behavior pattern exists elsewhere in the codebase.

## 3. Renderer (`projectile-renderer.ts`)

Own pipeline, not folded into the entity renderer:

- No texture sampling, no specular, no fog, no material LUT lookup. Simpler shader reads cleaner.
- Color is hardcoded in WGSL (currently sky-blue). Promote to an instance uniform when per-tool colors are wanted.
- Vertex layout matches entity meshes (`pos + normal + uv`, 32-byte stride) so any existing mesh generator can drop in unchanged. The shader doesn't declare the UV attribute — the GPU strides over those bytes without reading them.

### Mesh convention: [-1, 1]

All projectile meshes live in `[-1, 1]` (half-extent), matching the entity renderer's convention. The transform scales by `visualSize × 0.5` so the rendered edge length is `visualSize`. The OBB hitbox uses the same half-extent (`visualSize × 0.5`). **What you see is what hits.** Diverging the two creates the visual-leads-collision class of bugs.

### Render-time wrap

Mirrors the entity manager's Pass-3 trick. After each successful tick:

```ts
const dx = p.position[0] - playerPos[0];
const dz = p.position[2] - playerPos[2];
const offsetX = dx > hw ? -ww : dx < -hw ? ww : 0;
const offsetZ = dz > hw ? -ww : dz < -hw ? ww : 0;
writeTransform(p, rd, offsetX, offsetZ);  // folds offsets into translation
```

Canonical `p.position` stays in `[0, ww)` after the integration-step modulo wrap. Only the rendered model matrix sees the offset, so projectiles on the far side of the wrap seam draw at their nearer copy.

## 4. Input flow (`main.ts`)

Mouse input is **flag-then-tick**, not event-driven fire:

- `mousedown` sets `lmbDown` / `rmbDown` to true; `mouseup` clears.
- `pointerlockchange` (Esc, alt-tab) and `window.blur` both flush all flags. Prevents stuck buttons that keep autofiring when the window regains focus.
- Per frame in `tick()`: `tickToolCooldowns` → raycast for `currentHit` → if button held and `canFire` passes → fire.
- LMB doesn't need a raycast (free-fire). RMB needs `currentHit`. Raycast runs before the fire block so RMB acts on the current frame's hit.

### Selected tool ownership

`gameState.selectedToolIndex` is the single source of truth. The toolbar UI is a writer (via an `onSelect(i)` callback at init); LMB/RMB handlers are readers. The toolbar holds no state of its own beyond the current index for DOM-toggle dedup.

## Cross-cutting patterns

### Singleton tools + on-object cooldown state

Cooldown survival across slot switches falls out of "Tool is a singleton object that the hotbar refers to." No external state table, no separate per-slot tracking. Worth keeping in mind for any future per-tool state (charge progress, ammo, durability) — same trick applies.

### sourceTool ref beats onBreak closure

Carrying a Tool reference on the Projectile and reading fields in a callback matches `BlockRegistry` / `Role` enum / Material table dispatch. Behavior keys off data, never off attached closures. Future per-tool effects (FX, audio) plug in the same way.

### canFire as the one-place gate

All "should this fire?" logic flows through one predicate. New gates land in one file and immediately apply at every call site.

### BuildProfile.targetSelector is the preview/commit single source

Same function the (future) ghost renderer and the committer both call. The preview consumer doesn't exist yet, but the shape is preview-ready — no `BuildProfile` rewrite needed when ghosts land.

### Render-time wrap is shared across systems

The chunk pass, the entity manager, and the projectile manager all use the same wrap-offset trick: compute distance to player, offset by ±worldWidth when on the far side. Canonical positions stay in `[0, ww)`; only the model matrix sees the offset. Any new world-resident system needs to do this too — see `entity-physics-and-ai.md` for the full discipline.

## Deferred by design

These have been explicitly put off; new work should respect the boundaries.

### Ghost preview for BuildProfile

`targetSelector` already returns the cells the previewer would render. Adding the consumer is one new file and zero changes to existing ones.

### Non-null chargeTime

Field exists on `Tool`. The tick guards on `chargeTime === null`; the charge-up branch grows alongside when an actual charge-up tool wants it.

### Per-tool projectile visuals

Shader hardcodes color. `ProjectileProfile` reserves `visualSize` but not yet a richer `{ mesh, color, ... }` visual struct. Promote when the second tool wants to look different.

### Tool-vs-entity collision

Projectiles phase through enemies. Could become bounce-with-momentum-transfer (matching the sphere-vs-sphere impulse formula) when combat design firms up. Until then, projectiles ignore the entity list entirely.

### Feel layer

No sound, no break particles, no camera kick, no crosshair states. `Tool` has field-shaped holes for icon and model paths; equivalent slots for audio / particle identifiers go alongside when those systems land.

### In-flight projectile cap

No cap. Cooldowns indirectly bound spawn rate, and current tuning leaves headroom. Add a cap on the `Tool` when a fast-firing profile actually fills the world.

### Sub-stepping

`ProjectileManager` integrates once per tick. Current projectile speeds stay well under the per-tick tunneling threshold (~½ block). Add sub-stepping when a faster profile actually tunnels.

## Constants

The interesting tuning surface is the Tool itself — each field is a knob with a load-bearing meaning. Values live in `tool.ts`; this table describes what they tune, not what they're currently set to:

| Field | What it tunes |
|---|---|
| `projectile.strength` | Mining budget. Determines penetration depth — how many blocks a single shot clears before the killing blow. |
| `projectile.speed` | World units / sec the projectile travels. |
| `projectile.maxLifetime` | Despawn fallback. Should comfortably exceed `speed × max-engagement-range`. |
| `projectile.visualSize` | Edge length of the rendered cube. **Must** match the OBB hitbox half-extent (`visualSize × 0.5`). |
| `lmbCooldown` / `rmbCooldown` | Seconds between successive fires while held. Independent. |
| `lmbCost` | BP debited per LMB fire. 0 = firing is free; positive = consumable shot. |
| `bpPerBreak` | BP awarded per block this tool's projectiles break. |
| `buildProfile.costPerBlock` | BP debited per cell placed by RMB. |
| `spawnOffset` | Camera-local emission point `[right, up, forward]`. Hip-fire nudge keeps the projectile out of the camera frustum on emit. |

`defineTool()` asserts the invariants the type system can't: positive cooldowns, non-negative costs. Add new invariants there.
