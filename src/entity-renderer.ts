/**
 * Entity render pipeline — shader, GPU pipeline, and draw logic for
 * non-voxel entities (enemies, etc.).
 *
 * Reuses the main shader's group 0 bind group (VP matrix, textures, skybox).
 * Group 1 is per-entity: model matrix + texture layer.
 */

import { buildMaterialLUT } from './shader/shared';

const ENTITY_UNIFORM_SIZE = 80; // mat4x4f(64) + u32 texLayer(4) + f32 texScale(4) + padding(8) = 80

const entityShader = /*wgsl*/ `
	${buildMaterialLUT()}

	struct Uniforms {
		matrix: mat4x4f,
		eyePosition: vec3f,
		shininess: f32,
		specularStrength: f32,
		fogStart: f32,
		fogEnd: f32,
	}

	struct EntityUniforms {
		model: mat4x4f,
		texLayer: u32,
		texScale: f32,
	}

	struct Vertex {
		@location(0) position: vec3f,
		@location(1) normal: vec3f,
		@location(2) uv: vec2f,
	}

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) uv: vec2f,
		@location(1) normal: vec3f,
		@location(2) worldPos: vec3f,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(0) @binding(1) var mySampler: sampler;
	@group(0) @binding(2) var myTexture: texture_2d_array<f32>;
	@group(0) @binding(3) var skySampler: sampler;
	@group(0) @binding(4) var skyTexture: texture_cube<f32>;

	@group(1) @binding(0) var<uniform> entity: EntityUniforms;

	const LIGHT_DIR = vec3f(-0.387, 0.730, 0.563);

	@vertex fn vs(vert: Vertex) -> VSOutput {
		var out: VSOutput;
		let worldPos = (entity.model * vec4f(vert.position, 1.0)).xyz;
		out.position = uni.matrix * vec4f(worldPos, 1.0);
		// Uniform scale: normalize(mat3(model) * normal) is correct
		out.normal = normalize((entity.model * vec4f(vert.normal, 0.0)).xyz);
		out.uv = vert.uv * entity.texScale;
		out.worldPos = worldPos;
		return out;
	}

	@fragment fn fs(inp: VSOutput) -> @location(0) vec4f {
		let texColor = textureSample(myTexture, mySampler, inp.uv, entity.texLayer);

		// Smooth diffuse lighting (unlike voxel per-face step function)
		let n = normalize(inp.normal);
		let diffuse = max(dot(n, LIGHT_DIR), 0.0);
		let ambient = 0.5;
		let brightness = ambient + (1.0 - ambient) * diffuse;

		// Sky-tinted specular (matches voxel shader)
		let eyeToSurface = normalize(inp.worldPos - uni.eyePosition);
		let reflected = reflect(eyeToSurface, n);
		let skyColor = textureSample(skyTexture, skySampler, reflected * vec3f(1, 1, -1));

		// Per-material reflection params (LUT), additively boosted by global tweakpane values
		let matShin = MATERIAL_SHININESS[entity.texLayer];
		let matSpec = MATERIAL_SPEC_STRENGTH[entity.texLayer];
		let effShin = matShin + uni.shininess;
		let effSpec = matSpec + uni.specularStrength;

		let V = normalize(uni.eyePosition - inp.worldPos);
		let H = normalize(LIGHT_DIR + V);
		let spec = pow(max(dot(n, H), 0.0), effShin);
		let specular = effSpec * spec * skyColor.rgb;

		let final_color = texColor.rgb * brightness + specular;

		// Distance fog matching voxel shader
		let dist = length(inp.worldPos - uni.eyePosition);
		let fogFactor = clamp((uni.fogEnd - dist) / (uni.fogEnd - uni.fogStart), 0.0, 1.0);
		let fogColor = textureSample(skyTexture, skySampler, eyeToSurface * vec3f(1, 1, -1)).rgb;
		let fogged = mix(fogColor, final_color, fogFactor);

		return vec4f(fogged, texColor.a);
	}
`;

export interface EntityRenderer {
	pipeline: GPURenderPipeline;
	sharedBindGroup0: GPUBindGroup;
	group1Layout: GPUBindGroupLayout;
}

export interface EntityRenderData {
	uniformBuffer: GPUBuffer;
	uniformF32: Float32Array<ArrayBuffer>;
	uniformU32: Uint32Array<ArrayBuffer>;
	bindGroup: GPUBindGroup;
	vertexBuffer: GPUBuffer;
	vertexCount: number;
}

export function initEntityRenderer(
	device: GPUDevice,
	presentationFormat: GPUTextureFormat,
	mainGroup0BGL: GPUBindGroupLayout,
	sharedBindGroup0: GPUBindGroup,
): EntityRenderer {
	const module = device.createShaderModule({ code: entityShader });

	const group1Layout = device.createBindGroupLayout({
		label: 'entity group 1',
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
				buffer: { type: 'uniform' },
			},
		],
	});

	const pipelineLayout = device.createPipelineLayout({
		bindGroupLayouts: [mainGroup0BGL, group1Layout],
	});

	const pipeline = device.createRenderPipeline({
		label: 'entity pipeline',
		layout: pipelineLayout,
		vertex: {
			module,
			entryPoint: 'vs',
			buffers: [
				{
					arrayStride: 32, // pos(3) + normal(3) + uv(2) = 8 floats
					attributes: [
						{
							shaderLocation: 0,
							offset: 0,
							format: 'float32x3',
						},
						{
							shaderLocation: 1,
							offset: 12,
							format: 'float32x3',
						},
						{
							shaderLocation: 2,
							offset: 24,
							format: 'float32x2',
						},
					],
				},
			],
		},
		fragment: {
			module,
			entryPoint: 'fs',
			targets: [{ format: presentationFormat }],
		},
		primitive: { cullMode: 'back' },
		depthStencil: {
			depthWriteEnabled: true,
			depthCompare: 'less',
			format: 'depth24plus',
		},
	});

	return { pipeline, sharedBindGroup0, group1Layout };
}

export function createEntityRenderData(
	device: GPUDevice,
	renderer: EntityRenderer,
	vertices: Float32Array<ArrayBuffer>,
	vertexCount: number,
	texLayer: number,
	texScale: number,
): EntityRenderData {
	const vertexBuffer = device.createBuffer({
		label: 'entity vertex buffer',
		size: vertices.byteLength,
		usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(vertexBuffer, 0, vertices);

	const uniformF32 = new Float32Array(ENTITY_UNIFORM_SIZE / 4);
	const uniformU32 = new Uint32Array(uniformF32.buffer);
	uniformU32[16] = texLayer;
	uniformF32[17] = texScale;

	const uniformBuffer = device.createBuffer({
		label: 'entity uniform buffer',
		size: ENTITY_UNIFORM_SIZE,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});

	const bindGroup = device.createBindGroup({
		label: 'entity bind group 1',
		layout: renderer.group1Layout,
		entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
	});

	return {
		uniformBuffer,
		uniformF32,
		uniformU32,
		bindGroup,
		vertexBuffer,
		vertexCount,
	};
}

export function updateEntityTransform(
	queue: GPUQueue,
	data: EntityRenderData,
	modelMatrix: Float32Array<ArrayBuffer>,
): void {
	data.uniformF32.set(modelMatrix, 0);
	queue.writeBuffer(data.uniformBuffer, 0, data.uniformF32);
}

export function drawEntities(
	pass: GPURenderPassEncoder,
	renderer: EntityRenderer,
	entities: EntityRenderData[],
): void {
	if (entities.length === 0) return;
	pass.setPipeline(renderer.pipeline);
	pass.setBindGroup(0, renderer.sharedBindGroup0);
	for (const e of entities) {
		pass.setBindGroup(1, e.bindGroup);
		pass.setVertexBuffer(0, e.vertexBuffer);
		pass.draw(e.vertexCount);
	}
}

export function destroyEntityRenderData(data: EntityRenderData): void {
	data.vertexBuffer.destroy();
	data.uniformBuffer.destroy();
}
