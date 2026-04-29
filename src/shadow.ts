import { mat4, vec3 } from 'wgpu-matrix';
import { SUN_DIRECTION } from './lighting';

export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_HALF_EXTENT = 1800;
const SHADOW_DEPTH = 10000;

function f32Literal(n: number): string {
	const s = n.toString();
	return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

const BAYER_8X8 = [
	0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4,
	52, 11, 59, 7, 55, 40, 24, 36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49,
	13, 61, 34, 18, 46, 30, 33, 17, 45, 29, 10, 58, 6, 54, 9, 57, 5, 53, 42,
	26, 38, 22, 41, 25, 37, 21,
];

function wgslVec3(v: Float32Array): string {
	return `vec3f(${f32Literal(v[0])}, ${f32Literal(v[1])}, ${f32Literal(v[2])})`;
}

function buildTerrainShadowShader(worldWrapWidth: number): string {
	const lightDir = vec3.normalize(
		vec3.create(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]),
	);
	const lightX = vec3.normalize(vec3.cross(vec3.create(0, 1, 0), lightDir));
	const lightY = vec3.normalize(vec3.cross(lightDir, lightX));
	const ditherCellSize = (SHADOW_HALF_EXTENT * 2) / SHADOW_MAP_SIZE;
	const bayer8x8 = BAYER_8X8.map((n) =>
		f32Literal((n + 0.5) / 64),
	).join(', ');

	return /* wgsl */ `
	const WORLD_WRAP_WIDTH = ${f32Literal(worldWrapWidth)};
	const SHADOW_DITHER_CELL_SIZE = ${f32Literal(ditherCellSize)};
	const LIGHT_DITHER_X = ${wgslVec3(lightX)};
	const LIGHT_DITHER_Y = ${wgslVec3(lightY)};
	const WRAP_OFFSETS = array<vec2f, 9>(
		vec2f(-WORLD_WRAP_WIDTH, -WORLD_WRAP_WIDTH),
		vec2f(0.0, -WORLD_WRAP_WIDTH),
		vec2f(WORLD_WRAP_WIDTH, -WORLD_WRAP_WIDTH),
		vec2f(-WORLD_WRAP_WIDTH, 0.0),
		vec2f(0.0, 0.0),
		vec2f(WORLD_WRAP_WIDTH, 0.0),
		vec2f(-WORLD_WRAP_WIDTH, WORLD_WRAP_WIDTH),
		vec2f(0.0, WORLD_WRAP_WIDTH),
		vec2f(WORLD_WRAP_WIDTH, WORLD_WRAP_WIDTH),
	);

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
		@location(0) position: vec3f,
	}

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) worldPos: vec3f,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(1) @binding(0) var<uniform> chunkOffset: vec4f;

	const BAYER_8X8 = array<f32, 64>(
		${bayer8x8},
	);

	fn wrap8(v: i32) -> u32 {
		return u32(((v % 8i) + 8i) % 8i);
	}

	fn ditherThreshold(worldPos: vec3f) -> f32 {
		let lightSpacePos = vec2f(
			dot(worldPos, LIGHT_DITHER_X),
			dot(worldPos, LIGHT_DITHER_Y),
		);
		let cell = vec2i(floor(lightSpacePos / SHADOW_DITHER_CELL_SIZE));
		let x = wrap8(cell.x);
		let y = wrap8(cell.y);
		return BAYER_8X8[y * 8u + x];
	}

	@vertex fn vs(
		vert: Vertex,
		@builtin(instance_index) instanceIndex: u32
	) -> VSOutput {
		let wrapOffset = WRAP_OFFSETS[instanceIndex];
		let worldPos = vert.position + chunkOffset.xyz + vec3f(wrapOffset.x, 0.0, wrapOffset.y);
		var out: VSOutput;
		out.position = uni.lightMatrix * vec4f(worldPos, 1.0);
		out.worldPos = worldPos;
		return out;
	}

	@fragment fn fs(in: VSOutput) {
		let fogRange = max(uni.fogEnd - uni.fogStart, 0.001);
		let fogAlpha = smoothstep(
			0.0,
			1.0,
			clamp((uni.fogEnd - length(in.worldPos - uni.eyePosition)) / fogRange, 0.0, 1.0),
		);
		let casterAlpha = clamp(chunkOffset.w, 0.0, 1.0) * fogAlpha;
		if (casterAlpha < ditherThreshold(in.worldPos)) {
			discard;
		}
	}
`;
}

export interface TerrainShadowResources {
	pipeline: GPURenderPipeline;
	bindGroup: GPUBindGroup;
	texture: GPUTexture;
	view: GPUTextureView;
	sampler: GPUSampler;
}

export function initTerrainShadows(
	device: GPUDevice,
	chunkOffsetBGL: GPUBindGroupLayout,
	uniformBuffer: GPUBuffer,
	worldWrapWidth: number,
): TerrainShadowResources {
	const texture = device.createTexture({
		label: 'terrain shadow map',
		size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
		format: 'depth32float',
		usage:
			GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
	});
	const view = texture.createView();
	const sampler = device.createSampler({
		compare: 'less-equal',
		magFilter: 'linear',
		minFilter: 'linear',
	});

	const module = device.createShaderModule({
		label: 'terrain shadow shader',
		code: buildTerrainShadowShader(worldWrapWidth),
	});

	const uniformBGL = device.createBindGroupLayout({
		label: 'terrain shadow uniforms',
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
				buffer: { type: 'uniform' },
			},
		],
	});

	const bindGroup = device.createBindGroup({
		label: 'terrain shadow bind group',
		layout: uniformBGL,
		entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
	});

	const pipelineLayout = device.createPipelineLayout({
		bindGroupLayouts: [uniformBGL, chunkOffsetBGL],
	});

	const pipeline = device.createRenderPipeline({
		label: 'terrain shadow pipeline',
		layout: pipelineLayout,
		vertex: {
			module,
			entryPoint: 'vs',
			buffers: [
				{
					arrayStride: 40,
					attributes: [
						{
							shaderLocation: 0,
							offset: 0,
							format: 'float32x3',
						},
					],
				},
			],
		},
		fragment: {
			module,
			entryPoint: 'fs',
			targets: [],
		},
		primitive: {
			cullMode: 'back',
		},
		depthStencil: {
			format: 'depth32float',
			depthWriteEnabled: true,
			depthCompare: 'less',
			depthBias: 2,
			depthBiasSlopeScale: 2,
		},
	});

	return { pipeline, bindGroup, texture, view, sampler };
}

export function computeLightViewProjection(
	center: Float32Array,
	halfExtent = SHADOW_HALF_EXTENT,
): Float32Array<ArrayBuffer> {
	const lightDir = vec3.create(
		SUN_DIRECTION[0],
		SUN_DIRECTION[1],
		SUN_DIRECTION[2],
	);
	const zAxis = lightDir;
	const xAxis = vec3.normalize(vec3.cross(vec3.create(0, 1, 0), zAxis));
	const yAxis = vec3.normalize(vec3.cross(zAxis, xAxis));
	const texelSize = (halfExtent * 2) / SHADOW_MAP_SIZE;

	const centerX =
		(center[0] ?? 0) * xAxis[0] +
		(center[1] ?? 0) * xAxis[1] +
		(center[2] ?? 0) * xAxis[2];
	const centerY =
		(center[0] ?? 0) * yAxis[0] +
		(center[1] ?? 0) * yAxis[1] +
		(center[2] ?? 0) * yAxis[2];
	const snappedX = Math.round(centerX / texelSize) * texelSize;
	const snappedY = Math.round(centerY / texelSize) * texelSize;

	const lightCenter = vec3.create(center[0], center[1], center[2]);
	vec3.addScaled(lightCenter, xAxis, snappedX - centerX, lightCenter);
	vec3.addScaled(lightCenter, yAxis, snappedY - centerY, lightCenter);
	const eye = vec3.addScaled(lightCenter, lightDir, SHADOW_DEPTH * 0.5);
	const view = mat4.lookAt(eye, lightCenter, vec3.create(0, 1, 0));
	const projection = mat4.ortho(
		-halfExtent,
		halfExtent,
		-halfExtent,
		halfExtent,
		0,
		SHADOW_DEPTH,
	);
	return mat4.multiply(projection, view);
}
