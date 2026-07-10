import { blockRegistry } from '../block';
import { RENDER_MODE, TONEMAP_MODE } from '../render-config';

/** Emit a number as a valid WGSL f32 literal (always contains a decimal point). */
export function f32Literal(n: number): string {
	const s = n.toString();
	return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

/** Emit a WGSL vec3f literal from any numeric triple. */
export function wgslVec3(v: ArrayLike<number>): string {
	return `vec3f(${f32Literal(v[0])}, ${f32Literal(v[1])}, ${f32Literal(v[2])})`;
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
	const refl: string[] = [];
	for (let id = 0; id < blockRegistry.count; id++) {
		const props = blockRegistry.get(id);
		shin.push(f32Literal(props?.shininess ?? 0));
		spec.push(f32Literal(props?.specularStrength ?? 0));
		refl.push(f32Literal(props?.reflectivity ?? 0));
	}
	const n = String(shin.length);
	return `
		const MATERIAL_SHININESS = array<f32, ${n}>(${shin.join(', ')});
		const MATERIAL_SPEC_STRENGTH = array<f32, ${n}>(${spec.join(', ')});
		const MATERIAL_REFLECTIVITY = array<f32, ${n}>(${refl.join(', ')});
	`;
}

/** WGSL consts (`const PREFIX_NAME: f32 = value;`) generated from a TS mode table. */
function wgslModeConsts(prefix: string, table: Record<string, number>): string {
	return Object.entries(table)
		.map(
			([name, value]) =>
				`const ${prefix}_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}: f32 = ${f32Literal(value)};`,
		)
		.join('\n\t\t');
}

export const RENDER_MODE_WGSL = wgslModeConsts('RENDER_MODE', RENDER_MODE);

/**
 * Single WGSL declaration of the shared uniform buffer's layout. Interpolated
 * into every shader that binds the buffer (voxel, entity, shadow, skybox) —
 * a field added here reaches all of them. Byte offsets are documented where
 * the buffer is created and written, in main.ts; not every shader reads every
 * field.
 */
export const SHARED_UNIFORMS_WGSL = /* wgsl */ `
	struct Uniforms {
		matrix: mat4x4f,
		eyePosition: vec3f,
		shininess: f32,
		specularStrength: f32,
		fogStart: f32,
		fogEnd: f32,
		reflectivity: f32,
		lightMatrix: mat4x4f,
		shadowStrength: f32,
		shadowBias: f32,
		shadowsEnabled: f32,
		shadowNormalBias: f32,
		renderMode: f32,
		tonemapMode: f32,
		exposure: f32,
		skyIntensity: f32,
	}
`;

/**
 * Perceptual→linear compensation exponent (PINNED: retune alongside the
 * tonemap). Brightness constants in the voxel and entity shaders predate the
 * linear pipeline and are tuned in gamma-era units, where a flat surface
 * displayed as linear_tex * brightness^2.2; pow(x, GAMMA) keeps those values
 * meaning what they meant. Retuning the constants in linear units deletes
 * this and the pows that use it.
 */
export const GAMMA_WGSL = /* wgsl */ `
	const GAMMA: f32 = 2.2;
`;

/**
 * Single point where sky texels become scene light: the cubemap is
 * LDR-authored art re-scaled as emission by skyIntensity. Every sky read
 * (dome, fog, specular) must go through here or they stop matching at the
 * horizon. The z-flip converts world direction to cubemap space.
 */
export const SKY_SAMPLE_WGSL = /* wgsl */ `
	fn sampleSky(t: texture_cube<f32>, s: sampler, dir: vec3f, intensity: f32) -> vec3f {
		return textureSample(t, s, dir * vec3f(1, 1, -1)).rgb * intensity;
	}
`;

/**
 * Split specular model: a Blinn-Phong sun glint plus a Fresnel-weighted
 * mirror reflection of the sky. Kept separate because they answer different
 * questions — the glint is "am I near the sun's mirror direction?" (gate it
 * by shadow visibility at the call site: no sun, no glint) while the
 * reflection is "what does the sky look like in this surface?" and exists
 * from every view direction, shadowed or not — the sky stays visible from
 * inside a sun shadow. Multiplying the two was the old hack that made
 * reflections vanish whenever the view left the sun's highlight cone.
 *
 * Interpolate after SKY_SAMPLE_WGSL and SUN_DIRECTION_WGSL.
 * PINNED: roughness via cubemap mip — sample the reflection at a
 * material-driven LOD for satin vs polished (experiment #7).
 */
export const SPECULAR_WGSL = /* wgsl */ `
	// Dielectric head-on reflectance (~4% for stone/glass). Materials scale
	// the whole curve by their reflectivity instead of owning an F0, so one
	// 0..1 knob spans matte -> polished.
	const FRESNEL_F0: f32 = 0.04;

	fn fresnelSchlick(NdotV: f32) -> f32 {
		let m = 1.0 - NdotV;
		let m2 = m * m;
		return FRESNEL_F0 + (1.0 - FRESNEL_F0) * m2 * m2 * m;
	}

	fn sunGlint(normal: vec3f, viewDir: vec3f, exponent: f32) -> f32 {
		let halfway = normalize(LIGHT_DIR + viewDir);
		return pow(max(dot(normal, halfway), 0.0), exponent);
	}

	fn skyReflection(t: texture_cube<f32>, s: sampler, normal: vec3f, viewDir: vec3f, intensity: f32) -> vec3f {
		let mirrored = reflect(-viewDir, normal);
		return sampleSky(t, s, mirrored, intensity) * fresnelSchlick(max(dot(normal, viewDir), 0.0));
	}
`;

/**
 * Tonemap functions shared by the voxel, entity, and skybox shaders.
 *
 * Maps unbounded linear scene light into [0,1] ahead of the -srgb target
 * encode. Exposure multiplies before the curve. Mode 0 (off) passes through,
 * leaving the implicit hardware clamp — so tonemap off renders bit-identical
 * to the pre-tonemap pipeline. Mode constants are generated from TONEMAP_MODE
 * in render-config.ts.
 */
export const TONEMAP_WGSL = /* wgsl */ `
	${wgslModeConsts('TONEMAP', TONEMAP_MODE)}

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

	fn applyTonemap(c: vec3f, exposure: f32, mode: f32) -> vec3f {
		let exposed = c * exposure;
		if (mode == TONEMAP_REINHARD) {
			return tonemapReinhard(exposed);
		}
		if (mode == TONEMAP_ACES) {
			return tonemapACES(exposed);
		}
		if (mode == TONEMAP_AGX) {
			return agxEotf(tonemapAgX(exposed));
		}
		if (mode == TONEMAP_AGX_PUNCHY) {
			return agxEotf(agxLookPunchy(tonemapAgX(exposed)));
		}
		return exposed;
	}
`;
