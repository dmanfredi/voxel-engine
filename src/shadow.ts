import { mat4, vec3 } from 'wgpu-matrix';
import { SUN_DIRECTION } from './lighting';
import { f32Literal, wgslVec3, SHARED_UNIFORMS_WGSL } from './shader/shared';
import { VOXEL_VERTEX_FLOATS } from './greedy-mesh';

export const SHADOW_MAP_SIZE = 2048;
const SHADOW_HALF_EXTENT = 1800;
const SHADOW_DEPTH = 10000;
const SHADOW_TEXEL_WORLD = (SHADOW_HALF_EXTENT * 2) / SHADOW_MAP_SIZE;

// Light-space basis. LIGHT_X/LIGHT_Y match the view basis mat4.lookAt derives
// (up to sign), so a symmetric window test in this basis is exact against the
// ortho frustum. SUN is kept raw (not normalized) because the eye offset in
// computeLightViewProjection scales by it.
const SUN = vec3.create(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]);
const LIGHT_X = vec3.normalize(vec3.cross(vec3.create(0, 1, 0), SUN));
const LIGHT_Y = vec3.normalize(vec3.cross(SUN, LIGHT_X));

/** Candidate wrap images of a chunk: the full 3x3 wrap lattice. */
export const MAX_SHADOW_WRAPS = 9;
const WRAP_PAIR_VEC4S = Math.ceil(MAX_SHADOW_WRAPS / 2);

/**
 * Float count of the per-chunk uniform: base offset vec4 followed by wrap
 * (x, z) pairs packed two per vec4. Must match ChunkShadowUniform in the
 * shadow WGSL; the voxel and wireframe shaders read only the leading vec4f.
 */
export const CHUNK_OFFSET_UNIFORM_FLOATS = 4 + WRAP_PAIR_VEC4S * 4;

/**
 * Light-space (LIGHT_X/LIGHT_Y) coordinates of the shadow window center,
 * raw and snapped to whole shadow texels so the map doesn't shimmer as the
 * camera moves.
 */
function lightWindowCenter(center: Float32Array): {
	x: number;
	y: number;
	snappedX: number;
	snappedY: number;
} {
	const x =
		(center[0] ?? 0) * LIGHT_X[0] +
		(center[1] ?? 0) * LIGHT_X[1] +
		(center[2] ?? 0) * LIGHT_X[2];
	const y =
		(center[0] ?? 0) * LIGHT_Y[0] +
		(center[1] ?? 0) * LIGHT_Y[1] +
		(center[2] ?? 0) * LIGHT_Y[2];
	return {
		x,
		y,
		snappedX: Math.round(x / SHADOW_TEXEL_WORLD) * SHADOW_TEXEL_WORLD,
		snappedY: Math.round(y / SHADOW_TEXEL_WORLD) * SHADOW_TEXEL_WORLD,
	};
}

const BAYER_8X8 = [
	0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52,
	11, 59, 7, 55, 40, 24, 36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49, 13, 61,
	34, 18, 46, 30, 33, 17, 45, 29, 10, 58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22,
	41, 25, 37, 21,
];

function buildTerrainShadowShader(): string {
	const lightDir = vec3.normalize(
		vec3.create(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]),
	);
	const lightX = vec3.normalize(vec3.cross(vec3.create(0, 1, 0), lightDir));
	const lightY = vec3.normalize(vec3.cross(lightDir, lightX));
	const ditherCellSize = (SHADOW_HALF_EXTENT * 2) / SHADOW_MAP_SIZE;
	const bayer8x8 = BAYER_8X8.map((n) => f32Literal((n + 0.5) / 64)).join(
		', ',
	);

	return /* wgsl */ `
	const SHADOW_DITHER_CELL_SIZE = ${f32Literal(ditherCellSize)};
	const LIGHT_DITHER_X = ${wgslVec3(lightX)};
	const LIGHT_DITHER_Y = ${wgslVec3(lightY)};

	${SHARED_UNIFORMS_WGSL}

	struct Vertex {
		@location(0) position: vec3f,
	}

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) worldPos: vec3f,
	}

	// offset.xyz = chunk base offset (nearest wrap image, shared with the main
	// pass), offset.w = caster fade alpha. wraps = wrap images selected on the
	// CPU, (x, z) pairs packed two per vec4f, picked by instance index.
	struct ChunkShadowUniform {
		offset: vec4f,
		wraps: array<vec4f, ${String(WRAP_PAIR_VEC4S)}>,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(1) @binding(0) var<uniform> chunk: ChunkShadowUniform;

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
		let wrapPair = chunk.wraps[instanceIndex >> 1u];
		let wrapOffset = select(wrapPair.xy, wrapPair.zw, (instanceIndex & 1u) == 1u);
		let worldPos = vert.position + chunk.offset.xyz + vec3f(wrapOffset.x, 0.0, wrapOffset.y);
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
		let casterAlpha = clamp(chunk.offset.w, 0.0, 1.0) * fogAlpha;
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
		code: buildTerrainShadowShader(),
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
					arrayStride: VOXEL_VERTEX_FLOATS * 4,
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
): Float32Array<ArrayBuffer> {
	const win = lightWindowCenter(center);
	const lightCenter = vec3.create(center[0], center[1], center[2]);
	vec3.addScaled(lightCenter, LIGHT_X, win.snappedX - win.x, lightCenter);
	vec3.addScaled(lightCenter, LIGHT_Y, win.snappedY - win.y, lightCenter);
	const eye = vec3.addScaled(lightCenter, SUN, SHADOW_DEPTH * 0.5);
	const view = mat4.lookAt(eye, lightCenter, vec3.create(0, 1, 0));
	const projection = mat4.ortho(
		-SHADOW_HALF_EXTENT,
		SHADOW_HALF_EXTENT,
		-SHADOW_HALF_EXTENT,
		SHADOW_HALF_EXTENT,
		0,
		SHADOW_DEPTH,
	);
	return mat4.multiply(projection, view);
}

export interface ShadowWrapSelector {
	/** Recompute the light window for this frame's camera (the same center passed to computeLightViewProjection). */
	update(center: Float32Array): void;
	/**
	 * Select the wrap images of a chunk (cube AABB centered at the given
	 * world point) that overlap the shadow ortho window, writing their (x, z)
	 * offsets into `out` starting at `outIndex`. Returns the count.
	 */
	select(
		centerX: number,
		centerY: number,
		centerZ: number,
		out: Float32Array,
		outIndex: number,
	): number;
}

/**
 * The shadow ortho footprint spans slightly more than one wrap period, so a
 * chunk can cast into the map through more than one wrap image — but rarely
 * all of the lattice. Testing each image's AABB against the window in light
 * space picks out just the images that can land texels. The test never culls
 * along the light ray (depth), so it is conservative: drawing exactly the
 * selected instances writes a map identical to drawing every image.
 */
export function createShadowWrapSelector(
	chunkExtent: number,
	worldWrapWidth: number,
): ShadowWrapSelector {
	const half = chunkExtent / 2;
	// Projection radius of a chunk's cube AABB onto each light axis.
	const boundX =
		SHADOW_HALF_EXTENT +
		half *
			(Math.abs(LIGHT_X[0]) +
				Math.abs(LIGHT_X[1]) +
				Math.abs(LIGHT_X[2]));
	const boundY =
		SHADOW_HALF_EXTENT +
		half *
			(Math.abs(LIGHT_Y[0]) +
				Math.abs(LIGHT_Y[1]) +
				Math.abs(LIGHT_Y[2]));

	// World offsets of the wrap lattice and their light-space projections.
	const wrapWorld: number[] = [];
	const wrapProjX: number[] = [];
	const wrapProjY: number[] = [];
	for (const wz of [-worldWrapWidth, 0, worldWrapWidth]) {
		for (const wx of [-worldWrapWidth, 0, worldWrapWidth]) {
			wrapWorld.push(wx, wz);
			wrapProjX.push(wx * LIGHT_X[0] + wz * LIGHT_X[2]);
			wrapProjY.push(wx * LIGHT_Y[0] + wz * LIGHT_Y[2]);
		}
	}

	let windowX = 0;
	let windowY = 0;

	return {
		update(center: Float32Array): void {
			const win = lightWindowCenter(center);
			windowX = win.snappedX;
			windowY = win.snappedY;
		},
		select(
			centerX: number,
			centerY: number,
			centerZ: number,
			out: Float32Array,
			outIndex: number,
		): number {
			const px =
				centerX * LIGHT_X[0] +
				centerY * LIGHT_X[1] +
				centerZ * LIGHT_X[2] -
				windowX;
			const py =
				centerX * LIGHT_Y[0] +
				centerY * LIGHT_Y[1] +
				centerZ * LIGHT_Y[2] -
				windowY;
			let count = 0;
			for (let i = 0; i < MAX_SHADOW_WRAPS; i++) {
				if (
					Math.abs(px + wrapProjX[i]) > boundX ||
					Math.abs(py + wrapProjY[i]) > boundY
				) {
					continue;
				}
				out[outIndex + count * 2] = wrapWorld[i * 2];
				out[outIndex + count * 2 + 1] = wrapWorld[i * 2 + 1];
				count++;
			}
			return count;
		},
	};
}
