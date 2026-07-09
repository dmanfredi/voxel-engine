import { blockRegistry } from '../block';

/** Emit a number as a valid WGSL f32 literal (always contains a decimal point). */
function f32Literal(n: number): string {
	const s = n.toString();
	return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

/**
 * Generate per-material WGSL const arrays indexed by block ID (== texLayer).
 *
 * Consumed by any shader that wants per-material reflection params — currently
 * the voxel shader and the entity shader. Runs at module load; values are
 * baked into the shader string when `createShaderModule` is called.
 */
export function buildMaterialLUT(): string {
	const shin: string[] = [];
	const spec: string[] = [];
	for (let id = 0; id < blockRegistry.count; id++) {
		const props = blockRegistry.get(id);
		shin.push(f32Literal(props?.shininess ?? 0));
		spec.push(f32Literal(props?.specularStrength ?? 0));
	}
	const n = String(shin.length);
	return `
		const MATERIAL_SHININESS = array<f32, ${n}>(${shin.join(', ')});
		const MATERIAL_SPEC_STRENGTH = array<f32, ${n}>(${spec.join(', ')});
	`;
}

/**
 * Tonemap functions shared by the voxel, entity, and skybox shaders.
 *
 * Maps unbounded linear scene light into [0,1] ahead of the -srgb target
 * encode. Mode 0 (off) passes through, leaving the implicit hardware clamp
 * — so tonemap off renders bit-identical to the pre-tonemap pipeline.
 */
export function buildTonemapWGSL(): string {
	return /* wgsl */ `
		const TONEMAP_REINHARD: f32 = 1.0;
		const TONEMAP_ACES: f32 = 2.0;
		const TONEMAP_AGX: f32 = 3.0;
		const TONEMAP_AGX_PUNCHY: f32 = 4.0;

		fn tonemapReinhard(c: vec3f) -> vec3f {
			return c / (1.0 + c);
		}

		// Narkowicz's fitted ACES approximation (per-channel).
		fn tonemapACES(c: vec3f) -> vec3f {
			let mapped = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
			return clamp(mapped, vec3f(0.0), vec3f(1.0));
		}

		// AgX (Blender 4.0's default view transform) via the minimal
		// polynomial port (Wrensch/Three.js lineage). Inset matrix pulls the
		// primaries inward so intense colors desaturate toward white instead
		// of hue-skewing; matrices are column-major, matching the GLSL
		// reference.
		const AGX_INSET = mat3x3f(
			vec3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051),
			vec3f(0.0784335999999992, 0.878468636469772, 0.0784336),
			vec3f(0.0792237451477643, 0.0791661274605434, 0.879142973793104)
		);
		const AGX_OUTSET = mat3x3f(
			vec3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438),
			vec3f(-0.0980208811401368, 1.15190312990417, -0.0980434501171241),
			vec3f(-0.0990297440797205, -0.0989611768448433, 1.15107367264116)
		);
		const AGX_MIN_EV: f32 = -12.47393;
		const AGX_MAX_EV: f32 = 4.026069;

		// 6th-order fit of the AgX sigmoid. Saturated because the fit
		// overshoots [0,1] slightly at the ends, and the punchy look pows
		// the result (negative input would be NaN).
		fn agxContrastApprox(x: vec3f) -> vec3f {
			let x2 = x * x;
			let x4 = x2 * x2;
			return saturate(
				15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
					- 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232
			);
		}

		fn tonemapAgX(c: vec3f) -> vec3f {
			var val = AGX_INSET * c;
			val = clamp(
				log2(max(val, vec3f(1e-10))),
				vec3f(AGX_MIN_EV),
				vec3f(AGX_MAX_EV)
			);
			val = (val - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
			return agxContrastApprox(val);
		}

		// ASC-CDL-style "punchy" look, applied in AgX's encoded space between
		// sigmoid and outset. Reference values are power 1.35 / saturation
		// 1.4; softened to 1.15 / 1.2 by eye — the stock look read too dark
		// against this scene.
		fn agxLookPunchy(v: vec3f) -> vec3f {
			let luma = dot(v, vec3f(0.2126, 0.7152, 0.0722));
			let punched = pow(v, vec3f(1.15));
			return luma + 1.2 * (punched - luma);
		}

		// Outset, then linearize: the sigmoid fit bakes a 2.2 display encode
		// into its output, and our -srgb render target encodes again on
		// write — skipping this pow would double-encode (washed out).
		fn agxEotf(v: vec3f) -> vec3f {
			let val = AGX_OUTSET * v;
			return pow(max(val, vec3f(0.0)), vec3f(2.2));
		}

		fn applyTonemap(c: vec3f, mode: f32) -> vec3f {
			if (mode == TONEMAP_REINHARD) {
				return tonemapReinhard(c);
			}
			if (mode == TONEMAP_ACES) {
				return tonemapACES(c);
			}
			if (mode == TONEMAP_AGX) {
				return agxEotf(tonemapAgX(c));
			}
			if (mode == TONEMAP_AGX_PUNCHY) {
				return agxEotf(agxLookPunchy(tonemapAgX(c)));
			}
			return c;
		}
	`;
}
