# Auto-Step

Walking into a one-block ledge carries the player up it instead of stopping them.
Lives in `src/collision.ts`; extends the player collision model in
`physics-and-collision.md`.

## Shape

Not "detect a ledge ahead" — a second-chance move, following Quake's
`PM_StepSlideMove`:

1. Run the normal horizontal move (`sweep`).
2. If it was blocked and the preconditions hold, rewind to the start position,
   lift by the step height, and replay the **original** delta from there.
3. Settle back down onto whatever floor that revealed.
4. Keep the stepped result only if it bought horizontal ground the flat move
   did not.

X and Z are stepped as one attempt. Stepping per-axis would let a player rise on
X and land inside geometry on Z — the strafe-into-a-corner climb exploit.

The step is a position change, never an impulse. Result flags come from whichever
attempt won, so a successful step reports the wall it cleared as uncollided and
`movement.ts` leaves horizontal velocity alone. Without that the player
stutter-stops on every stair.

## Step height

Deliberately over one block, so a one-block lip never costs a jump input. This
departs from the Minecraft reference (0.6 — slabs step, full blocks need a jump).
Traversal here is vertical and under time pressure, and fighting a lip while
something is chasing you is friction with no upside. The fraction above 1.0
absorbs float error in the cell math.

## Edge cases and their guards

Every early return in `tryStepUp` exists to stop one specific failure. The
checked column marks cases exercised directly against the real collision code.

| Case | Guard | Checked |
| --- | --- | :-: |
| Climbing a wall you brush while falling | `grounded` is the caller's *pre-move* ground state | ✓ |
| A jump eaten by a step into the ledge | reject when the vertical delta is upward | ✓ |
| Rising onto blocks you merely walk alongside | require a horizontal collision first | ✓ |
| Jitter while drag pins you to a wall | minimum horizontal delta | ✓ |
| Head clipping a ceiling during the lift | AABB clearance test at the raised start | ✓ |
| Stepping into a nook with no standing room | settle sweep finds no floor | ✓ |
| Ledge too tall to climb | same — settle sweep finds no floor | ✓ |
| Retry that travels nowhere | replay the original delta, not the wall-clamped one | ✓ |
| Stepping *over* a thin wall in one frame | require measured vertical gain above zero | |
| Settling higher than the lift ever verified | cap measured gain at the step height | |
| Taking a step that gained nothing | compare horizontal progress against the flat move | |
| Seating inside geometry on a corner | AABB clearance test at the landing, outright | |
| Stutter-stop on every stair | flags come from the winning attempt | ✓ |
| View teleporting a block upward | render-only smoothing, below | |

## View smoothing

A whole-block translation at eye level is nauseating. Physics keeps the snap;
`main.ts` carries a `stepSmoothOffset` that the rendered eye (`eyePos`) trails by
and decays to zero.

`eyePos` is the eye the player looks and aims through — view matrix, eye-position
uniform, crosshair raycast, projectile spawn and aim. Gameplay reads stay on
`cameraPos`: chunk streaming, void floor, entity targeting, placement checks.

The offset only ever spans ground the body just crossed, so the smoothed eye is
always inside the already-clearance-checked player AABB. It cannot sit inside a
block, which is what makes aiming from it safe.

## Not here

**Step-down.** No stair-glue. That is a Quake-lineage fix for a Quake-lineage
problem — continuous stairs where going airborne breaks the friction model.
Minecraft has none, and neither do we. Ascending a staircase is smooth and
descending is a series of short falls; the asymmetry is intentional, and climbing
is the interesting direction.

**Entities.** The step consults the voxel grid only. If cubes ever become solid
to the player, a step will walk straight through one — a named seam, not a
surprise.

**Substepping.** Unchanged by this work, but auto-step makes its absence visible:
on a hitching frame the player can step onto a surface they effectively tunneled
toward.

## Tuning surface

- `STEP_HEIGHT_BLOCKS` (`collision.ts`) — how tall a lip walks off.
- `STEP_SMOOTH_RATE`, `STEP_SMOOTH_SNAP` (`main.ts`) — how long the view lags.
