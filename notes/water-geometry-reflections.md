# Water Geometry Reflections — What We Tried

## Goal
Reflect boulders/terrain geometry in the water plane, not just the skybox cubemap.

## What's Already Working
- Water plane with skybox cubemap reflection via environment mapping
- Fresnel-based alpha blending (transparent near camera, reflective at horizon)
- Ground geometry visible through water at steep viewing angles

## Approach 1: Flipped Geometry (Direct to Framebuffer)

**Idea:** Draw the mesh a second time with a Y-flipped VP matrix (mirrored across the water plane), directly into the main framebuffer. Use `cullMode: 'front'` to fix winding. Clip geometry below the water using a `clipY` uniform + fragment discard.

**What happened:**
- First attempt: clip direction was wrong (`worldY > clipY` instead of `< clipY`), so the ground floor rendered as a marble sheet over the water
- After fixing clip direction: ground was gone, but no visible boulder reflections
- **Root cause:** The mirrored geometry ends up at Y positions below the ground (a boulder at y=20 mirrors to y=2). The normal geometry pass already filled the depth buffer at those screen positions, so the reflected geometry fails the depth test. Even with reordered draws, the reflected vertices appear at *different screen positions* than the water surface, so they can't be seen "through" the water's alpha blend.
- **Conclusion:** Flipped geometry into the same framebuffer doesn't work for horizontal water viewed from above. The reflected geometry and the water surface occupy different screen pixels.

## Approach 2: Render-to-Texture with Projective Texturing

**Idea:** Render reflected geometry to a separate offscreen texture (reflection pass), then have the water shader sample that texture using projective texturing (project the water fragment's world position through the reflected VP matrix to get UVs).

**Implementation:**
- Separate render pass writes to `reflectionTexture` (cleared to transparent black)
- Uses `reflectedVP = VP * reflectionMatrix` where reflectionMatrix mirrors across waterY
- Water shader: `clipPos = reflectedVP * worldPos`, then `ndc → UV`, then `textureSample(reflectionTex, uv)`
- Blends geometry reflection (where alpha > 0) with skybox cubemap fallback

**Status:** Implemented and working. This is the current active approach. The geometry reflections do appear in the water, though there may be room to improve visual quality (alignment, precision, blending).

## Infrastructure That Exists (Can Be Reused)
- `reflectionPipeline` — same main shader with `cullMode: 'front'` for mirrored winding
- `reflectionUniformBuffer` / `reflectionBindGroup` — separate uniforms with mirrored VP + clipY
- `clipY` uniform in the main shader (`shader.ts`) — fragment discards based on world Y position
- `reflectionTexture` — offscreen render target, recreated on resize
- `createWaterBindGroup()` — rebuilds water bind group when reflection texture changes
- Water uniform buffer expanded to 36 floats (viewProjection + cameraPosition + reflectedVP)

## Future Ideas to Try

### Screen-Space Reflections (SSR)
Ray-march through the depth buffer in screen space. After the main geometry pass, the depth buffer and color buffer are available. The water shader could march along the reflection direction in screen space to find where reflected geometry appears. Works well for nearby objects. Downside: anything off-screen can't be reflected, and it's the most complex to implement.

### Mirrored Camera (Instead of Mirrored Geometry)
Instead of `VP * reflectionMatrix`, compute a proper mirrored camera position (flipped across water Y) and build a lookAt from that. Render the scene from the mirrored camera to the reflection texture. Then sample with screen-space UVs + Y flip (`texCoord.y = 1.0 - texCoord.y`). This is the standard planar reflection approach used in most game engines. The difference from what we tried: the mirrored camera naturally produces screen-aligned results, whereas VP * reflectionMatrix puts reflected geometry at mismatched screen positions.

### Stencil-Masked Flipped Geometry
Revisit the direct-to-framebuffer approach but use the stencil buffer to restrict where reflected geometry appears:
1. Draw the water plane first, writing 1 to stencil
2. Draw reflected geometry with stencil test (only where stencil = 1)
3. Draw the water again with alpha blending on top
This constrains reflections to only appear within the water surface area. Still has the depth/screen-position issue though — would need `depthCompare: 'always'` for the reflected pass.

### Lower Water Plane / Taller Boulders
The current geometry (boulders starting at y=10, water at y=11) means reflections mirror to very negative Y values, deep below the ground. If boulders were much taller relative to the water, or the water were higher, the reflected geometry would be closer to the water surface and more likely to appear at visible screen positions. This doesn't fix the fundamental issue but could make the simple flipped approach look passable.

### Dual-Paraboloid Reflection Maps
Render the scene into two hemispherical paraboloid projections (front + back) instead of a full cubemap. Cheaper than 6 cubemap faces, captures the full environment. More complex sampling math in the water shader. Probably overkill for this use case.
