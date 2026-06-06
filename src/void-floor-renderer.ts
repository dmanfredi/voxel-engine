/**
 * Void floor render pipeline — placeholder visuals for the void hazard.
 *
 * Currently draws flat translucent horizontal quads, one per band boundary
 * (the surface + the lethal/delete line), so the rising void and its layers
 * are visible while tuning rise/clamp. These are debug fills, not the final
 * look — the real fuzzy black-chasm void shader swaps in at the fragment stage
 * later, keeping this pass slot and the per-plane uniform.
 *
 * Drawn AFTER the skybox with a depth test but no depth write: terrain (which
 * wrote depth in the main pass) occludes the planes, while the sky shows
 * through where the player looks down past terrain edges. That is what makes
 * the void sit "over the sky, beneath the blocks."
 *
 * Geometry is procedural (6 vertices from `vertex_index`) — no vertex buffer.
 * Each plane is a large quad centered on the player's X/Z; world wrap is
 * ignored because a huge flat fill reads identically across the seam.
 */

// Per-plane uniform: vec4f params (centerX, planeY, centerZ, halfExtent) + vec4f color.
const VOID_PLANE_UNIFORM_SIZE = 32;
// Pool size — bands rendered per frame. Grow if more boundaries get drawn.
const MAX_VOID_PLANES = 4;

const voidFloorShader = /*wgsl*/ `
	struct Uniforms {
		matrix: mat4x4f,
		eyePosition: vec3f,
		shininess: f32,
		specularStrength: f32,
		fogStart: f32,
		fogEnd: f32,
	}

	struct Plane {
		// x=centerX, y=planeY, z=centerZ, w=halfExtent
		params: vec4f,
		color: vec4f,
	}

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) color: vec4f,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(1) @binding(0) var<uniform> plane: Plane;

	@vertex fn vs(@builtin(vertex_index) v: u32) -> VSOutput {
		let corners = array<vec2f, 6>(
			vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
			vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
		);
		let off = corners[v] * plane.params.w;
		let world = vec3f(
			plane.params.x + off.x,
			plane.params.y,
			plane.params.z + off.y,
		);
		var out: VSOutput;
		out.position = uni.matrix * vec4f(world, 1.0);
		out.color = plane.color;
		return out;
	}

	@fragment fn fs(inp: VSOutput) -> @location(0) vec4f {
		// Premultiplied output to match the one / one-minus-src-alpha blend.
		let a = inp.color.a;
		return vec4f(inp.color.rgb * a, a);
	}
`;

interface VoidPlaneSlot {
	buffer: GPUBuffer;
	bindGroup: GPUBindGroup;
	f32: Float32Array<ArrayBuffer>;
}

export interface VoidFloorRenderer {
	pipeline: GPURenderPipeline;
	/** Shared with the main voxel pipeline — VP matrix lives in binding 0. */
	sharedBindGroup0: GPUBindGroup;
	slots: VoidPlaneSlot[];
}

export interface VoidPlane {
	/** World-Y of the plane. */
	y: number;
	/** Straight (non-premultiplied) RGBA in 0..1; alpha is the fill opacity. */
	color: readonly [number, number, number, number];
}

export function initVoidFloorRenderer(
	device: GPUDevice,
	presentationFormat: GPUTextureFormat,
	mainGroup0BGL: GPUBindGroupLayout,
	sharedBindGroup0: GPUBindGroup,
): VoidFloorRenderer {
	const module = device.createShaderModule({
		label: 'void floor shader',
		code: voidFloorShader,
	});

	const group1Layout = device.createBindGroupLayout({
		label: 'void floor group 1',
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
				buffer: { type: 'uniform' },
			},
		],
	});

	// Reuse mainGroup0BGL: the shader only reads binding 0 (the VP uniform).
	const pipelineLayout = device.createPipelineLayout({
		bindGroupLayouts: [mainGroup0BGL, group1Layout],
	});

	const pipeline = device.createRenderPipeline({
		label: 'void floor pipeline',
		layout: pipelineLayout,
		vertex: { module, entryPoint: 'vs' },
		fragment: {
			module,
			entryPoint: 'fs',
			targets: [
				{
					format: presentationFormat,
					blend: {
						color: {
							srcFactor: 'one',
							dstFactor: 'one-minus-src-alpha',
						},
						alpha: {
							srcFactor: 'one',
							dstFactor: 'one-minus-src-alpha',
						},
					},
				},
			],
		},
		// Horizontal quads viewed from above or below — no culling.
		primitive: { topology: 'triangle-list', cullMode: 'none' },
		// Depth test so terrain occludes; no write so planes don't block
		// each other or anything drawn afterward.
		depthStencil: {
			depthWriteEnabled: false,
			depthCompare: 'less',
			format: 'depth24plus',
		},
	});

	const slots: VoidPlaneSlot[] = [];
	for (let i = 0; i < MAX_VOID_PLANES; i++) {
		const buffer = device.createBuffer({
			label: `void plane ${String(i)} uniform`,
			size: VOID_PLANE_UNIFORM_SIZE,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		const bindGroup = device.createBindGroup({
			label: `void plane ${String(i)} bind group`,
			layout: group1Layout,
			entries: [{ binding: 0, resource: { buffer } }],
		});
		slots.push({
			buffer,
			bindGroup,
			f32: new Float32Array(VOID_PLANE_UNIFORM_SIZE / 4),
		});
	}

	return { pipeline, sharedBindGroup0, slots };
}

/**
 * Draw the void planes, each centered on (centerX, centerZ) and spanning
 * `halfExtent` world units. Planes should be passed in ascending-Y order so
 * the higher (nearer-from-above) plane composites last.
 */
export function drawVoidFloor(
	pass: GPURenderPassEncoder,
	device: GPUDevice,
	renderer: VoidFloorRenderer,
	centerX: number,
	centerZ: number,
	halfExtent: number,
	planes: readonly VoidPlane[],
): void {
	const count = Math.min(planes.length, renderer.slots.length);
	if (count === 0) return;

	pass.setPipeline(renderer.pipeline);
	pass.setBindGroup(0, renderer.sharedBindGroup0);
	for (let i = 0; i < count; i++) {
		const plane = planes[i];
		const slot = renderer.slots[i];
		if (!plane || !slot) continue;
		slot.f32[0] = centerX;
		slot.f32[1] = plane.y;
		slot.f32[2] = centerZ;
		slot.f32[3] = halfExtent;
		slot.f32[4] = plane.color[0];
		slot.f32[5] = plane.color[1];
		slot.f32[6] = plane.color[2];
		slot.f32[7] = plane.color[3];
		device.queue.writeBuffer(slot.buffer, 0, slot.f32);
		pass.setBindGroup(1, slot.bindGroup);
		pass.draw(6);
	}
}
