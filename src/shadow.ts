import { mat4, vec3 } from 'wgpu-matrix';
import { SUN_DIRECTION } from './lighting';

export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_HALF_EXTENT = 1100;
const SHADOW_DEPTH = 3200;

const TERRAIN_SHADOW_SHADER = /* wgsl */ `
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
	}

	struct Vertex {
		@location(0) position: vec3f,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(1) @binding(0) var<uniform> chunkOffset: vec4f;

	@vertex fn vs(vert: Vertex) -> @builtin(position) vec4f {
		let worldPos = vert.position + chunkOffset.xyz;
		return uni.lightMatrix * vec4f(worldPos, 1.0);
	}
`;

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
		code: TERRAIN_SHADOW_SHADER,
	});

	const uniformBGL = device.createBindGroupLayout({
		label: 'terrain shadow uniforms',
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.VERTEX,
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
	const lightCenter = vec3.create(center[0], center[1], center[2]);
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
