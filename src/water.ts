import type { Mat4, Vec3 } from 'wgpu-matrix';

export interface WaterResources {
	pipeline: GPURenderPipeline;
	bindGroup: GPUBindGroup;
	uniformBuffer: GPUBuffer;
	uniformValues: Float32Array<ArrayBuffer>;
	vertexBuffer: GPUBuffer;
}

const WATER_SHADER = /* wgsl */ `
	struct Uniforms {
		viewProjection: mat4x4f,
		cameraPosition: vec3f,
	};

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) worldPos: vec3f,
	};

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(0) @binding(1) var waterSampler: sampler;
	@group(0) @binding(2) var skyTexture: texture_cube<f32>;

	@vertex fn vs(@location(0) pos: vec3f) -> VSOutput {
		var out: VSOutput;
		out.position = uni.viewProjection * vec4f(pos, 1.0);
		out.worldPos = pos;
		return out;
	}

	@fragment fn fs(in: VSOutput) -> @location(0) vec4f {
		let normal = vec3f(0.0, 1.0, 0.0);
		let eyeToSurface = normalize(in.worldPos - uni.cameraPosition);
		let direction = reflect(eyeToSurface, normal);

		// Fresnel: high base reflectivity (salt flat with thin water layer)
		let cosTheta = max(dot(normal, -eyeToSurface), 0.0);
		let fresnel = mix(0.4, 1.0, pow(1.0 - cosTheta, 3.0));

		let reflectionColor = textureSample(skyTexture, waterSampler, direction * vec3f(1, 1, -1));

		let waterTint = vec4f(0.7, 0.75, 0.8, 1.0);
		return mix(waterTint, reflectionColor, fresnel);
	}
`;

export function initWater(
	device: GPUDevice,
	presentationFormat: GPUTextureFormat,
	skyboxTexture: GPUTexture,
	skyboxSampler: GPUSampler,
	chunkExtentX: number,
	chunkExtentZ: number,
	blockSize: number,
): WaterResources {
	const module = device.createShaderModule({
		label: 'water shader',
		code: WATER_SHADER,
	});

	const pipeline = device.createRenderPipeline({
		label: 'water pipeline',
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
			cullMode: 'back',
		},
		depthStencil: {
			depthWriteEnabled: true,
			depthCompare: 'less',
			format: 'depth24plus',
		},
	});

	// Uniform buffer: mat4x4f (16 floats) + vec3f (3 floats) + 1 padding = 20 floats = 80 bytes
	const uniformBufferSize = 20 * 4;
	const uniformBuffer = device.createBuffer({
		label: 'water uniforms',
		size: uniformBufferSize,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const uniformValues = new Float32Array(20);

	const bindGroup = device.createBindGroup({
		label: 'water bind group',
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			{ binding: 1, resource: skyboxSampler },
			{
				binding: 2,
				resource: skyboxTexture.createView({ dimension: 'cube' }),
			},
		],
	});

	// Water quad covering the full chunk, sitting 1 unit above the top of the block layer
	const waterY = blockSize + 1;
	const maxX = chunkExtentX * blockSize;
	const maxZ = chunkExtentZ * blockSize;

	// Two triangles, CCW winding with normal pointing +Y
	// prettier-ignore
	const vertices = new Float32Array([
		0,    waterY, 0,
		0,    waterY, maxZ,
		maxX, waterY, 0,
		maxX, waterY, 0,
		0,    waterY, maxZ,
		maxX, waterY, maxZ,
	]);

	const vertexBuffer = device.createBuffer({
		label: 'water vertex buffer',
		size: vertices.byteLength,
		usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(vertexBuffer, 0, vertices);

	return {
		pipeline,
		bindGroup,
		uniformBuffer,
		uniformValues,
		vertexBuffer,
	};
}

export function drawWater(
	pass: GPURenderPassEncoder,
	device: GPUDevice,
	resources: WaterResources,
	viewProjectionMatrix: Mat4,
	cameraPos: Vec3,
): void {
	resources.uniformValues.set(viewProjectionMatrix, 0);
	resources.uniformValues[16] = cameraPos[0] ?? 0;
	resources.uniformValues[17] = cameraPos[1] ?? 0;
	resources.uniformValues[18] = cameraPos[2] ?? 0;

	device.queue.writeBuffer(
		resources.uniformBuffer,
		0,
		resources.uniformValues,
	);

	pass.setPipeline(resources.pipeline);
	pass.setBindGroup(0, resources.bindGroup);
	pass.setVertexBuffer(0, resources.vertexBuffer);
	pass.draw(6);
}
