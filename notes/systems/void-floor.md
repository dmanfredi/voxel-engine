# Void Floor

The rising hazard that drives the climb — Pillarman's first lose condition. The
roadmap/design doc call it the "fire floor"; the realized version is a **void**,
so the code says `void` (always compounded — `voidSurfaceY`, never bare).

## Files

- **`src/void-floor.ts`** — mechanic + state. Pure logic, no GPU.
- **`src/void-floor-renderer.ts`** — pipeline + draw (placeholder planes).
- **`src/shader/void-floor.ts`** — the WGSL.

## What it is

A single rising world-Y scalar, `voidSurfaceY`. Everything else is a band
measured downward from it:

| Band | Range below surface | Effect |
|---|---|---|
| **Safe** | above surface | nothing |
| **Grace** | 0 → −1 chunk | damage ticks; escaping back to Safe heals |
| **Lethal** | below −1 chunk | rapid death — and chunks are deleted here |

The void **always rises**, even when the player stands still — there is no safe
height, only distance bought. If the player out-climbs the constant rise, a
max-gap clamp yanks the void up so it can never be left behind.

Damage in Grace is a small crack counter, not a health bar (see intent below):
one crack per interval; max cracks → shatter. Returning to Safe heals one crack
per interval at the **same cadence** it was taken, so a quick dip costs a crack
you earn back, but loitering at the surface keeps you perpetually chipped.

The Lethal line doubles as the **chunk-delete floor** — below it, chunks are
permanently unloaded and never reloaded. Because `world.setBlock` already fails
on an absent chunk, deleting them also makes placement there impossible: the
deletion *is* the no-build rule, no separate guard. The `ChunkLoader` takes this
floor each tick, raises its load-window bottom to it, and unloads consumed
chunks with no hysteresis.

## Design intent (the musings — don't lose these)

- **The void is a visual conceit, not a physical surface.** Looking down you see
  a black, soft-edged chasm that fades out (no hard rim) and grows in apparent
  size as it nears. It is deliberately *not* a 1:1 map to the kill plane — it
  exists to be ominous and imposing, nothing more.
- **No real health bar — the BP orb is the health visual.** Damage happens in
  exactly one place (the Grace band), so it isn't worth abstracting an HP system.
  The intent: the centered BP orb cracks and shakes on each hit and shatters when
  cracks max out. Cracks are the only "health" the game has.
- **Grace is an escape window, not a punishment.** You can fall in and climb
  back out if you move quickly — the band gives you a beat of mercy.
- **The vanishing ground is part of the schtick.** Lethal and the delete floor
  intentionally coincide (no buffer). The plan is that by the time you're that
  deep, an oppressive black fog has closed in and all you see is darkness — so
  the ground giving out beneath you is no surprise. Thematically, the void has
  *consumed* those chunks.
- **Deletion is also an optimization.** Permanently dropping consumed chunks
  bounds the loaded world from below as you climb.

## Stubbed / deferred (the seams are in place)

- **Real void shader.** Current visuals are flat translucent debug planes (one
  per band boundary) so rise/clamp is tunable. The fuzzy black-chasm look is a
  fragment-stage swap inside `shader/void-floor.ts` — same pass slot and uniform.
- **Orb crack/shake + death overlay.** `updateVoidFloor` routes effects through
  `onCrack` / `onHeal` / `onDeath` callbacks; today they `console.log`. Death is
  logged only — the sim is **not** frozen and there's no restart yet, on purpose,
  so the rise/clamp feel can be tuned through a "death."
- **Black oppressive fog near the void.** Future. Likely just drives the existing
  `fogStart` / `fogEnd` (plus a fog-color uniform) from `feetY − voidSurfaceY` —
  no new pipeline.

## Tuning surface (`void-floor.ts` constants)

| Constant | Meaning |
|---|---|
| `VOID_RISE_RATE_BLOCKS` | Constant rise, blocks/sec (start: 0.75). |
| `VOID_MAX_GAP_BLOCKS` | Closest the void may lag below the player before being clamped up (start: 200). |
| `VOID_GRACE_DEPTH_CHUNKS` | Thickness of the Grace band, in chunks (= the delete floor depth). |
| `VOID_HIT_INTERVAL` | Seconds per crack — and per heal. |
| `VOID_MAX_HITS` | Cracks before shatter. |
