# Face-Owned Folds

## Summary

This note captures the bevel fix that actually worked well.

It does **not** solve every corner-gap problem. What it solves is a specific family:

- a plain exposed face has one or more neighboring bevels terminate into one of its corners
- that face must "fold" part of itself down to meet the bevels
- otherwise a triangular hole appears

This turned out to be a good abstraction for the `L`-shape cases and the follow-up cases where the same face needed multiple folds.

## The Problem Family

The original per-block bevel mesher already had:

- exposed face quads
- edge chamfer quads
- convex corner cap triangles

That covered ordinary convex beveling, but it missed a concave family of cases:

- two neighboring bevels could meet at a corner of a third block
- that third block might not itself have a bevel there
- its exposed face still needed to contribute geometry

Without that extra geometry, the face kept its ordinary clipped corner and a hole was left behind.

The key insight was:

> this missing patch still belongs to a single surviving face

That is what made the fix tractable.

## Mental Model

This is best thought of as a **face-owned fold**.

Instead of asking:

- "which bevel edge owns this gap?"

the better question was:

- "which exposed face is the natural owner of the missing patch?"

In these successful cases, the answer was:

- one exposed face already spans the area
- one or more of its corners need to be clipped and folded inward

So the face remains the owner. We do not create a separate global repair pass or corner-cell mesh for this family.

## The Fix

The working implementation in `src/bevel-mesh.ts` does this:

1. Detect folded corners on an exposed face.
2. For each folded corner, replace the original corner with two shoulder points on the face boundary.
3. Rebuild the face as an ordered boundary polygon using those shoulder points.
4. Triangulate that clipped face polygon.
5. Emit one extra fold triangle from the two shoulders down to the fold point.

So one folded corner becomes:

- clipped face boundary on the original face plane
- plus one downward fold triangle

## Why It Generalized

The first version only allowed one fold per face.

That fixed the first `L`-shape hole, but the next bug showed a face that needed two folds at once. The real improvement was changing the model from:

- `one optional fold per face`

to:

- `FaceFold[] per face`

Once the face was treated as a polygon with zero or more clipped corners, the same idea naturally handled:

- 1 fold on a face
- 2 folds on a face
- 3 folds on a face
- 4 folds on a face

That was the important sign that this was not just a one-off patch. It was the right abstraction for this family.

## Terminology

The working family can be named:

- `face-owned folds`
- `face-owned concave folds`
- `corner clipping on an exposed face`

All of these mean roughly the same thing:

- the missing patch belongs to a face
- the face can be repaired by clipping and folding one or more corners

## Boundary Of The Fix

This fix does **not** automatically generalize to every hole.

It stops being the right model when the missing patch is no longer owned by a single face.

The main unsolved family we ran into afterward was:

- `vertex-owned concave caps`
- also described as `3-way concave corners`, `re-entrant corners`, or `empty-octant` cases

In those cases:

- the gap lives in the empty corner region between multiple blocks
- no one exposed face naturally owns it
- so the face-fold logic should not be stretched to cover it

That distinction matters:

- face-owned folds are now a solved subsystem
- vertex-owned concave caps are a different subsystem

## Practical Takeaway

The part of the bevel mesher that is now in good shape is:

- exposed faces
- edge chamfers
- convex corner caps
- face-owned folds with multiple folds per face

So if a future bug still has a clear owning face, the first question should be:

- "is this just another clipped-corner/folded-face case?"

If yes, it probably belongs in the existing face-fold machinery.

If no, and the gap lives in shared empty space around a lattice vertex, it is probably a vertex-owned problem and should be handled separately.
