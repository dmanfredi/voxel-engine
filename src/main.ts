import { mat4, vec3 } from 'wgpu-matrix';
import MainShader from './shader';
import WireframeShader from './wireframe';
import { initSkybox, drawSkybox, type SkyboxResources } from './skybox';
import { initWater, drawWater } from './water';

import { BuildDebug, debuggerParams, stats } from './debug';
import buildBlocks, {
	CHUNK_SIZE_X,
	CHUNK_SIZE_Y,
	CHUNK_SIZE_Z,
} from './block-builder';
import { greedyMesh } from './greedy-mesh';
import { FREECAM, physicsTick, createPlayerState } from './movement';
import { World } from './world';
import { AIR, MARBLE } from './block';
import { raycast, type RaycastHit } from './raycast';
import { initHighlight, drawHighlight } from './highlight';

// TODO
// - Skylights
// - Better lighting (?)
// - different blocks with different textures
// - chunks

if (!navigator.gpu) {
	alert('WebGPU not supported on this browser.');
	throw new Error('WebGPU not supported on this browser.');
}

const BLOCK_SIZE = 10;
const TEXTURE_SCALE = 6; // number of blocks per texture repeat
const world = new World(
	buildBlocks(),
	CHUNK_SIZE_X,
	CHUNK_SIZE_Y,
	CHUNK_SIZE_Z,
	BLOCK_SIZE,
);

// Generate optimized mesh using greedy meshing algorithm
let { vertexData: meshVertexData, numVertices: meshNumVertices } = greedyMesh(
	world,
	TEXTURE_SCALE,
);

const degToRad = (d: number) => (d * Math.PI) / 180;
const up = vec3.create(0, 1, 0);

const cameraPos = vec3.create(
	(CHUNK_SIZE_X / 2) * BLOCK_SIZE,
	BLOCK_SIZE * 3,
	(CHUNK_SIZE_Z / 2) * BLOCK_SIZE,
);
const cameraFront = vec3.create(0, 0, -1);
const cameraUp = up;

let cameraYaw = -90;
let cameraPitch = 0;
let currentHit: RaycastHit | null = null;
const MAX_REACH = 100; // 10 blocks

async function main(): Promise<void> {
	const canvas = document.querySelector<HTMLCanvasElement>('canvas');
	if (!canvas) {
		throw new Error('Canvas element not found.');
	}

	// Get a WebGPU context from the canvas and configure it
	const context = canvas.getContext('webgpu');
	if (!context) {
		throw new Error('No WebGPU context found!');
	}

	const adapter = await navigator.gpu.requestAdapter();
	if (!adapter) {
		alert('No appropriate GPUAdapter found.');
		throw new Error('No appropriate GPUAdapter found.');
	}

	// ============================================
	// GPU PIPELINES & RESOURCES
	// ============================================

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

	const wireframeModule = device.createShaderModule({
		code: WireframeShader,
	});

	const vertexBufferLayout: GPUVertexBufferLayout = {
		arrayStride: (3 + 3 + 2 + 1 + 1) * 4, // pos, normal, uv, ao, texLayer (4 bytes each)
		attributes: [
			{ shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
			{ shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
			{ shaderLocation: 2, offset: 24, format: 'float32x2' }, // uv
			{ shaderLocation: 3, offset: 32, format: 'float32' }, // ao
			{ shaderLocation: 4, offset: 36, format: 'uint32' }, // texLayer
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

	const barycentricCoordinatesBasedWireframePipeline =
		device.createRenderPipeline({
			label: 'barycentric coordinates based wireframe pipeline',
			layout: 'auto',
			vertex: {
				module: wireframeModule,
				entryPoint: 'vsIndexedU32BarycentricCoordinateBasedLines',
			},
			fragment: {
				module: wireframeModule,
				entryPoint: 'fsBarycentricCoordinateBasedLines',
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
			primitive: {
				topology: 'triangle-list',
			},
			depthStencil: {
				depthWriteEnabled: true,
				depthCompare: 'less-equal',
				format: 'depth24plus',
			},
		});

	// Load block textures into a texture array (one layer per block type)
	const TEXTURE_SIZE = 256;
	const blockTextureSources: { layer: number; src: string }[] = [
		{ layer: 0, src: '../assets/MarbleBase256.png' }, // AIR placeholder (never sampled)
		{ layer: 1, src: '../assets/MarbleBase256.png' }, // DIRT
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

	// nearest filtering for crisp textures.
	// repeat mode for tiling across greedy-meshed quads
	const sampler = device.createSampler({
		magFilter: 'nearest',
		minFilter: 'nearest',
		addressModeU: 'repeat',
		addressModeV: 'repeat',
	});

	// Single uniform buffer for the view-projection matrix
	const uniformBufferSize = 16 * 4; // mat4x4
	const uniformBuffer = device.createBuffer({
		label: 'uniforms',
		size: uniformBufferSize,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const uniformValues = new Float32Array(uniformBufferSize / 4);

	// Vertex buffer and wireframe bind group are recreated on remesh
	let vertexBuffer = device.createBuffer({
		label: 'greedy mesh vertex buffer',
		size: meshVertexData.byteLength,
		usage:
			GPUBufferUsage.VERTEX |
			GPUBufferUsage.STORAGE |
			GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(vertexBuffer, 0, meshVertexData);

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

	let wireframeBindGroup = device.createBindGroup({
		label: 'wireframe bindgroup',
		layout: barycentricCoordinatesBasedWireframePipeline.getBindGroupLayout(
			0,
		),
		entries: [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			{ binding: 1, resource: { buffer: vertexBuffer } },
		],
	});

	// Initialize skybox
	const skybox: SkyboxResources = await initSkybox(
		device,
		presentationFormat,
	);

	// Initialize block highlight outline
	const highlight = initHighlight(device, presentationFormat);

	// Initialize water plane (reuses skybox cubemap for reflection)
	const water = initWater(
		device,
		presentationFormat,
		skybox.texture,
		skybox.sampler,
		CHUNK_SIZE_X,
		CHUNK_SIZE_Z,
		BLOCK_SIZE,
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
	// GAME STATE & FUNCTIONS
	// ============================================

	let renderRequestId: number;
	let lastT = 0;
	const keysDown = new Set<string>();
	const playerState = createPlayerState();
	const playerHeight = BLOCK_SIZE * 2 * 0.9;
	const playerHalfWidth = BLOCK_SIZE / 4;

	/** Regenerate the greedy mesh from current world state and re-upload to GPU. */
	function remesh(): void {
		const result = greedyMesh(world, TEXTURE_SCALE);
		meshVertexData = result.vertexData;
		meshNumVertices = result.numVertices;

		vertexBuffer.destroy();
		vertexBuffer = device.createBuffer({
			label: 'greedy mesh vertex buffer',
			size: meshVertexData.byteLength,
			usage:
				GPUBufferUsage.VERTEX |
				GPUBufferUsage.STORAGE |
				GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(vertexBuffer, 0, meshVertexData);

		// Wireframe reads the vertex buffer as storage — must rebind
		wireframeBindGroup = device.createBindGroup({
			label: 'wireframe bindgroup',
			layout: barycentricCoordinatesBasedWireframePipeline.getBindGroupLayout(
				0,
			),
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: { buffer: vertexBuffer } },
			],
		});
	}

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

		if (debuggerParams.freecam) {
			FREECAM(keysDown, cameraPos, cameraFront, cameraUp, dt * 500);
		} else {
			physicsTick(
				playerState,
				keysDown,
				cameraFront,
				cameraUp,
				cameraPos,
				world,
				playerHalfWidth,
				playerHeight,
				dt,
			);
		}

		// Raycast from camera to find targeted block
		currentHit = raycast(cameraPos, cameraFront, world, MAX_REACH);
		debuggerParams.targetBlock = currentHit
			? currentHit.blockPos.join(', ')
			: 'none';

		requestRender();

		requestAnimationFrame(tick);
	}

	BuildDebug(render);
	function render(): void {
		stats.begin();
		renderRequestId = 0;
		debuggerParams.vertices = 0;

		if (canvas === null) throw new Error('No canvas found!');
		// Get the current texture from the canvas context and
		// set it as the texture to render to.
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
					clearValue: { r: 0, g: 0, b: 0, a: 0 }, // clear totally
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
		pass.setPipeline(pipeline);
		pass.setVertexBuffer(0, vertexBuffer);

		const aspect = canvas.clientWidth / canvas.clientHeight;
		const projection = mat4.perspective(
			degToRad(60), // fieldOfView,
			aspect,
			1, // zNear
			5000, // zFar
		);

		const viewMatrix = mat4.lookAt(
			cameraPos,
			vec3.add(cameraPos, cameraFront),
			cameraUp,
		);
		// Compute the view projection matrix
		const viewProjectionMatrix = mat4.multiply(projection, viewMatrix);

		// Upload the view-projection matrix (positions are baked into the mesh)
		uniformValues.set(viewProjectionMatrix);
		device.queue.writeBuffer(uniformBuffer, 0, uniformValues);

		// Single draw call for the entire greedy-meshed chunk
		pass.setBindGroup(0, bindGroup);
		pass.draw(meshNumVertices);
		debuggerParams.vertices = meshNumVertices;

		// Draw wireframes
		if (debuggerParams.wireframe) {
			pass.setPipeline(barycentricCoordinatesBasedWireframePipeline);
			pass.setBindGroup(0, wireframeBindGroup);
			pass.draw(meshNumVertices);
		}

		// Draw block highlight outline on targeted block
		if (currentHit) {
			drawHighlight(
				pass,
				device,
				highlight,
				viewProjectionMatrix,
				currentHit.blockPos[0],
				currentHit.blockPos[1],
				currentHit.blockPos[2],
				BLOCK_SIZE,
			);
		}

		// Draw water plane (reflective surface above terrain)
		drawWater(pass, device, water, viewProjectionMatrix, cameraPos);

		// Draw skybox (after geometry, uses less-equal depth test)
		drawSkybox(pass, device, skybox, viewMatrix, projection);

		pass.end();

		const commandBuffer = encoder.finish();
		device.queue.submit([commandBuffer]);

		stats.end();
	}

	// ============================================
	// INPUT HANDLERS
	// ============================================

	canvas.addEventListener('click', () => {
		if (document.pointerLockElement !== canvas) {
			void canvas.requestPointerLock();
		}
	});

	// Suppress context menu so right-click doesn't open a menu
	canvas.addEventListener('contextmenu', (e) => {
		e.preventDefault();
	});

	canvas.addEventListener('mousedown', (e) => {
		if (document.pointerLockElement !== canvas) return;
		if (!currentHit) return;

		if (e.button === 0) {
			// Left click = break block
			const [bx, by, bz] = currentHit.blockPos;
			world.setBlock(bx, by, bz, AIR);
			remesh();
		} else if (e.button === 2) {
			// Right click = place block
			const px = currentHit.blockPos[0] + currentHit.faceNormal[0];
			const py = currentHit.blockPos[1] + currentHit.faceNormal[1];
			const pz = currentHit.blockPos[2] + currentHit.faceNormal[2];

			// Don't place a block where the player is standing
			const camX = cameraPos[0] / BLOCK_SIZE;
			const camY = cameraPos[1] / BLOCK_SIZE;
			const camZ = cameraPos[2] / BLOCK_SIZE;
			const feetY = camY - playerHeight / BLOCK_SIZE;
			const hw = playerHalfWidth / BLOCK_SIZE;

			const playerMinBX = Math.floor(camX - hw);
			const playerMaxBX = Math.floor(camX + hw - 1e-6);
			const playerMinBY = Math.floor(feetY);
			const playerMaxBY = Math.floor(camY - 1e-6);
			const playerMinBZ = Math.floor(camZ - hw);
			const playerMaxBZ = Math.floor(camZ + hw - 1e-6);

			if (
				px >= playerMinBX &&
				px <= playerMaxBX &&
				py >= playerMinBY &&
				py <= playerMaxBY &&
				pz >= playerMinBZ &&
				pz <= playerMaxBZ
			) {
				return; // would trap the player
			}

			world.setBlock(px, py, pz, MARBLE);
			remesh();
		}
	});

	document.addEventListener(
		'mousemove',
		(e) => {
			if (document.pointerLockElement !== canvas) return;

			const sensitivity = 40;
			const step = sensitivity * 0.001;
			cameraYaw += e.movementX * step;
			cameraPitch -= e.movementY * step;

			if (cameraPitch + step >= 88) cameraPitch = 88 - step;
			if (cameraPitch - step <= -88) cameraPitch = -88 + step;

			const direction = vec3.create(
				Math.cos(degToRad(cameraYaw)) * Math.cos(degToRad(cameraPitch)),
				Math.sin(degToRad(cameraPitch)),
				Math.sin(degToRad(cameraYaw)) * Math.cos(degToRad(cameraPitch)),
			);

			vec3.normalize(direction, cameraFront);

			requestRender();
		},
		false,
	);

	document.addEventListener('keydown', (e) => {
		// Use e.code so it's layout-independent ("KeyW" stays KeyW on AZERTY, etc.)
		if (
			e.code === 'KeyW' ||
			e.code === 'KeyA' ||
			e.code === 'KeyS' ||
			e.code === 'KeyD' ||
			e.code === 'ShiftLeft' ||
			e.code === 'Space'
		) {
			e.preventDefault();
			keysDown.add(e.code);
		}
	});

	document.addEventListener('keyup', (e) => {
		keysDown.delete(e.code);
	});

	// Prevent "stuck key" if the tab loses focus mid-press
	window.addEventListener('blur', () => {
		keysDown.clear();
	});

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
			// re-render
			render();
		}
	});
	observer.observe(canvas);

	// Start animation loop after all initialization is complete
	requestAnimationFrame((t) => {
		lastT = t;
		tick(t);
	});
}
await main();
