# Graphics Experiments

This is a working shortlist for low-cost rendering experiments. The point is
not to prescribe the final graphics pipeline; it is to keep useful suspects
visible while we explore.

| Rank | Experiment | Why It Is Promising |
| ---: | --- | --- |
| 1 | sRGB/linear-space audit | Textures and skybox are currently sampled, lit, fogged, and returned directly. A color-space mismatch can make every lighting decision harder to judge. |
| 2 | DPR-aware canvas sizing | The canvas resize path uses CSS pixel dimensions directly. On high-DPI displays this can quietly soften the whole image. |
| 3 | Optional MSAA render target | Voxel scenes have many hard silhouettes. A small MSAA experiment could improve edge stability before adding postprocess AA. |
| 4 | Hemisphere ambient plus real diffuse | Terrain uses a hand-authored face brightness table while entities use smooth diffuse. A sky/ground ambient model could make shadows livelier and unify terrain/entities. |
| 5 | AO affects ambient, not everything | Current AO darkens toward a fixed shadow color. Letting AO mostly reduce ambient/indirect light may keep direct sun and specular cleaner. |
| 6 | Entity shadows or blob shadows | Terrain casts and receives shadows, but entities do not yet participate. Even cheap blob shadows would help objects feel grounded. |
| 7 | Roughness-aware sky reflections | Skybox mips already exist. Sampling different mip levels by roughness/shininess could make materials reflect more believably. |
| 8 | Normal maps for high-resolution materials | The repo already has marble normal/roughness/height assets. Axis-aligned voxel faces make a first tangent basis experiment manageable. |
| 9 | Expose mip LOD bias | The terrain shader has a hard-coded negative LOD bias. Making it adjustable would help tune sharpness versus shimmer. |
| 10 | Fog model upgrade | Fog already samples the skybox, but a height/exp fog model plus subtle dithering could improve atmosphere and depth cues. |

Suggested early order:

1. Keep building clean debug render modes.
2. Try DPR-aware canvas sizing before MSAA.
3. Add optional MSAA once the canvas sizing path is explicit.
4. Do the sRGB/linear audit as its own branch because it may require material retuning.
