import { mat4, vec3 } from 'wgpu-matrix';
import MainShader from './shader';
import { initSkybox, drawSkybox, type SkyboxResources } from './skybox';

import buildChunkBlocks from './block-builder';
import { greedyMesh } from './greedy-mesh';
import { World } from './world';
import { Chunk, chunkKey } from './chunk';

if (!navigator.gpu) {
	document.body.style.background = '#1a1a2e';
	throw new Error('WebGPU not supported on this browser.');
}

const BLOCK_SIZE = 10;
const CHUNKS = 5;
const TEXTURE_SIZE = 512;

const world = new World(BLOCK_SIZE);
for (let cy = 0; cy < CHUNKS; cy++) {
	for (let cz = 0; cz < CHUNKS; cz++) {
		for (let cx = 0; cx < CHUNKS; cx++) {
			world.addChunk(new Chunk(cx, cy, cz, buildChunkBlocks(cx, cy, cz)));
		}
	}
}

const degToRad = (d: number) => (d * Math.PI) / 180;
const up = vec3.create(0, 1, 0);

const worldCenter = (CHUNKS * 32 * BLOCK_SIZE) / 2;
const cameraPos = vec3.create(worldCenter, worldCenter, worldCenter);
const cameraFront = vec3.create(0, 0, -1);
const cameraUp = up;

let cameraYaw = -90;
let cameraPitch = -10;

interface ChunkRenderData {
	vertexBuffer: GPUBuffer;
	numVertices: number;
}

async function main(): Promise<void> {
	const canvas = document.querySelector<HTMLCanvasElement>('canvas');
	if (!canvas) {
		throw new Error('Canvas element not found.');
	}

	const context = canvas.getContext('webgpu');
	if (!context) {
		throw new Error('No WebGPU context found!');
	}

	const adapter = await navigator.gpu.requestAdapter();
	if (!adapter) {
		throw new Error('No appropriate GPUAdapter found.');
	}

	const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
	const device = await adapter.requestDevice();

	context.configure({
		device,
		format: presentationFormat,
		alphaMode: 'premultiplied',
	});

	const module = device.createShaderModule({
		code: MainShader,
	});

	const vertexBufferLayout: GPUVertexBufferLayout = {
		arrayStride: (3 + 3 + 2 + 1 + 1) * 4,
		attributes: [
			{ shaderLocation: 0, offset: 0, format: 'float32x3' },
			{ shaderLocation: 1, offset: 12, format: 'float32x3' },
			{ shaderLocation: 2, offset: 24, format: 'float32x2' },
			{ shaderLocation: 3, offset: 32, format: 'float32' },
			{ shaderLocation: 4, offset: 36, format: 'uint32' },
		],
	};

	const pipeline = device.createRenderPipeline({
		label: '3 attributes',
		layout: 'auto',
		vertex: {
			module,
			entryPoint: 'vs',
			buffers: [vertexBufferLayout],
		},
		fragment: {
			module,
			entryPoint: 'fs',
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

	// Load block texture (marble only)
	const blockTextureSources: { layer: number; src: string }[] = [
		{ layer: 0, src: 'assets/MarbleBase512.png' },
		{ layer: 1, src: 'assets/MarbleBase512.png' },
	];

	const numLayers = blockTextureSources.length;
	const blockTextureArray = device.createTexture({
		label: 'block texture array',
		size: [TEXTURE_SIZE, TEXTURE_SIZE, numLayers],
		format: 'rgba8unorm',
		usage:
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_DST |
			GPUTextureUsage.RENDER_ATTACHMENT,
	});

	await Promise.all(
		blockTextureSources.map(async ({ layer, src }) => {
			const response = await fetch(src);
			const bitmap = await createImageBitmap(await response.blob(), {
				resizeWidth: TEXTURE_SIZE,
				resizeHeight: TEXTURE_SIZE,
			});
			device.queue.copyExternalImageToTexture(
				{ source: bitmap },
				{ texture: blockTextureArray, origin: { z: layer } },
				[TEXTURE_SIZE, TEXTURE_SIZE],
			);
		}),
	);

	const sampler = device.createSampler({
		magFilter: 'linear',
		minFilter: 'linear',
		addressModeU: 'repeat',
		addressModeV: 'repeat',
	});

	const uniformBufferSize = 16 * 4;
	const uniformBuffer = device.createBuffer({
		label: 'uniforms',
		size: uniformBufferSize,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const uniformValues = new Float32Array(uniformBufferSize / 4);

	const blockTextureView = blockTextureArray.createView({
		dimension: '2d-array',
	});
	const bindGroup = device.createBindGroup({
		label: 'bind group for chunk',
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			{ binding: 1, resource: sampler },
			{ binding: 2, resource: blockTextureView },
		],
	});

	// Per-chunk GPU resources
	const chunkRenderMap = new Map<string, ChunkRenderData>();

	function meshChunk(cx: number, cy: number, cz: number): void {
		if (!world.getChunk(cx, cy, cz)) return;

		const key = chunkKey(cx, cy, cz);

		const old = chunkRenderMap.get(key);
		if (old) {
			old.vertexBuffer.destroy();
		}

		const { vertexData, numVertices } = greedyMesh(world, cx, cy, cz);

		if (numVertices === 0) {
			chunkRenderMap.delete(key);
			return;
		}

		const vertexBuffer = device.createBuffer({
			label: `chunk ${key} vertex buffer`,
			size: vertexData.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(vertexBuffer, 0, vertexData);

		chunkRenderMap.set(key, {
			vertexBuffer,
			numVertices,
		});
	}

	// Initial mesh for all chunks
	world.forEachChunk((chunk) => {
		meshChunk(chunk.cx, chunk.cy, chunk.cz);
	});

	// Initialize skybox
	const skybox: SkyboxResources = await initSkybox(
		device,
		presentationFormat,
	);

	let depthTexture: GPUTexture;

	function ensureDepthTexture(width: number, height: number) {
		if (
			!depthTexture ||
			depthTexture.width !== width ||
			depthTexture.height !== height
		) {
			depthTexture?.destroy();
			depthTexture = device.createTexture({
				size: [width, height],
				format: 'depth24plus',
				usage: GPUTextureUsage.RENDER_ATTACHMENT,
			});
		}
	}

	// ============================================
	// CAMERA CONTROL
	// ============================================

	const AUTO_ROTATE_SPEED = 7;
	const RESUME_DELAY = 1.5; // seconds before auto-rotate resumes
	const EASE_IN_DURATION = 3; // seconds to ease back to full speed
	const DRAG_SENSITIVITY = 0.3;

	let isDragging = false;
	let lastInteractionTime = -Infinity;
	let autoRotateSpeed = AUTO_ROTATE_SPEED;

	canvas.addEventListener('mousedown', (e) => {
		if (e.button === 0) isDragging = true;
	});
	window.addEventListener('mouseup', () => {
		isDragging = false;
	});
	canvas.addEventListener('mousemove', (e) => {
		if (!isDragging) return;
		cameraYaw += e.movementX * DRAG_SENSITIVITY;
		cameraPitch -= e.movementY * DRAG_SENSITIVITY;
		cameraPitch = Math.max(-85, Math.min(85, cameraPitch));
		lastInteractionTime = performance.now() / 1000;
		autoRotateSpeed = 0;
	});

	canvas.addEventListener(
		'touchstart',
		(e) => {
			isDragging = true;
			e.preventDefault();
		},
		{ passive: false },
	);
	canvas.addEventListener('touchend', () => {
		isDragging = false;
	});
	canvas.addEventListener(
		'touchmove',
		(e) => {
			if (!isDragging || !e.touches[0]) return;
			const touch = e.touches[0];
			if (lastTouchX !== null && lastTouchY !== null) {
				cameraYaw += (touch.clientX - lastTouchX) * DRAG_SENSITIVITY;
				cameraPitch -= (touch.clientY - lastTouchY) * DRAG_SENSITIVITY;
				cameraPitch = Math.max(-85, Math.min(85, cameraPitch));
				lastInteractionTime = performance.now() / 1000;
				autoRotateSpeed = 0;
			}
			lastTouchX = touch.clientX;
			lastTouchY = touch.clientY;
			e.preventDefault();
		},
		{ passive: false },
	);
	canvas.addEventListener('touchend', () => {
		lastTouchX = null;
		lastTouchY = null;
	});
	let lastTouchX: number | null = null;
	let lastTouchY: number | null = null;

	canvas.style.cursor = 'grab';
	canvas.addEventListener('mousedown', () => {
		canvas.style.cursor = 'grabbing';
	});
	window.addEventListener('mouseup', () => {
		canvas.style.cursor = 'grab';
	});

	// ============================================
	// RENDER LOOP
	// ============================================

	let renderRequestId: number;
	let lastT = 0;

	function requestRender() {
		if (!renderRequestId) {
			renderRequestId = requestAnimationFrame(() => {
				render();
			});
		}
	}

	function tick(t: number) {
		const dt = Math.min(0.1, (t - lastT) / 1000);
		lastT = t;

		const now = t / 1000;
		const timeSinceInteraction = now - lastInteractionTime;

		// Ease auto-rotate back in after delay
		if (timeSinceInteraction > RESUME_DELAY) {
			const easeProgress = Math.min(
				(timeSinceInteraction - RESUME_DELAY) / EASE_IN_DURATION,
				1,
			);
			autoRotateSpeed = AUTO_ROTATE_SPEED * easeProgress;
		}

		// Auto-rotate (speed is 0 while dragging, eases back up after)
		cameraYaw += dt * autoRotateSpeed;

		// Gently blend pitch back toward the oscillation target
		if (autoRotateSpeed > 0) {
			const targetPitch = -10 + Math.sin(t * 0.0003) * 5;
			const blendRate = (autoRotateSpeed / AUTO_ROTATE_SPEED) * 0.5 * dt;
			cameraPitch += (targetPitch - cameraPitch) * blendRate;
		}

		const direction = vec3.create(
			Math.cos(degToRad(cameraYaw)) * Math.cos(degToRad(cameraPitch)),
			Math.sin(degToRad(cameraPitch)),
			Math.sin(degToRad(cameraYaw)) * Math.cos(degToRad(cameraPitch)),
		);
		vec3.normalize(direction, cameraFront);

		requestRender();
		requestAnimationFrame(tick);
	}

	function render(): void {
		renderRequestId = 0;

		if (canvas === null) throw new Error('No canvas found!');
		const canvasTexture = context?.getCurrentTexture();
		if (!canvasTexture) throw new Error('No canvasTexture found!');

		ensureDepthTexture(canvasTexture.width, canvasTexture.height);

		const renderPassDescriptor: GPURenderPassDescriptor = {
			label: 'main pass',
			colorAttachments: [
				{
					view: canvasTexture.createView(),
					loadOp: 'clear',
					storeOp: 'store',
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
			depthStencilAttachment: {
				view: depthTexture.createView(),
				depthClearValue: 1.0,
				depthLoadOp: 'clear',
				depthStoreOp: 'store',
			},
		};

		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass(renderPassDescriptor);

		const aspect = canvas.clientWidth / canvas.clientHeight;
		const projection = mat4.perspective(degToRad(60), aspect, 1, 5000);

		const viewMatrix = mat4.lookAt(
			cameraPos,
			vec3.add(cameraPos, cameraFront),
			cameraUp,
		);
		const viewProjectionMatrix = mat4.multiply(projection, viewMatrix);

		uniformValues.set(viewProjectionMatrix);
		device.queue.writeBuffer(uniformBuffer, 0, uniformValues);

		// Draw all chunk meshes
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bindGroup);
		for (const chunkRender of chunkRenderMap.values()) {
			pass.setVertexBuffer(0, chunkRender.vertexBuffer);
			pass.draw(chunkRender.numVertices);
		}

		// Draw skybox
		drawSkybox(pass, device, skybox, viewMatrix, projection);

		pass.end();

		const commandBuffer = encoder.finish();
		device.queue.submit([commandBuffer]);
	}

	// ============================================
	// RESIZE OBSERVER & START
	// ============================================

	const observer = new ResizeObserver((entries) => {
		for (const entry of entries) {
			const canvas = entry.target as HTMLCanvasElement;
			const boxSize = entry.contentBoxSize[0];
			const width = boxSize
				? boxSize.inlineSize
				: entry.contentRect.width;
			const height = boxSize
				? boxSize.blockSize
				: entry.contentRect.height;
			canvas.width = Math.max(
				1,
				Math.min(width, device.limits.maxTextureDimension2D),
			);
			canvas.height = Math.max(
				1,
				Math.min(height, device.limits.maxTextureDimension2D),
			);
			render();
		}
	});
	observer.observe(canvas);

	// Start animation loop
	requestAnimationFrame((t) => {
		lastT = t;
		tick(t);
	});
}
await main();
