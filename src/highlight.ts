import type { Mat4 } from 'wgpu-matrix';

export interface HighlightResources {
	pipeline: GPURenderPipeline;
	bindGroup: GPUBindGroup;
	uniformBuffer: GPUBuffer;
	uniformValues: Float32Array<ArrayBuffer>;
	vertexBuffer: GPUBuffer;
}

const HIGHLIGHT_SHADER = /* wgsl */ `
	struct Uniforms {
		viewProjection: mat4x4f,
		modelOffset: vec3f,
		blockSize: f32,
	};

	@group(0) @binding(0) var<uniform> uni: Uniforms;

	@vertex fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
		let worldPos = pos * uni.blockSize + uni.modelOffset;
		return uni.viewProjection * vec4f(worldPos, 1.0);
	}

	@fragment fn fs() -> @location(0) vec4f {
		return vec4f(0.54, 0.15, 0.15, 1.0);
	}
`;

export function initHighlight(
	device: GPUDevice,
	presentationFormat: GPUTextureFormat,
): HighlightResources {
	const module = device.createShaderModule({
		label: 'highlight shader',
		code: HIGHLIGHT_SHADER,
	});

	const pipeline = device.createRenderPipeline({
		label: 'block highlight pipeline',
		layout: 'auto',
		vertex: {
			module,
			buffers: [
				{
					arrayStride: 3 * 4,
					attributes: [
						{
							shaderLocation: 0,
							offset: 0,
							format: 'float32x3' as GPUVertexFormat,
						},
					],
				},
			],
		},
		fragment: {
			module,
			targets: [{ format: presentationFormat }],
		},
		primitive: {
			topology: 'line-list',
		},
		depthStencil: {
			depthWriteEnabled: false,
			depthCompare: 'always',
			format: 'depth24plus',
		},
	});

	// 12 edges of a unit cube, 2 vertices per edge = 24 vertices
	// prettier-ignore
	const cubeEdges = new Float32Array([
		// Bottom face
		0,0,0, 1,0,0,
		1,0,0, 1,0,1,
		1,0,1, 0,0,1,
		0,0,1, 0,0,0,
		// Top face
		0,1,0, 1,1,0,
		1,1,0, 1,1,1,
		1,1,1, 0,1,1,
		0,1,1, 0,1,0,
		// Vertical edges
		0,0,0, 0,1,0,
		1,0,0, 1,1,0,
		1,0,1, 1,1,1,
		0,0,1, 0,1,1,
	]);

	const vertexBuffer = device.createBuffer({
		label: 'highlight vertex buffer',
		size: cubeEdges.byteLength,
		usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(vertexBuffer, 0, cubeEdges);

	// Uniform: mat4x4f (64) + vec3f (12) + f32 (4) = 80 bytes
	const uniformBufferSize = 20 * 4;
	const uniformBuffer = device.createBuffer({
		label: 'highlight uniforms',
		size: uniformBufferSize,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const uniformValues = new Float32Array(20);

	const bindGroup = device.createBindGroup({
		label: 'highlight bind group',
		layout: pipeline.getBindGroupLayout(0),
		entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
	});

	return {
		pipeline,
		bindGroup,
		uniformBuffer,
		uniformValues,
		vertexBuffer,
	};
}

export function drawHighlight(
	pass: GPURenderPassEncoder,
	device: GPUDevice,
	resources: HighlightResources,
	viewProjectionMatrix: Mat4,
	blockX: number,
	blockY: number,
	blockZ: number,
	blockSize: number,
): void {
	// Small expansion to prevent z-fighting with block faces
	const epsilon = 0.02;

	resources.uniformValues.set(viewProjectionMatrix, 0);
	resources.uniformValues[16] = blockX * blockSize - epsilon;
	resources.uniformValues[17] = blockY * blockSize - epsilon;
	resources.uniformValues[18] = blockZ * blockSize - epsilon;
	resources.uniformValues[19] = blockSize + epsilon * 2;

	device.queue.writeBuffer(
		resources.uniformBuffer,
		0,
		resources.uniformValues,
	);

	pass.setPipeline(resources.pipeline);
	pass.setBindGroup(0, resources.bindGroup);
	pass.setVertexBuffer(0, resources.vertexBuffer);
	pass.draw(24);
}
