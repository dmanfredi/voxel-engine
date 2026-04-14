// Mipmap generation for 2D and 2D-array textures.
// Renders each mip level from the previous level with a linear-filtered blit.
// The source texture must be created with GPUTextureUsage.RENDER_ATTACHMENT.

export const numMipLevels = (...sizes: number[]): number => {
	const maxSize = Math.max(...sizes);
	return (1 + Math.log2(maxSize)) | 0;
};

export const generateMips = (() => {
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
