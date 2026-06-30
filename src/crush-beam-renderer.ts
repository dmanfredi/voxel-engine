/**
 * Crush beam render pipeline — the translucent red column that telegraphs a
 * Crush cube's incoming carve. Mirrors the void floor renderer: pooled
 * per-beam uniforms, premultiplied-alpha blend, procedural geometry (a box in
 * the shader — no vertex buffer).
 *
 * Two deliberate depth choices, both serving legibility over realism:
 * - `depthCompare: 'always'` so the column reads *through* the very blocks
 *   it's about to carve — seeing the marked lane is the whole point.
 * - Drawn after the skybox (see main.ts) so it composites over terrain and
 *   sky alike. No depth write, so it never occludes anything.
 *
 * The X-ray look means a wall between camera and beam won't hide it — standard
 * for an AoE telegraph. Switch `depthCompare` to `'less'` if a world-occluded
 * beam reads better in practice.
 */

import CrushBeamShader from './shader/crush-beam';

// a: vec4 (centerX, centerZ, halfWidth, topY) + b: vec4 (bottomY, …) + color: vec4
const CRUSH_BEAM_UNIFORM_SIZE = 48;
// Simultaneous telegraph columns drawn per frame. Extra beams simply skip
// their visual (rare — few cubes telegraph at once).
const MAX_CRUSH_BEAMS = 8;

interface BeamSlot {
	buffer: GPUBuffer;
	bindGroup: GPUBindGroup;
	f32: Float32Array<ArrayBuffer>;
}

export interface CrushBeamRenderer {
	pipeline: GPURenderPipeline;
	/** Shared with the main voxel pipeline — VP matrix lives in binding 0. */
	sharedBindGroup0: GPUBindGroup;
	slots: BeamSlot[];
}

/** One telegraph column to draw this frame, in world coords. */
export interface CrushBeam {
	centerX: number;
	centerZ: number;
	halfWidth: number;
	topY: number;
	bottomY: number;
	/** Straight (non-premultiplied) RGBA in 0..1; alpha is the fill opacity. */
	color: readonly [number, number, number, number];
}

export function initCrushBeamRenderer(
	device: GPUDevice,
	presentationFormat: GPUTextureFormat,
	mainGroup0BGL: GPUBindGroupLayout,
	sharedBindGroup0: GPUBindGroup,
): CrushBeamRenderer {
	const module = device.createShaderModule({
		label: 'crush beam shader',
		code: CrushBeamShader,
	});

	const group1Layout = device.createBindGroupLayout({
		label: 'crush beam group 1',
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
		label: 'crush beam pipeline',
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
		// No culling — keeps the procedural box robust regardless of winding;
		// the translucent double-blend reads fine as a glow.
		primitive: { topology: 'triangle-list', cullMode: 'none' },
		depthStencil: {
			depthWriteEnabled: false,
			depthCompare: 'less',
			format: 'depth24plus',
		},
	});

	const slots: BeamSlot[] = [];
	for (let i = 0; i < MAX_CRUSH_BEAMS; i++) {
		const buffer = device.createBuffer({
			label: `crush beam ${String(i)} uniform`,
			size: CRUSH_BEAM_UNIFORM_SIZE,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		const bindGroup = device.createBindGroup({
			label: `crush beam ${String(i)} bind group`,
			layout: group1Layout,
			entries: [{ binding: 0, resource: { buffer } }],
		});
		slots.push({
			buffer,
			bindGroup,
			f32: new Float32Array(CRUSH_BEAM_UNIFORM_SIZE / 4),
		});
	}

	return { pipeline, sharedBindGroup0, slots };
}

export function drawCrushBeams(
	pass: GPURenderPassEncoder,
	device: GPUDevice,
	renderer: CrushBeamRenderer,
	beams: readonly CrushBeam[],
): void {
	const count = Math.min(beams.length, renderer.slots.length);
	if (count === 0) return;

	pass.setPipeline(renderer.pipeline);
	pass.setBindGroup(0, renderer.sharedBindGroup0);
	for (let i = 0; i < count; i++) {
		const beam = beams[i];
		const slot = renderer.slots[i];
		if (!beam || !slot) continue;
		slot.f32[0] = beam.centerX;
		slot.f32[1] = beam.centerZ;
		slot.f32[2] = beam.halfWidth;
		slot.f32[3] = beam.topY;
		slot.f32[4] = beam.bottomY;
		slot.f32[8] = beam.color[0];
		slot.f32[9] = beam.color[1];
		slot.f32[10] = beam.color[2];
		slot.f32[11] = beam.color[3];
		device.queue.writeBuffer(slot.buffer, 0, slot.f32);
		pass.setBindGroup(1, slot.bindGroup);
		pass.draw(36);
	}
}
