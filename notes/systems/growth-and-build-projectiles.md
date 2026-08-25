# Growth & Build Projectiles

Building is a projectile, not a placement. RMB launches a bolt; what it hits
determines the structure, and that structure lays itself down over time. The
reasoning behind the switch is in `../sessions/session-2026-08-18-build-pivot.md`.

Two properties drive everything here:

- **Construction is relational.** A plan takes the world as an argument — a span
  is defined by the gap it crosses, not by a shape picked in advance. Predefined
  shapes ignore the world, which is why they all came out as interchangeable
  blobs.
- **Construction is a process.** Cells land at a rate, so a build can be
  interrupted, outrun, or run dry partway. An instant stamp carries no risk; a
  span racing toward you while something closes is a gamble.

## The split

- **`GrowthProfile`** — frozen per build type, held by a Tool.
- **`GrowthPlanner`** — pure function from impact to an ordered cell list. *All*
  variation between build types lives here. A bridge is a line, a cage a shell,
  a column a stack; the manager never learns which. New build type = new
  planner and nothing else.
- **`Growth`** — the live instance. Pure data.

Planner output is ordered because order *is* placement order. Growing from the
impact back toward the player means running dry leaves the far end built and
the near end missing — a finished span you can't reach. That waste is the
intended cost of overreaching.

## Decisions worth not relitigating

**Plans are computed once, never revised.** The world can change under a long
span; the per-cell placement check absorbs that. Re-planning would mean routing,
and routing is the thing being deliberately avoided.

**No routing, no slope cap.** Cells land where there's room and are skipped
where there isn't. Easier for a player to read than a span that bends around
obstacles for reasons only the code knows.

**The manager never sees GameState.** Affordability arrives as a callback. The
point isn't the callback — it's that "the source is the player" must not get
baked in. Enemy-fired builds are coming, and that assumption is the expensive
thing to unpick later, not the type of the source field.

**Notification is batched per frame, not per cell.** Remeshing and flow-field
invalidation both fan out hard; at growth rates, per-cell thrashes them.

**Spans anchor to the block *supporting* the player, not the cell their feet
occupy.** A bridge is a floor, so the deck has to arrive level with whatever
you're standing on. Fired mid-fall, this is also what catches you.

**Lines are face-connected.** A cheaper diagonal line meets only at edges and
you drop through the joints.

**Whether a build needs something to build against is the structure's
question, not the bolt's.** A span has two endpoints and produces nothing
fired into open air; a freestanding shape doesn't care and plants itself
wherever the flight ran out. Same bolt, different plan, different answer — so
the flag sits with the plan. It also means flight time doubles as throw range
for anything freestanding, which is the dial that keeps long-range placement
honest.

## Deferred

- No cancellation, no re-planning, no cap on concurrent growths.
- Build projectiles phase through enemies. This is the seam where a trap/cage
  planner eventually lives.
- Cells appear instantly. `../proposals/cube-tip-placement-animation.md`
  describes the settling animation that would plug in here.
