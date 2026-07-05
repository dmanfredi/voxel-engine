/**
 * Projectile render pipeline — dedicated shader, pipeline, and draw logic
 * for projectile visuals. Parallel to entity-renderer.ts but independent.
 *
 * Why standalone (not folded into entity renderer):
 * - No texture sampling. Projectile color is hardcoded in the shader;
 *   a uniform-color future is one extra field in InstanceUniforms.
 * - No material LUT lookup, no specular, no fog. Projectiles are small
 *   short-lived markers — simpler shading reads cleaner and renders faster.
 * - No coupling to the block texture array (which exists to serve voxels,
 *   not arbitrary other geometry).
 *
 * Vertex layout intentionally matches the entity renderer's (pos+normal+uv)
 * so any cube/sphere mesh produced by the existing generators can be fed
 * in unchanged. The shader simply doesn't declare the UV attribute since
 * there's no texture to sample — the GPU strides over those bytes per
 * vertex without reading them.
 */

import { createBeveledCube } from './cube';

const PROJECTILE_UNIFORM_SIZE = 64; // mat4x4f only

const projectileShader = /*wgsl*/ `
	struct Uniforms {
		matrix: mat4x4f,
		eyePosition: vec3f,
		shininess: f32,
		specularStrength: f32,
		fogStart: f32,
		fogEnd: f32,
	}

	struct InstanceUniforms {
		model: mat4x4f,
	}

	struct Vertex {
		@location(0) position: vec3f,
		@location(1) normal: vec3f,
	}

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) normal: vec3f,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(1) @binding(0) var<uniform> inst: InstanceUniforms;

	// CSS "skyblue" (135, 206, 235). Hardcoded; promote to an
	// instance uniform when projectiles need per-tool colors.
	const COLOR = vec3f(0.529, 0.808, 0.922);
	const LIGHT_DIR = vec3f(-0.387, 0.730, 0.563);
	const AMBIENT = 0.5;

	@vertex fn vs(vert: Vertex) -> VSOutput {
		var out: VSOutput;
		let worldPos = (inst.model * vec4f(vert.position, 1.0)).xyz;
		out.position = uni.matrix * vec4f(worldPos, 1.0);
		// Non-uniform scale skews diagonal (bevel) normals; axis-aligned
		// faces stay correct after normalize. Proper normal matrix deferred
		// — the bevel mislighting is cosmetic.
		out.normal = normalize((inst.model * vec4f(vert.normal, 0.0)).xyz);
		return out;
	}

	@fragment fn fs(inp: VSOutput) -> @location(0) vec4f {
		let n = normalize(inp.normal);
		let diffuse = max(dot(n, LIGHT_DIR), 0.0);
		let brightness = AMBIENT + (1.0 - AMBIENT) * diffuse;
		return vec4f(COLOR * brightness, 1.0);
	}
`;

export interface ProjectileRenderer {
	pipeline: GPURenderPipeline;
	/** Shared with the main voxel pipeline — VP matrix lives in binding 0. */
	sharedBindGroup0: GPUBindGroup;
	group1Layout: GPUBindGroupLayout;
	/**
	 * Single hardcoded cube mesh shared by all projectiles. When
	 * per-profile meshes land, this gets keyed by profile/shape and the
	 * renderer picks the mesh at spawn time.
	 */
	cubeVertices: Float32Array<ArrayBuffer>;
	cubeVertexCount: number;
}

export interface ProjectileRenderData {
	uniformBuffer: GPUBuffer;
	uniformF32: Float32Array<ArrayBuffer>;
	bindGroup: GPUBindGroup;
	vertexBuffer: GPUBuffer;
	vertexCount: number;
}

export function initProjectileRenderer(
	device: GPUDevice,
	presentationFormat: GPUTextureFormat,
	mainGroup0BGL: GPUBindGroupLayout,
	sharedBindGroup0: GPUBindGroup,
): ProjectileRenderer {
	const module = device.createShaderModule({ code: projectileShader });

	const group1Layout = device.createBindGroupLayout({
		label: 'projectile group 1',
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.VERTEX,
				buffer: { type: 'uniform' },
			},
		],
	});

	// Reuse mainGroup0BGL: the shader only reads binding 0 (the uniform).
	// Samplers/textures present in the bind group are ignored — saves us
	// from creating a parallel bind group just for projectiles.
	const pipelineLayout = device.createPipelineLayout({
		bindGroupLayouts: [mainGroup0BGL, group1Layout],
	});

	const pipeline = device.createRenderPipeline({
		label: 'projectile pipeline',
		layout: pipelineLayout,
		vertex: {
			module,
			entryPoint: 'vs',
			buffers: [
				{
					// Stride matches entity meshes: pos(3) + normal(3) + uv(2)
					// = 32 bytes. We only declare pos and normal attributes —
					// the trailing UV bytes are strided over but never read.
					arrayStride: 32,
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

	const mesh = createBeveledCube();

	return {
		pipeline,
		sharedBindGroup0,
		group1Layout,
		cubeVertices: mesh.vertices,
		cubeVertexCount: mesh.vertexCount,
	};
}

export function createProjectileRenderData(
	device: GPUDevice,
	renderer: ProjectileRenderer,
): ProjectileRenderData {
	const vertexBuffer = device.createBuffer({
		label: 'projectile vertex buffer',
		size: renderer.cubeVertices.byteLength,
		usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(vertexBuffer, 0, renderer.cubeVertices);

	const uniformF32 = new Float32Array(PROJECTILE_UNIFORM_SIZE / 4);

	const uniformBuffer = device.createBuffer({
		label: 'projectile uniform buffer',
		size: PROJECTILE_UNIFORM_SIZE,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});

	const bindGroup = device.createBindGroup({
		label: 'projectile bind group 1',
		layout: renderer.group1Layout,
		entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
	});

	return {
		uniformBuffer,
		uniformF32,
		bindGroup,
		vertexBuffer,
		vertexCount: renderer.cubeVertexCount,
	};
}

export function updateProjectileTransform(
	queue: GPUQueue,
	data: ProjectileRenderData,
	modelMatrix: Float32Array<ArrayBuffer>,
): void {
	data.uniformF32.set(modelMatrix, 0);
	queue.writeBuffer(data.uniformBuffer, 0, data.uniformF32);
}

export function drawProjectiles(
	pass: GPURenderPassEncoder,
	renderer: ProjectileRenderer,
	projectiles: ProjectileRenderData[],
): void {
	if (projectiles.length === 0) return;
	pass.setPipeline(renderer.pipeline);
	pass.setBindGroup(0, renderer.sharedBindGroup0);
	for (const p of projectiles) {
		pass.setBindGroup(1, p.bindGroup);
		pass.setVertexBuffer(0, p.vertexBuffer);
		pass.draw(p.vertexCount);
	}
}

export function destroyProjectileRenderData(data: ProjectileRenderData): void {
	data.vertexBuffer.destroy();
	data.uniformBuffer.destroy();
}
