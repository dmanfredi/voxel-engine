import { SUN_DIRECTION_WGSL } from '../lighting';
import { SHADOW_MAP_SIZE } from '../shadow';
import { buildMaterialLUT, buildTonemapWGSL } from './shared';

const SHADOW_TEXEL_SIZE = (1 / SHADOW_MAP_SIZE).toFixed(12);

const VoxelShader = /*wgsl*/ `
	${buildMaterialLUT()}
	${buildTonemapWGSL()}
	${SUN_DIRECTION_WGSL}
	const SHADOW_TEXEL_SIZE = vec2f(${SHADOW_TEXEL_SIZE}, ${SHADOW_TEXEL_SIZE});
	const RENDER_MODE_ALBEDO: f32 = 1.0;
	const RENDER_MODE_LIGHTING: f32 = 2.0;
	const RENDER_MODE_AO: f32 = 3.0;
	const AO_SHADOW_COLOR: vec3f = vec3f(0.1, 0.1, 0.1);
	const GAMMA: f32 = 2.2;

	struct Uniforms {
		matrix: mat4x4f,
		eyePosition: vec3f,
		shininess: f32,
		specularStrength: f32,
		fogStart: f32,
		fogEnd: f32,
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

	struct Vertex {
		@location(0) position: vec4f,
		@location(1) normal: vec3f,
		@location(2) uv: vec2f,
		@location(3) ao: f32,
		@location(4) texLayer: u32,
	}

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) uv: vec2f,
		@location(1) @interpolate(flat) texLayer: u32,
		@location(2) normal: vec3f,
		@location(3) ao: f32,
		@location(4) worldPos: vec3f,
		@location(5) shadowPos: vec4f,
	}

	struct TerrainLighting {
		shadedBrightness: f32,
		aoLighting: vec3f,
		aoShadowColor: vec3f,
		specular: vec3f,
		directLight: f32,
		fogFactor: f32,
		fogColor: vec3f,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(0) @binding(1) var mySampler: sampler;
	@group(0) @binding(2) var myTexture: texture_2d_array<f32>;
	@group(0) @binding(3) var skySampler: sampler;
	@group(0) @binding(4) var skyTexture: texture_cube<f32>;
	@group(0) @binding(5) var shadowSampler: sampler_comparison;
	@group(0) @binding(6) var shadowTexture: texture_depth_2d;

	@group(1) @binding(0) var<uniform> chunkOffset: vec4f;

	@vertex fn vs(vert: Vertex) -> VSOutput {
		var vsOut: VSOutput;
		let worldPos = vert.position.xyz + chunkOffset.xyz;
		vsOut.position = uni.matrix * vec4f(worldPos, 1.0);
		vsOut.uv = vert.uv;
		vsOut.texLayer = vert.texLayer;
		vsOut.normal = vert.normal;
		vsOut.ao = vert.ao;
		vsOut.worldPos = worldPos;
		let shadowWorldPos = worldPos + vert.normal * uni.shadowNormalBias;
		vsOut.shadowPos = uni.lightMatrix * vec4f(shadowWorldPos, 1.0);
		return vsOut;
	}

	// Negative LOD bias nudges the sampler toward sharper mip levels than the
	// automatic derivative-based selection would pick. -1.0 is nice.
	const MIP_LOD_BIAS: f32 = -1.0;

	fn shadowCompare(uv: vec2f, depth: f32, offset: vec2f) -> f32 {
		return textureSampleCompare(
			shadowTexture,
			shadowSampler,
			uv + offset * SHADOW_TEXEL_SIZE,
			depth,
		);
	}

	fn shadowVisibility(shadowPos: vec4f, normal: vec3f) -> f32 {
		let proj = shadowPos.xyz / shadowPos.w;
		let uv = vec2f(proj.x * 0.5 + 0.5, 0.5 - proj.y * 0.5);
		let facing = max(dot(normal, LIGHT_DIR), 0.0);
		let slopeBias = uni.shadowBias * (1.0 - facing) * 2.0;
		let depth = proj.z - uni.shadowBias - slopeBias;
		let visibility = (
			shadowCompare(uv, depth, vec2f(-1.0, -1.0)) +
			shadowCompare(uv, depth, vec2f(0.0, -1.0)) * 2.0 +
			shadowCompare(uv, depth, vec2f(1.0, -1.0)) +
			shadowCompare(uv, depth, vec2f(-1.0, 0.0)) * 2.0 +
			shadowCompare(uv, depth, vec2f(0.0, 0.0)) * 4.0 +
			shadowCompare(uv, depth, vec2f(1.0, 0.0)) * 2.0 +
			shadowCompare(uv, depth, vec2f(-1.0, 1.0)) +
			shadowCompare(uv, depth, vec2f(0.0, 1.0)) * 2.0 +
			shadowCompare(uv, depth, vec2f(1.0, 1.0))
		) / 16.0;
		let inBounds = proj.x >= -1.0 && proj.x <= 1.0 && proj.y >= -1.0 && proj.y <= 1.0 && proj.z >= 0.0 && proj.z <= 1.0;
		let sunFacing = dot(normal, LIGHT_DIR) > 0.0;
		let edgeDistance = min(
			min(proj.x + 1.0, 1.0 - proj.x),
			min(proj.y + 1.0, 1.0 - proj.y),
		);
		let edgeFade = clamp(edgeDistance / 0.08, 0.0, 1.0);
		let fadedVisibility = mix(1.0, visibility, edgeFade);
		return select(
			1.0,
			mix(1.0, fadedVisibility, uni.shadowsEnabled),
			inBounds && sunFacing,
		);
	}
	fn terrainFaceBrightness(normal: vec3f) -> f32 {
		// Per-face shading aligned with LIGHT_DIR (sun is up / south / west).
		// Lit sides brighter than shadowed sides; values roughly track
		// dot(n, LIGHT_DIR) mapped into [0.5, 1.0].
		if (normal.y > 0.5) {
			return 1.0; // top (+Y, sun overhead)
		} else if (normal.y < -0.5) {
			return 0.5; // bottom (-Y, away from sun)
		} else if (normal.z > 0.5) {
			return 0.9; // south (+Z, lit)
		} else if (normal.x < -0.5) {
			return 0.8; // west (-X, lit)
		} else if (normal.x > 0.5) {
			return 0.6; // east (+X, shadowed)
		}
		return 0.55; // north (-Z, shadowed)
	}

	fn terrainFogFactor(worldPos: vec3f) -> f32 {
		let dist = length(worldPos - uni.eyePosition);
		return clamp((uni.fogEnd - dist) / (uni.fogEnd - uni.fogStart), 0.0, 1.0);
	}

	fn terrainSpecular(vsOut: VSOutput, normal: vec3f) -> vec3f {
		let eyeToSurface = normalize(vsOut.worldPos - uni.eyePosition);
		let reflected = reflect(eyeToSurface, normal);
		// skyIntensity treats the LDR-authored cubemap as emission so the sky's
		// light level can be tuned independently of the authored texels. It
		// must scale every sky read (dome, fog, specular) identically or the
		// fog band stops matching the horizon.
		let skyColor = textureSample(skyTexture, skySampler, reflected * vec3f(1, 1, -1)) * uni.skyIntensity;

		let matShin = MATERIAL_SHININESS[vsOut.texLayer];
		let matSpec = MATERIAL_SPEC_STRENGTH[vsOut.texLayer];
		let effShin = matShin + uni.shininess;
		let effSpec = matSpec + uni.specularStrength;

		let V = normalize(uni.eyePosition - vsOut.worldPos);
		let H = normalize(LIGHT_DIR + V);
		let spec = pow(max(dot(normal, H), 0.0), effShin);
		return effSpec * spec * skyColor.rgb;
	}

	fn computeTerrainLighting(vsOut: VSOutput, normal: vec3f) -> TerrainLighting {
		let fogFactor = terrainFogFactor(vsOut.worldPos);
		let sunVisibility = shadowVisibility(vsOut.shadowPos, normal);
		let shadowFogFade = smoothstep(0.0, 1.0, fogFactor);
		let directLight = mix(
			1.0,
			mix(1.0 - uni.shadowStrength, 1.0, sunVisibility),
			shadowFogFade,
		);

		let ambientBrightness = 0.5;
		let faceBrightness = terrainFaceBrightness(normal);
		let directBrightness = max(faceBrightness - ambientBrightness, 0.0);
		// Perceptual→linear compensation (PINNED: retune alongside the
		// tonemap experiment). The brightness table and AO endpoint predate
		// the linear pipeline and are tuned in gamma-era units, where a flat
		// surface displayed as linear_tex * brightness^2.2; the pow keeps
		// those values meaning what they meant. Retuning the constants in
		// linear units deletes these pows.
		let shadedBrightness = pow(ambientBrightness + directBrightness * directLight, GAMMA);
		let aoShadowColor = pow(AO_SHADOW_COLOR, vec3f(GAMMA));

		let aoLighting = mix(aoShadowColor, vec3f(shadedBrightness), vsOut.ao);

		let eyeToSurface = normalize(vsOut.worldPos - uni.eyePosition);
		let fogColor = textureSample(skyTexture, skySampler, eyeToSurface * vec3f(1, 1, -1)).rgb * uni.skyIntensity;

		return TerrainLighting(
			shadedBrightness,
			aoLighting,
			aoShadowColor,
			terrainSpecular(vsOut, normal),
			directLight,
			fogFactor,
			fogColor,
		);
	}

	@fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
		let texColor = textureSampleBias(myTexture, mySampler, vsOut.uv, vsOut.texLayer, MIP_LOD_BIAS);
		if (uni.renderMode == RENDER_MODE_ALBEDO) {
			return vec4f(texColor.rgb, texColor.a);
		}
		if (uni.renderMode == RENDER_MODE_AO) {
			return vec4f(vec3f(vsOut.ao), 1.0);
		}

		let n = vsOut.normal;
		let lighting = computeTerrainLighting(vsOut, n);
		if (uni.renderMode == RENDER_MODE_LIGHTING) {
			return vec4f(lighting.aoLighting, 1.0);
		}

		let base = mix(lighting.aoShadowColor, texColor.rgb * lighting.shadedBrightness, vsOut.ao);
		let final_color = base + lighting.specular * lighting.directLight;
		let fogged = mix(lighting.fogColor, final_color, lighting.fogFactor);
		let mapped = applyTonemap(fogged * uni.exposure, uni.tonemapMode);
		return vec4f(mapped, texColor.a);
	}
`;

export default VoxelShader;
