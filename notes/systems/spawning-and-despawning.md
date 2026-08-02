# Spawning & Despawning

How enemies enter and leave the world. Spawning is coupled to terrain — enemies
are *born from blocks* and *return to blocks* — so the system sits between the
generators (which lay the terrain) and the entity manager (which runs the
lifecycle). This is the pacing layer of the game.

> **Status: design-stage.** No code yet. This captures the converged design and
> the reasoning behind it so implementation can follow without re-litigating.
> Filenames below are proposed, not real.

## The shape of the system

Three cooperating pieces, layered over the existing `EntityManager`:

1. **Director** — decides *pace*: how many enemies should be active and how often
   to attempt a spawn. Constant for now; built to become section-driven.
2. **Spawner** — given "spawn one," finds a valid block cluster near the player,
   consumes it, and emerges an enemy from it. Unlike the generators, the spawner
   **gets a `World` reference** — it has to query live terrain. This is the
   connective tissue the generators lack.
3. **Despawn pass** — each frame, runs every entity against an ordered list of
   despawn conditions; first match removes it through a Shape-dispatched death.

Spawn and despawn are two halves of one population loop: despawns pull the active
count below the director's target, which lets new spawns fire.

## Spawning

### Born from blocks

An enemy emerges from a solid cluster of blocks and **consumes** them — the
terrain literally becomes the enemy. Consequences, all intended:

- **Material inheritance.** The enemy's material is the cluster's material, so
  terrain palette dictates enemy palette for free. Themed sections (Phase 5) will
  auto-theme their enemies with no extra authoring.
- **Player blocks are fair game.** Spawns may consume player-placed blocks; there
  is no provenance distinction, so no per-block metadata is needed. "Build more →
  more cluster surface near you → more spawns" is an accepted risk/reward of
  fortifying, not a bug to suppress.
- **Uniform material required.** A cluster must be one material to spawn. This
  keeps enemy identity unambiguous and produces a nice emergent property: large
  uniform masses are rarer than small ones, so **big enemies come from big solid
  features** and fragmented/mixed terrain only births small ones. Size
  distribution falls out of terrain shape.

### Site search — an annulus, not a radius

Spawns happen in a **shell** around the player, not a disc: an inner wall keeps
them from popping on top of you, an outer wall keeps them roughly within reach.

- The outer wall extends *past* the flow field on purpose — see the load-bearing
  dependency below. Enemies born in the outer ring dumb-pursue until they cross
  into the field.
- **Vertical bias keys off behavior**, the one spawn parameter that legitimately
  varies: rush-style pursuers spawn below or level (threat rises at you, matching
  the climb fantasy); descend-and-crush enemies spawn above. This rides on Role,
  the same way AI dispatch already does — a switch, not a per-archetype table.

Search is sampled and budgeted: try K candidate points in the shell each spawn
tick; first valid site wins; if none pass, **no spawn this tick**. Barren terrain
is naturally calm, dense terrain naturally dangerous — the density self-regulates
with no explicit knob.

### Cluster rules

- **Size → cluster.** Cluster edge `N = ceil(enemyDiameter / blockSize)` per axis.
  A 1.1-block-wide sphere rounds up to a 2×2×2; the enemy then floats centered in
  the slightly-too-big cavity it ate. Archetype + size are chosen first (by the
  director), and `N` is derived from them — not the other way around.
- **Centered.** The enemy spawns at the center of the consumed volume.
- **Exposed.** The cluster must be **adjacent to air on at least one face**.
  Without this, the search will happily pick solid interior cells and hatch an
  enemy into a sealed pocket — instant-stuck, dead on arrival for a
  surface-climber. A simple any-face-touches-air test is enough for now;
  something path-aware can come later if it proves too loose.

### Emergence & telegraph

The cluster glows/cracks, then the enemy emerges. **The telegraph is visual flair
only — there is no counterplay**, no abort-the-spawn-by-breaking-the-blocks
mechanic. Spawns are weather, not a puzzle.

Because there's no counterplay, the ordering is tidy: **claim the site at
telegraph start** (so no second spawn double-picks it and nothing can desync),
**consume at hatch**. The blocks may stay rendered through the brief telegraph for
the dissolve look, but they're logically already spoken for.

## The Director (pace)

> **The thing that sets the game's pace.** Treat it as the seam, not the value.

Constant pressure to start: attempt a spawn on a fixed cadence, capped at a fixed
max-active count. Both are constants *today* but live behind a context-taking
shape — `desiredPressure(ctx) → { cadence, maxActive }` — so the eventual driver
can swap in without touching the spawner.

The demo-friendly driver is **altitude** (climb higher → more pressure). The
real end goal is **section-dependent** pace — the Phase 5 section system owns the
curve, and the director just asks "what section am I in?" Stub that query to
return a default until sections exist.

## Despawning

### The condition list

Each frame, for each entity, walk an **ordered** list of conditions; the first
that matches removes the entity (order = priority). Conditions are mostly
universal and live globally on the despawn pass — they are *not* a new per-entity
data axis. Traits may *append* a condition (a "bomber" trait adds a
contact → explode trigger); that's the one opt-in seam. Traits are now a live
axis for bolt-on modifiers, beginning with the cube-only Breacher trait.

Firm conditions:

- **No-path timeout** (primary). A timer ticks while the entity has **no path to
  the player**, and **resets the instant a path appears**:
  - Sphere: "has a path" ⟺ it's inside the flow field (gradient sample succeeds).
  - Cube: "has a path" ⟺ it has a valid move toward the player.
  - The threshold starts **high** on purpose (see dependency below). When the
    pathfinder's range improves, drop it.
- **Hard lifespan cap** (secondary, candidate). An absolute age limit for
  turnover, independent of pathing, so an enemy perpetually engaging you still
  eventually recycles. Keep simple; the no-path timer does most of the cleanup.

### Death dispatches on Shape

What the corpse *does* keys off Shape — the same dispatch `EntityManager.update`
already uses for physics, because a sphere physically can't petrify into clean
blocks and a cube collapsing into blocks is its whole identity:

- **Sphere → explode + carve + knockback.** Detonates and removes nearby blocks
  (interacts with terrain — the core verb), and shoves the player radially out
  from the blast. Only bothers carving when **near-ish** the player; the range is
  generous (a detonation tens of blocks away never hurts you but looks cool).
  Beyond that range it just fades — an explosion nobody sees is wasted. The
  knockback is its own, tighter reach that **scales with sphere size**: distance
  is normalized by that reach so one linear falloff lands a full kick at the
  surface and nothing at the rim, for any explosion size — "how far you could
  have been" is just the radius. Distance is measured from the sphere's
  **surface**, not its center: a large sphere's body holds the player a radius
  away from the epicenter, so a center-based falloff would quietly dock big
  blasts for their size alone. The kick is additive (stacked blasts compound) and
  carries an upward bias so it pops the player rather than sliding them flat. The
  player isn't an entity, so this reaches in via `playerVel` threaded through the
  death dispatch, mirroring the cube-tip fling in `entity-interactions.ts`.
- **Cube → petrify.** Collapses back into static terrain blocks of its material.
  It came from terrain and returns to it; a dead cube leaving a climbable platform
  is good gameplay, not litter. Petrify is cheap and unseen-safe, so cubes do it
  at any range *up to* the point there's no loaded terrain to deposit into — which
  is the streaming radius, not a magic number. Beyond loaded terrain, fade.

This gives spheres-subtract / cubes-deposit symmetry, both on-theme, both routed
through one `switch (shape)` death function.

## The load-bearing dependency (don't lose this)

Spawn radius, AI traversal, flow-field reach, and the despawn threshold are
**one coupled system**, and the coupling is not enforceable in code — it lives
here:

- The flow field reaches **24 blocks** (`FLOW_RADIUS`). Inside it, pursuit is
  smart. Outside, enemies dumb-pursue straight at the player and snag on terrain.
- Spawns deliberately extend past that, into an outer ring (out to ~64 blocks).
  An enemy born there is **outside the field from birth**, so its no-path timer is
  ticking the whole time it dumb-walks inward.
- Therefore the **no-path threshold must exceed the worst-case transit time** from
  the outer ring to the field edge, or enemies despawn en route before they ever
  threaten you. That's why the threshold is high — it's absorbing the gap between
  spawn radius and pathing radius.

When the pathfinder's range grows (the flow field gets bigger/cheaper, or a coarse
long-range pather lands), this whole knot loosens: the spawn ring can grow, and
the no-path threshold can shrink toward something that actually means "stuck."

## Deferred / stubbed seams

- **Dynamic pace.** Director returns constants now behind a context-taking
  signature; altitude- or section-driven curves swap in later.
- **Better stuck detection.** The no-path timer is blunt (high threshold absorbs
  honest transit). A real pather makes "no path" mean "genuinely stuck," letting
  the threshold drop.
- **Exposure check.** Any-face-touches-air now; a path-aware "can actually leave
  toward the player" test later if interior pockets prove a problem.
- **Per-archetype spawn data — rejected by design.** `Rmin`/`Rmax`, telegraph
  time, cluster shape are *shared*: cluster shape is a pure function of size, the
  radii and telegraph are global. The only behavioral variation (vertical bias,
  death style, opt-in triggers) rides existing dispatch (Role / Shape / Traits),
  not a new table. Resist growing one.
- **Block provenance — not needed.** Spawns eat any block regardless of who placed
  it, so blocks stay a bare ID array.

## Tuning surface (proposed)

| Constant | Meaning |
|---|---|
| `SPAWN_RADIUS_MIN_BLOCKS` | Inner wall of the spawn shell (start: 24 ≈ flow-field edge). |
| `SPAWN_RADIUS_MAX_BLOCKS` | Outer wall (start: 64; past the field on purpose). |
| `SPAWN_CADENCE` | Seconds between spawn attempts (constant-pace v0). |
| `SPAWN_MAX_ACTIVE` | Cap on simultaneously-active enemies. |
| `SPAWN_ATTEMPTS_PER_TICK` | K candidate sites sampled before giving up for the tick. |
| `TELEGRAPH_SECONDS` | Visual emergence duration (flair only). |
| `DESPAWN_NOPATH_SECONDS` | No-path timer threshold — **high** until pathing improves. |
| `DESPAWN_LIFESPAN_SECONDS` | Absolute age cap (candidate). |
| `SPHERE_EXPLODE_RANGE_BLOCKS` | Within this of the player, a dying sphere detonates+carves; beyond, fades. |
| `SPHERE_BLAST_RADIUS_FACTOR` | Knockback reach as a multiple of sphere radius; distance is normalized by it. |
| `SPHERE_BLAST_IMPULSE` | Peak (dead-center) velocity kick; same units as jump / cube-fling speeds. |
| `SPHERE_BLAST_UP_BIAS` | Upward lean folded into the radial direction — pop vs. flat slide. |
| (cube petrify range) | Tracks the streaming radius (loaded terrain), not a constant. |

## Further reading

- `notes/systems/entity-system.md` — the 5-axis taxonomy (Shape / Material / Role / Size /
  Traits) this plugs into.
- `notes/systems/entity-physics-and-ai.md` — Shape-dispatched physics + the Rush AI the
  pursuit half assumes.
- `notes/systems/flow-field.md` — the 24-block pursuit bubble the dependency above hinges
  on.
- `notes/systems/void-floor.md` — the rising hazard the director's pace ultimately answers
  to.
- `notes/GAME-DESIGN.md` — blocks-as-the-verb, BP, the enemy roster this serves.
</content>
</invoke>
