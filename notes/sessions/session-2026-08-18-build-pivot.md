# Session 2026-08-18 — Building becomes a projectile

## What changed

RMB used to stamp a `BuildProfile` — a predefined cell shape — onto the face
under the crosshair. It now launches a build projectile whose impact grows a
structure over time. The old path survives per-tool as the single-block
placement utility. System notes: `../systems/growth-and-build-projectiles.md`.

## Why

The starting question was cosmetic — what should a build preview look like —
and turned into a design problem. Every predefined shape we could name was a
blob. Wall, floor, cube, and any wackier variant all reduce to "matter appears
near you," which in a game where breaking and placing is the entire verb set
isn't enough.

The diagnosis that unstuck it: **walls aren't boring, walls with no decision
attached are boring.** A Fortnite wall is one of the most interesting objects in
the medium because it goes up between you and a bullet under time pressure. The
geometry is trivial; the timing is everything. Our RMB had no timing, no read of
the space, and no risk — so a fancier shape was never going to fix it.

Two properties fix it, and neither is about shape: construction that takes the
world as an argument (so the result differs every time), and construction that
takes time (so it can be interrupted, and therefore gambled on). A bridge has
both, and it's the verb a vertical climbing game actually wants.

## Abandoned along the way

**The build outline.** Built fully: union-shell geometry with per-edge
silhouette tagging so a multi-cell shape read as one solid rather than a pile of
boxes, plus a soft inward gradient. Two things killed it. Aesthetically, a
glowing edge is a *diagram*, and this world is made only of solids and light —
it was the one thing on screen not made of anything. Structurally, it was
decoration on a verb that wasn't doing work yet, and once building became a
projectile there was no predefined shape left to preview.

Left in git history rather than the tree. If a preview is ever wanted for a
multi-cell planner, the union-shell + edge-tag geometry is the part worth
recovering; the glow is not.

**Multi-cell BuildProfiles.** Never written. Auto-climb already handles the
common "put a block under me" case automatically and invisibly, which is most of
what predefined placement would have been for.

## Left open

- Slope is uncapped, so a steep shot builds a staircase that may not be
  climbable. Deliberately left for playtest rather than pre-solved.
- Long-range spans could trivialise the climb. Bridges reach back to where you
  already were, making them lateral and escape traversal rather than vertical
  gain — that division of labour with auto-climb is worth protecting.
- Bridge width of one is a tightrope. It's a planner parameter, and it changes
  the feel of the mechanic more than almost anything else.
