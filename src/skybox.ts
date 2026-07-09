import { mat4, type Mat4 } from 'wgpu-matrix';
import { generateMips, numMipLevels } from './mipmap';
import { buildTonemapWGSL } from './shader/shared';
import skyPx from '../assets/skybox-sunny/px.png';
import skyNx from '../assets/skybox-sunny/nx.png';
import skyPy from '../assets/skybox-sunny/py.png';
import skyNy from '../assets/skybox-sunny/ny.png';
import skyPz from '../assets/skybox-sunny/pz.png';
import skyNz from '../assets/skybox-sunny/nz.png';

export interface SkyboxResources {
	pipelines: Record<number, GPURenderPipeline>;
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
	${buildTonemapWGSL()}

	struct Uniforms {
		viewDirectionProjectionInverse: mat4x4f,
		tonemapMode: f32,
		exposure: f32,
		skyIntensity: f32,
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
		let sky = textureSample(ourTexture, ourSampler, normalize(t.xyz / t.w) * vec3f(1, 1, -1));
		// The cubemap is LDR-authored art; skyIntensity re-scales it as linear
		// emission so it survives exposure + tonemap at a tunable brightness.
		// Must match the skyIntensity applied to fog/specular sky reads.
		let mapped = applyTonemap(sky.rgb * uni.skyIntensity * uni.exposure, uni.tonemapMode);
		return vec4f(mapped, 1.0);
	}
`;

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
		// Native -srgb: PNG bytes are sRGB-encoded, so sampling decodes to
		// linear and mip generation averages in linear light.
		format: 'rgba8unorm-srgb',
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
	targetFormat: GPUTextureFormat,
): Promise<SkyboxResources> {
	const module = device.createShaderModule({
		label: 'skybox shader',
		code: SKYBOX_SHADER,
	});

	const bindGroupLayout = device.createBindGroupLayout({
		label: 'skybox bind group layout',
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.FRAGMENT,
				buffer: { type: 'uniform' },
			},
			{
				binding: 1,
				visibility: GPUShaderStage.FRAGMENT,
				sampler: { type: 'filtering' },
			},
			{
				binding: 2,
				visibility: GPUShaderStage.FRAGMENT,
				texture: { sampleType: 'float', viewDimension: 'cube' },
			},
		],
	});
	const pipelineLayout = device.createPipelineLayout({
		bindGroupLayouts: [bindGroupLayout],
	});

	function createSkyboxPipeline(sampleCount: number): GPURenderPipeline {
		return device.createRenderPipeline({
			label: `skybox pipeline ${String(sampleCount)}x`,
			layout: pipelineLayout,
			vertex: { module },
			fragment: {
				module,
				targets: [{ format: targetFormat }],
			},
			depthStencil: {
				depthWriteEnabled: false,
				depthCompare: 'less-equal',
				format: 'depth24plus',
			},
			multisample: { count: sampleCount },
		});
	}

	const texture = await loadCubemapTexture(
		device,
		[skyPx, skyNx, skyPy, skyNy, skyPz, skyNz],
		{ mips: true },
	);

	const sampler = device.createSampler({
		magFilter: 'linear',
		minFilter: 'linear',
		mipmapFilter: 'linear',
	});

	// mat4x4 (64) + tonemapMode/exposure/skyIntensity + pad (16) = 80 bytes
	const uniformBufferSize = 80;
	const uniformBuffer = device.createBuffer({
		label: 'skybox uniforms',
		size: uniformBufferSize,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const uniformValues = new Float32Array(uniformBufferSize / 4);

	// Decode on sample, re-encode on write — identity for the sky itself,
	// but the MSAA resolve and any blending against it happen in linear.
	const bindGroup = device.createBindGroup({
		label: 'skybox bind group',
		layout: bindGroupLayout,
		entries: [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			{ binding: 1, resource: sampler },
			{ binding: 2, resource: texture.createView({ dimension: 'cube' }) },
		],
	});

	return {
		pipelines: {
			1: createSkyboxPipeline(1),
			4: createSkyboxPipeline(4),
		},
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
	sampleCount: number,
	tonemapMode: number,
	exposure: number,
	skyIntensity: number,
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
	resources.uniformValues[16] = tonemapMode;
	resources.uniformValues[17] = exposure;
	resources.uniformValues[18] = skyIntensity;
	device.queue.writeBuffer(
		resources.uniformBuffer,
		0,
		resources.uniformValues,
	);

	// Draw the skybox
	pass.setPipeline(resources.pipelines[sampleCount]);
	pass.setBindGroup(0, resources.bindGroup);
	pass.draw(3);
}
