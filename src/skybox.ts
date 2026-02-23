import { mat4, type Mat4 } from 'wgpu-matrix';

export interface SkyboxResources {
	pipeline: GPURenderPipeline;
	bindGroup: GPUBindGroup;
	uniformBuffer: GPUBuffer;
	uniformValues: Float32Array<ArrayBuffer>;
	texture: GPUTexture;
	sampler: GPUSampler;
}

interface TextureOptions {
	mips?: boolean;
	flipY?: boolean;
}

const SKYBOX_SHADER = /* wgsl */ `
	struct Uniforms {
		viewDirectionProjectionInverse: mat4x4f,
	};

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) pos: vec4f,
	};

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(0) @binding(1) var ourSampler: sampler;
	@group(0) @binding(2) var ourTexture: texture_cube<f32>;

	@vertex fn vs(@builtin(vertex_index) vNdx: u32) -> VSOutput {
		let pos = array(
			vec2f(-1, 3),
			vec2f(-1,-1),
			vec2f( 3,-1),
		);
		var vsOut: VSOutput;
		vsOut.position = vec4f(pos[vNdx], 1, 1);
		vsOut.pos = vsOut.position;
		return vsOut;
	}

	@fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
		let t = uni.viewDirectionProjectionInverse * vsOut.pos;
		return textureSample(ourTexture, ourSampler, normalize(t.xyz / t.w) * vec3f(1, 1, -1));
	}
`;

// Mip generation utilities
const numMipLevels = (...sizes: number[]) => {
	const maxSize = Math.max(...sizes);
	return (1 + Math.log2(maxSize)) | 0;
};

const generateMips = (() => {
	let sampler: GPUSampler;
	let module: GPUShaderModule;
	const pipelineByFormat: Partial<
		Record<GPUTextureFormat, GPURenderPipeline>
	> = {};

	return function generateMips(device: GPUDevice, texture: GPUTexture) {
		if (!module) {
			module = device.createShaderModule({
				label: 'textured quad shaders for mip level generation',
				code: /* wgsl */ `
					struct VSOutput {
						@builtin(position) position: vec4f,
						@location(0) texcoord: vec2f,
					};

					@vertex fn vs(@builtin(vertex_index) vertexIndex : u32) -> VSOutput {
						let pos = array(
							vec2f( 0.0,  0.0),
							vec2f( 1.0,  0.0),
							vec2f( 0.0,  1.0),
							vec2f( 0.0,  1.0),
							vec2f( 1.0,  0.0),
							vec2f( 1.0,  1.0),
						);

						var vsOutput: VSOutput;
						let xy = pos[vertexIndex];
						vsOutput.position = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
						vsOutput.texcoord = vec2f(xy.x, 1.0 - xy.y);
						return vsOutput;
					}

					@group(0) @binding(0) var ourSampler: sampler;
					@group(0) @binding(1) var ourTexture: texture_2d<f32>;

					@fragment fn fs(fsInput: VSOutput) -> @location(0) vec4f {
						return textureSample(ourTexture, ourSampler, fsInput.texcoord);
					}
				`,
			});

			sampler = device.createSampler({
				minFilter: 'linear',
				magFilter: 'linear',
			});
		}

		pipelineByFormat[texture.format] ??= device.createRenderPipeline({
			label: 'mip level generator pipeline',
			layout: 'auto',
			vertex: { module },
			fragment: {
				module,
				targets: [{ format: texture.format }],
			},
		});
		const pipeline = pipelineByFormat[texture.format];

		if (!pipeline) {
			throw new Error('Pipeline undefined');
		}

		const encoder = device.createCommandEncoder({
			label: 'mip gen encoder',
		});

		for (
			let baseMipLevel = 1;
			baseMipLevel < texture.mipLevelCount;
			++baseMipLevel
		) {
			for (let layer = 0; layer < texture.depthOrArrayLayers; ++layer) {
				const bindGroup = device.createBindGroup({
					layout: pipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: sampler },
						{
							binding: 1,
							resource: texture.createView({
								dimension: '2d',
								baseMipLevel: baseMipLevel - 1,
								mipLevelCount: 1,
								baseArrayLayer: layer,
								arrayLayerCount: 1,
							}),
						},
					],
				});

				const renderPassDescriptor: GPURenderPassDescriptor = {
					label: 'mip gen pass',
					colorAttachments: [
						{
							view: texture.createView({
								dimension: '2d',
								baseMipLevel: baseMipLevel,
								mipLevelCount: 1,
								baseArrayLayer: layer,
								arrayLayerCount: 1,
							}),
							loadOp: 'clear',
							storeOp: 'store',
						},
					],
				};

				const pass = encoder.beginRenderPass(renderPassDescriptor);
				pass.setPipeline(pipeline);
				pass.setBindGroup(0, bindGroup);
				pass.draw(6);
				pass.end();
			}
		}
		device.queue.submit([encoder.finish()]);
	};
})();

async function loadImageBitmap(url: string): Promise<ImageBitmap> {
	const res = await fetch(url);
	const blob = await res.blob();
	return await createImageBitmap(blob, { colorSpaceConversion: 'none' });
}

async function loadCubemapTexture(
	device: GPUDevice,
	urls: string[],
	options: TextureOptions = {},
): Promise<GPUTexture> {
	const images = await Promise.all(urls.map(loadImageBitmap));
	const source = images[0];
	if (!source) {
		throw new Error('No images loaded');
	}

	const texture = device.createTexture({
		format: 'rgba8unorm',
		mipLevelCount: options.mips
			? numMipLevels(source.width, source.height)
			: 1,
		size: [source.width, source.height, 6],
		usage:
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_DST |
			GPUTextureUsage.RENDER_ATTACHMENT,
	});

	images.forEach((image, layer) => {
		device.queue.copyExternalImageToTexture(
			{ source: image, flipY: options.flipY ?? false },
			{ texture, origin: [0, 0, layer] },
			{ width: image.width, height: image.height },
		);
	});

	if (texture.mipLevelCount > 1) {
		generateMips(device, texture);
	}

	return texture;
}

export async function initSkybox(
	device: GPUDevice,
	presentationFormat: GPUTextureFormat,
): Promise<SkyboxResources> {
	const module = device.createShaderModule({
		label: 'skybox shader',
		code: SKYBOX_SHADER,
	});

	const pipeline = device.createRenderPipeline({
		label: 'skybox pipeline',
		layout: 'auto',
		vertex: { module },
		fragment: {
			module,
			targets: [{ format: presentationFormat }],
		},
		depthStencil: {
			depthWriteEnabled: false,
			depthCompare: 'less-equal',
			format: 'depth24plus',
		},
	});

	const texture = await loadCubemapTexture(
		device,
		[
			'assets/skybox-sunny/px.png',
			'assets/skybox-sunny/nx.png',
			'assets/skybox-sunny/py.png',
			'assets/skybox-sunny/ny.png',
			'assets/skybox-sunny/pz.png',
			'assets/skybox-sunny/nz.png',
		],
		{ mips: true },
	);

	const sampler = device.createSampler({
		magFilter: 'linear',
		minFilter: 'linear',
		mipmapFilter: 'linear',
	});

	const uniformBufferSize = 16 * 4; // mat4x4
	const uniformBuffer = device.createBuffer({
		label: 'skybox uniforms',
		size: uniformBufferSize,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const uniformValues = new Float32Array(16);

	const bindGroup = device.createBindGroup({
		label: 'skybox bind group',
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			{ binding: 1, resource: sampler },
			{ binding: 2, resource: texture.createView({ dimension: 'cube' }) },
		],
	});

	return {
		pipeline,
		bindGroup,
		uniformBuffer,
		uniformValues,
		texture,
		sampler,
	};
}

export function drawSkybox(
	pass: GPURenderPassEncoder,
	device: GPUDevice,
	resources: SkyboxResources,
	viewMatrix: Mat4,
	projectionMatrix: Mat4,
): void {
	// Create view matrix with translation removed (rotation only)
	const viewRotationOnly = mat4.clone(viewMatrix);
	// Zero out the translation components (column 3, rows 0-2)
	viewRotationOnly[12] = 0;
	viewRotationOnly[13] = 0;
	viewRotationOnly[14] = 0;

	// Compute viewDirectionProjectionInverse
	const viewDirectionProjection = mat4.multiply(
		projectionMatrix,
		viewRotationOnly,
	);
	const viewDirectionProjectionInverse = mat4.inverse(
		viewDirectionProjection,
	);

	// Upload to GPU
	resources.uniformValues.set(viewDirectionProjectionInverse);
	device.queue.writeBuffer(
		resources.uniformBuffer,
		0,
		resources.uniformValues,
	);

	// Draw the skybox
	pass.setPipeline(resources.pipeline);
	pass.setBindGroup(0, resources.bindGroup);
	pass.draw(3);
}
