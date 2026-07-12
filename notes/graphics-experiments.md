# Graphics Experiments

This is a working shortlist for low-cost rendering experiments. The point is
not to prescribe the final graphics pipeline; it is to keep useful suspects
visible while we explore.

| Rank | Experiment                                | Why It Is Promising                                                                                                                                                      |
| ---: | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|    1 | sRGB/linear-space audit                   | Textures and skybox are currently sampled, lit, fogged, and returned directly. A color-space mismatch can make every lighting decision harder to judge.                  |
|    2 | DPR-aware canvas sizing                   | The canvas resize path uses CSS pixel dimensions directly. On high-DPI displays this can quietly soften the whole image.                                                 |
|    3 | Optional MSAA render target               | Voxel scenes have many hard silhouettes. A small MSAA experiment could improve edge stability before adding postprocess AA.                                              |
|    4 | Hemisphere ambient plus real diffuse      | Terrain uses a hand-authored face brightness table while entities use smooth diffuse. A sky/ground ambient model could make shadows livelier and unify terrain/entities. |
|    5 | AO affects ambient, not everything        | Current AO darkens toward a fixed shadow color. Letting AO mostly reduce ambient/indirect light may keep direct sun and specular cleaner.                                |
|    6 | Entity shadows or blob shadows            | Terrain casts and receives shadows, but entities do not yet participate. Even cheap blob shadows would help objects feel grounded.                                       |
|    7 | Roughness-aware sky reflections           | Skybox mips already exist. Sampling different mip levels by roughness/shininess could make materials reflect more believably.                                            |
|    8 | Normal maps for high-resolution materials | The repo already has marble normal/roughness/height assets. Axis-aligned voxel faces make a first tangent basis experiment manageable.                                   |
|    9 | Expose mip LOD bias                       | The terrain shader has a hard-coded negative LOD bias. Making it adjustable would help tune sharpness versus shimmer.                                                    |
|   10 | Fog model upgrade                         | Fog already samples the skybox, but a height/exp fog model plus subtle dithering could improve atmosphere and depth cues.                                                |

Suggested early order:

1. Keep building clean debug render modes.
2. Try DPR-aware canvas sizing before MSAA.
3. Add optional MSAA once the canvas sizing path is explicit.
4. Do the sRGB/linear audit as its own branch because it may require material retuning.

Status (July 2026):

- Done: #1 (sRGB/linear), #2 (DPR sizing), #3 (MSAA toggle).
- Added: tonemap curve (Off / Reinhard / ACES / AgX / AgX Punchy) with
  exposure and sky intensity in the debug panel. Tuned defaults (July
  2026): ACES at exposure 0.8, sky intensity 1.0. AgX Punchy softened to
  power 1.15 / saturation 1.2. Re-run the curve decision once, after
  lighting gains real HDR headroom (hemisphere ambient / emissive) — that
  is the scene AgX is built for. Off is bit-identical to the pre-tonemap
  pipeline (hardware clamp), so the A/B is fair. Sky intensity treats the
  LDR-authored skybox as tunable emission and must scale all sky reads
  (dome, fog, specular) identically. The pinned pow retune below should
  happen with ACES enabled — tune against the final display transform.
- The pipeline is now linear-only. It was first built as a Gamma/Linear
  debug toggle to validate the plumbing and see the genuine differences
  (fog blending, MSAA resolve, AO gradient shape, specular accumulation —
  dark marble changed the most); the toggle was then removed because the
  A/B compares tuned-gamma against untuned-linear and can never show the
  thing we would ship.
- Specular split + Fresnel (July 2026): the old sky-tinted Blinn-Phong hack
  multiplied the sun-glint lobe into the sky reflection, so the mirror look
  vanished whenever the view left the sun's highlight cone (most visible as
  dark marble losing all shadow contrast from sun-averted views). Specular
  is now two terms (`SPECULAR_WGSL` in `src/shader/shared.ts`): a white sun
  glint (Blinn-Phong, shadow-gated) plus a Fresnel-weighted sky mirror
  (fixed F0 = 0.04 Schlick, present from every view direction, not
  shadow-gated, AO-gated on terrain). New per-material `reflectivity`
  (0..1) scales the Fresnel curve; global additive boost in the Specular
  debug folder. Material glint values kept their old numbers and need a
  re-tune by eye against the new model.
- Roughness-aware reflections (#7, July 2026): the sky mirror samples the
  cubemap at `lod = roughness * maxMip` (`skyReflection` in
  `src/shader/shared.ts`). Per-material `roughness` 0..1 in block.ts
  (dark marble 0.05, marble 0.3, brick 0.9) + additive debug boost. Box
  mips, not GGX-prefiltered — a look, not a simulation; the linear
  roughness→mip mapping is the knob if mid-roughness reads wrong. At max
  roughness the mirror converges toward the whole-sky average — the same
  quantity hemisphere ambient wants, from the other end.
- PINNED: hemisphere ambient (#4) — the diffuse twin of the sky-mirror
  term. Do it bundled with the pow retune and the AO-on-ambient rework
  (#5): all three rewrite the same brightness constants, so the scene
  only gets retuned once.
- PINNED: the shaders carry a perceptual→linear `pow(x, 2.2)` compensation
  (see `computeTerrainLighting` in `src/shader/voxel.ts` and the entity
  fragment shader) so brightness constants keep their gamma-era tuned
  meanings. Address soon — natural moment is the tonemap experiment, which
  forces a brightness retune anyway. Material `shininess`/`specularStrength`
  values are the most gamma-tuned numbers left (Phong exponents typically
  need raising after a linear migration).
