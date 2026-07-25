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
- Terrain lighting rework (#4 + #5 + pow retune, July 2026): landed as
  the ambient/sun/face-table model after a full hemisphere-lighting
  detour. Hemisphere ambient (`mix(ground, sky, n.y*0.5+0.5)` + real
  `NdotL` sun) was built first — including cubemap-derived colors and a
  circumsolar azimuth tilt — and abandoned: on a 6-normal voxel world
  its physically-parameterized knobs are all coupled (every slider moves
  every face), which turned tuning into whack-a-mole, while its walls
  were *less* distinct than the old hand table (sun-averted corners
  rendered as one flat plane). What survived the detour: linear-space
  authoring (both pows and `GAMMA` are gone from the terrain shader),
  AO-on-ambient instead of the fixed `AO_SHADOW_COLOR` mix (deleted),
  shadow gating only the sun term, and color as a first-class control.
  The model (`computeTerrainLighting` in `src/shader/voxel.ts`):
  `ambient = ambientColor·ambientLevel·AO`; `direct = sunColor·
  sunIntensity·faceTable[normal]·directLight·mix(1, AO, aoDirect)`.
  The face table is six hand-authored values (Lighting debug folder),
  evaluated via squared-normal blending (`FACE_LIGHT_WGSL` — HL2
  "ambient cube" basis): exact table lookup on axis-aligned voxel
  faces, smooth blend on arbitrary normals so deferred entity adoption
  (resting cubes matching terrain exactly, tipping without popping)
  needs no new machinery. Defaults reproduce the old gamma-era look
  (verified by A/B screenshot); east/north get small nonzero sun
  (0.12/0.06) — bounce light pretending to be sun, so sun-averted
  corners read. Known trade: face differences live in the shadow-gated
  term, so deep shadow (strength → 1) flattens them; AO + texture carry
  it there, same as Minecraft.
- Entity lighting is still the gamma-era model (`pow(x, GAMMA)` +
  `ambient 0.5 + 0.5·NdotL`) — deferred deliberately; `GAMMA_WGSL`
  survives only for it. When entities adopt the terrain model, use
  `faceLight` + the same ambient/sun colors, and delete GAMMA. Material
  `shininess`/`specularStrength` remain gamma-tuned numbers.
