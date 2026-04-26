import { SUN_DIRECTION_WGSL } from '../lighting';
import { buildMaterialLUT } from './shared';

const VoxelShader = /*wgsl*/ `
	${buildMaterialLUT()}
	${SUN_DIRECTION_WGSL}

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

	fn shadowVisibility(shadowPos: vec4f, normal: vec3f) -> f32 {
		let proj = shadowPos.xyz / shadowPos.w;
		let uv = vec2f(proj.x * 0.5 + 0.5, 0.5 - proj.y * 0.5);
		let facing = max(dot(normal, LIGHT_DIR), 0.0);
		let slopeBias = uni.shadowBias * (1.0 - facing) * 2.0;
		let visibility = textureSampleCompare(
			shadowTexture,
			shadowSampler,
			uv,
			proj.z - uni.shadowBias - slopeBias,
		);
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

	@fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
		let texColor = textureSampleBias(myTexture, mySampler, vsOut.uv, vsOut.texLayer, MIP_LOD_BIAS);

		// Per-face shading aligned with LIGHT_DIR (sun is up / south / west).
		// Lit sides brighter than shadowed sides; values roughly track
		// dot(n, LIGHT_DIR) mapped into [0.5, 1.0].
		let n = vsOut.normal;
		var brightness: f32;
		if (n.y > 0.5) {
			brightness = 1.0;    // top      (+Y, sun overhead)
		} else if (n.y < -0.5) {
			brightness = 0.5;    // bottom   (-Y, away from sun)
		} else if (n.z > 0.5) {
			brightness = 0.9;    // south    (+Z, lit)
		} else if (n.x < -0.5) {
			brightness = 0.8;    // west     (-X, lit)
		} else if (n.x > 0.5) {
			brightness = 0.6;    // east     (+X, shadowed)
		} else {
			brightness = 0.55;   // north    (-Z, shadowed)
		}

		// Sky-tinted specular: sample cubemap along reflection for highlight color
		let eyeToSurface = normalize(vsOut.worldPos - uni.eyePosition);
		let reflected = reflect(eyeToSurface, n);
		let skyColor = textureSample(skyTexture, skySampler, reflected * vec3f(1, 1, -1));

		// Per-material reflection params (LUT), additively boosted by global tweakpane values
		let matShin = MATERIAL_SHININESS[vsOut.texLayer];
		let matSpec = MATERIAL_SPEC_STRENGTH[vsOut.texLayer];
		let effShin = matShin + uni.shininess;
		let effSpec = matSpec + uni.specularStrength;

		// Blinn-Phong specular highlight, tinted by skybox instead of white
		let V = normalize(uni.eyePosition - vsOut.worldPos);
		let H = normalize(LIGHT_DIR + V);
		let spec = pow(max(dot(n, H), 0.0), effShin);
		let specular = effSpec * spec * skyColor.rgb;
		let sunVisibility = shadowVisibility(vsOut.shadowPos, n);

		let dist = length(vsOut.worldPos - uni.eyePosition);
		let fogFactor = clamp((uni.fogEnd - dist) / (uni.fogEnd - uni.fogStart), 0.0, 1.0);
		let shadowFogFade = smoothstep(0.0, 1.0, fogFactor);
		let directLight = mix(
			1.0,
			mix(1.0 - uni.shadowStrength, 1.0, sunVisibility),
			shadowFogFade,
		);

		// a nice blue vec3f(0.49, 0.55, 0.68)
		let shadowColor = vec3f(0.1, 0.1, 0.1); // AO shadow tint
		let ambientBrightness = 0.5;
		let directBrightness = max(brightness - ambientBrightness, 0.0);
		let shadedBrightness = ambientBrightness + directBrightness * directLight;
		let lit = texColor.rgb * shadedBrightness;
		let base = mix(shadowColor, lit, vsOut.ao);
		let final_color = base + specular * directLight;

		// Distance fog — sample skybox in eye-to-fragment direction so fog matches the sky behind it
		let fogColor = textureSample(skyTexture, skySampler, eyeToSurface * vec3f(1, 1, -1)).rgb;
		let fogged = mix(fogColor, final_color, fogFactor);
		return vec4f(fogged, texColor.a);
	}
`;

export default VoxelShader;
