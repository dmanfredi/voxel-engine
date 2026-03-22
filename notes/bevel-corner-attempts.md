# Bevel Mesh Corner Gap — Attempts Log

## The Bug

Triangular holes appear at block corners in bevel mode, showing the skybox through the mesh. The gaps occur where beveled edges meet at a block corner but the geometry doesn't fully close.

## Root Cause (agreed upon)

The bevel mesher makes per-block geometry: inset face quads, edge chamfer quads, and corner cap triangles. Corner caps require all 3 edges at a corner to be beveled (both faces exposed + edge diagonal air). When fewer than 3 edges are beveled, the face corners are still inset (from their beveled edges), creating a triangular gap between the inset corners and the block corner. No geometry fills this gap.

The other model's writeup (`notes/bevel-mesh-corner-fix.md`) further identified that whole-edge bevel decisions are too coarse — endpoints of an edge can have different bevel validity depending on the third face at each end.

## What We Tried

### Attempt 1: Gap-filler triangles (no guards)

**Approach:** In the corner loop, instead of requiring all 3 edges beveled, emit a triangle whenever ANY edge is beveled. Use `faceCorners[f][ci]` for exposed faces, fall back to `blockCorner` for non-exposed faces.

**Result:** Regression — "bits of geometry sticking out of edges." The gap-filler triangles at corners where only 2 faces were exposed created visible artifacts. The triangles extended to the block boundary and interfered with adjacent block geometry.

### Attempt 2: Gap-filler triangles (all 3 faces exposed guard)

**Approach:** Same as attempt 1, but added `if (!exposed[fA] || !exposed[fB] || !exposed[fC]) continue;` to only emit gap-fillers where all 3 faces are exposed.

**Result:** Fixed the regression (no sticking-out geometry). Fixed gaps at corners where all 3 faces are exposed. But gaps persisted at 2-exposed-face corners — inward corners of L-shaped blocks, wall tops, etc. These are the most common gap locations on terrain.

### Attempt 3: Gap-filler triangles (no guards, retry)

**Approach:** Removed the all-3-exposed guard, hoping the degenerate triangle check (`cross product < 1e-6`) would prevent the regression.

**Result:** Regression returned. The sticking-out geometry came back at 2-exposed-face corners.

### Attempt 4: Other model — endpoint-aware bevel + repair pass

**Approach (from `notes/bevel-mesh-corner-fix.md`):**
1. `edgeEndBev[fA][fB][end]` — per-endpoint bevel state. Each endpoint checks third face exposed + corner diagonal air.
2. Face corner inset uses endpoint-aware queries instead of whole-edge flags.
3. Tapered chamfers — when endpoints collapse (both face corners converge), emit triangle instead of degenerate quad.
4. Corner caps use endpoint-aware checks.
5. Post-pass repair: count undirected triangle edges, find boundary edges (count=1), find triangular loops, emit repair triangles.

**Result:** Holes filled. But mega laggy (repair pass iterates all vertices with string-keyed Maps, `toFixed(6)` calls, etc.) and geometry "borked" — the endpoint-aware inset was too aggressive, causing visual artifacts.

### Attempt 5: Keep endpoint-aware logic, remove repair pass

**Approach:** Kept the other model's endpoint-aware bevel state, face corner inset, tapered chamfers, and corner cap checks. Removed the entire repair pass (~280 lines).

**Result:** Holes gone, lag fixed. But geometry was wrong — chamfers were triangular instead of rectangular. The endpoint-aware face corner inset was the cause: it refused to inset face corners at endpoints where the third face wasn't exposed, making most chamfers taper to a point at block boundaries. Wireframe showed triangular chamfers everywhere instead of quads.

### Attempt 6: Whole-edge face inset + relaxed corner cap

**Approach:** Reverted face corner inset to use whole-edge `edgeBev` (nice rectangular chamfers). Removed all endpoint-aware machinery. Changed corner cap condition from "all 3 edges beveled" to "all 3 faces exposed" with a `samePos` degenerate check to skip corners with no inset.

**Result:** Nice rectangular chamfers restored. But the original corner gap bug returned — back to square one. The relaxed corner cap condition (all 3 faces exposed) should have filled gaps at 3-exposed corners, but didn't seem to work.

## Key Tensions

1. **Whole-edge inset** gives nice rectangular chamfers but creates gaps at partially-beveled corners.
2. **Endpoint-aware inset** eliminates gaps but ruins chamfer appearance (everything tapers).
3. **Gap-filler triangles** at 3-exposed corners work, but at 2-exposed corners they cause geometry to stick out.
4. **Repair pass** brute-forces gap filling but is too slow (O(vertices) with string hashing per chunk).

## Observations

- The gap is always a triangle between 2-3 inset face corners and the block corner position.
- Gaps at 3-exposed-face corners: all face corners available, triangle should fill the gap cleanly. Previous attempts claimed this worked (attempt 2).
- Gaps at 2-exposed-face corners: one face has no geometry (not exposed). The gap is at the block boundary. Filling it risks overlapping with adjacent block geometry.
- The "sticking out" regression at 2-exposed corners may be from the gap-filler triangle's diagonal normal creating a visible shading discontinuity, or from actual geometric intersection with adjacent blocks' chamfer quads.
- The degenerate `samePos` check in attempt 6 should have caught corners with no inset, but the bug returning suggests either the check isn't working or the gap-filler triangles aren't being emitted at all.

## Open Questions

- Why did attempt 6 (relaxed corner cap) fail? The condition `!exposed[fA] || !exposed[fB] || !exposed[fC]` should pass for terrain surface corners. Did the `samePos` check incorrectly skip valid gap-fillers?
- Is there a hybrid approach that uses whole-edge inset for face corners but endpoint-aware logic ONLY for deciding whether to emit corner geometry?
- Could the 2-exposed-face gap be handled by extending the chamfer quad at its endpoints rather than adding separate triangles?
- Would it help to render the bevel mesh with `cullMode: 'none'` (no backface culling) as a quick workaround to hide the gaps?
