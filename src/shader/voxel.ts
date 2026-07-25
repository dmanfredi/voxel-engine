import { SUN_DIRECTION_WGSL } from '../lighting';
import { SHADOW_MAP_SIZE } from '../shadow';
import {
	buildMaterialLUT,
	FACE_LIGHT_WGSL,
	RENDER_MODE_WGSL,
	SHARED_UNIFORMS_WGSL,
	SKY_SAMPLE_WGSL,
	SPECULAR_WGSL,
	TONEMAP_WGSL,
} from './shared';

const SHADOW_TEXEL_SIZE = (1 / SHADOW_MAP_SIZE).toFixed(12);

const VoxelShader = /*wgsl*/ `
	${buildMaterialLUT()}
	${TONEMAP_WGSL}
	${SKY_SAMPLE_WGSL}
	${FACE_LIGHT_WGSL}
	${RENDER_MODE_WGSL}
	${SUN_DIRECTION_WGSL}
	${SPECULAR_WGSL}
	const SHADOW_TEXEL_SIZE = vec2f(${SHADOW_TEXEL_SIZE}, ${SHADOW_TEXEL_SIZE});

	${SHARED_UNIFORMS_WGSL}

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
		light: vec3f,
		specular: vec3f,
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

	// textureSampleCompareLevel: no derivative-based LOD, so the taps are
	// legal behind shadowVisibility's non-uniform early-out; the shadow map
	// has a single mip, so level 0 is what implicit LOD sampled anyway.
	fn shadowCompare(uv: vec2f, depth: f32, offset: vec2f) -> f32 {
		return textureSampleCompareLevel(
			shadowTexture,
			shadowSampler,
			uv + offset * SHADOW_TEXEL_SIZE,
			depth,
		);
	}

	fn shadowVisibility(shadowPos: vec4f, normal: vec3f) -> f32 {
		let proj = shadowPos.xyz / shadowPos.w;
		let inBounds = proj.x >= -1.0 && proj.x <= 1.0 && proj.y >= -1.0 && proj.y <= 1.0 && proj.z >= 0.0 && proj.z <= 1.0;
		let facing = dot(normal, LIGHT_DIR);
		// Sun-averted or out-of-map fragments are fully lit; skip the PCF taps.
		if (!inBounds || facing <= 0.0) {
			return 1.0;
		}
		let uv = vec2f(proj.x * 0.5 + 0.5, 0.5 - proj.y * 0.5);
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
		let edgeDistance = min(
			min(proj.x + 1.0, 1.0 - proj.x),
			min(proj.y + 1.0, 1.0 - proj.y),
		);
		let edgeFade = clamp(edgeDistance / 0.08, 0.0, 1.0);
		let fadedVisibility = mix(1.0, visibility, edgeFade);
		return mix(1.0, fadedVisibility, uni.shadowsEnabled);
	}
	fn terrainFogFactor(worldPos: vec3f) -> f32 {
		let dist = length(worldPos - uni.eyePosition);
		return clamp((uni.fogEnd - dist) / (uni.fogEnd - uni.fogStart), 0.0, 1.0);
	}

	fn terrainSpecular(vsOut: VSOutput, normal: vec3f, directLight: f32) -> vec3f {
		let viewDir = normalize(uni.eyePosition - vsOut.worldPos);
		// Tweakpane values boost the per-material numbers additively; clamps
		// keep the negative slider ranges from flipping pow/light signs.
		let glintExponent = max(MATERIAL_SHININESS[vsOut.texLayer] + uni.shininess, 1.0);
		let glintStrength = max(MATERIAL_SPEC_STRENGTH[vsOut.texLayer] + uni.specularStrength, 0.0);
		let reflectivity = clamp(MATERIAL_REFLECTIVITY[vsOut.texLayer] + uni.reflectivity, 0.0, 1.0);
		let roughness = clamp(MATERIAL_ROUGHNESS[vsOut.texLayer] + uni.roughness, 0.0, 1.0);

		let glint = sunGlint(normal, viewDir, glintExponent) * glintStrength * directLight;
		let reflection = skyReflection(skyTexture, skySampler, normal, viewDir, uni.skyIntensity, roughness) * reflectivity;
		// AO gates both terms: crevices see less sun and less sky.
		return (vec3f(glint) + reflection) * vsOut.ao;
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

		// AO fully gates ambient (crevices see less sky) but gates direct sun
		// only by the aoDirect knob — the shadow map already occludes the sun,
		// so full AO there would double-count; a partial re-darkening reads as
		// micro-shadowing the shadow map can't resolve.
		let ambient = uni.ambientLight * vsOut.ao;
		let direct = uni.sunLight
			* faceLight(normal, uni.faceTablePos, uni.faceTableNeg)
			* directLight
			* mix(1.0, vsOut.ao, uni.aoDirect);

		let eyeToSurface = normalize(vsOut.worldPos - uni.eyePosition);
		let fogColor = sampleSky(skyTexture, skySampler, eyeToSurface, uni.skyIntensity);

		return TerrainLighting(
			ambient + direct,
			terrainSpecular(vsOut, normal, directLight),
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
			return vec4f(lighting.light, 1.0);
		}

		let final_color = texColor.rgb * lighting.light + lighting.specular;
		let fogged = mix(lighting.fogColor, final_color, lighting.fogFactor);
		let mapped = applyTonemap(fogged, uni.exposure, uni.tonemapMode);
		return vec4f(mapped, texColor.a);
	}
`;

export default VoxelShader;
