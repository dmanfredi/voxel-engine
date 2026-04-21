import { mat4, vec3 } from 'wgpu-matrix';
import VoxelShader from './shader/voxel';
import WireframeShader from './shader/wireframe';
import { initSkybox, drawSkybox, type SkyboxResources } from './skybox';

import { BuildDebug, refreshDebug, debuggerParams, stats } from './debug';
import { greedyMesh } from './greedy-mesh';
import { FREECAM, physicsTick, createPlayerState } from './movement';
import { World } from './world';
import { CHUNK_SIZE, chunkKey } from './chunk';
import { AIR, MARBLE, extractBlockProps } from './block';
import { raycast, type RaycastHit } from './raycast';
// import { initHighlight, drawHighlight } from './highlight';
import { createGameState } from './game-state';
import { autoClimb } from './auto-climb';
import { ChunkLoader } from './chunk-loader';
import { MeshScheduler } from './mesh-scheduler';
import { initEntityRenderer } from './entity-renderer';
import { EntityManager, Shape, Material, Role } from './entity';
import { tryPlaceBlock } from './placement';
import { generateMips, numMipLevels } from './mipmap';
import marbleTextureUrl from '../assets/MarbleBase1024.png';
import bricksTextureUrl from '../assets/Bricks060_1K-PNG_Color.png';
import darkMarbleTextureUrl from '../assets/DarkMarble.png';

// TODO
// - Skylights
// - Better lighting (?)
// - different blocks with different textures

// NOTE TO SELF
// in minecraft, when I jump, my camera almost jiggles a little? vertically. Creates a nice sense of impulse,
// how can I recreate that?

if (!navigator.gpu) {
	alert('WebGPU not supported on this browser.');
	throw new Error('WebGPU not supported on this browser.');
}

const BLOCK_SIZE = 10;
const WORLD_WIDTH = 10; // horizontal chunk width (X and Z), wrapping
const VERTICAL_RADIUS = 6; // chunks above/below player to keep loaded
const SPAWN_CY = 4; // initial player chunk Y

const world = new World(BLOCK_SIZE, WORLD_WIDTH);

const degToRad = (d: number) => (d * Math.PI) / 180;
const up = vec3.create(0, 1, 0);

const worldCenter = (WORLD_WIDTH * CHUNK_SIZE * BLOCK_SIZE) / 2;
const cameraPos = vec3.create(worldCenter, worldCenter, worldCenter);
const cameraFront = vec3.create(0, 0, -1);
const cameraUp = up;

let cameraYaw = -90;
let cameraPitch = 0;
let currentHit: RaycastHit | null = null;
const MAX_REACH = 100; // 10 blocks

interface ChunkRenderData {
	cx: number;
	cy: number;
	cz: number;
	vertexBuffer: GPUBuffer;
	wireframeBindGroup: GPUBindGroup;
	offsetBuffer: GPUBuffer;
	offsetBindGroup: GPUBindGroup;
	numVertices: number;
}

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
		code: VoxelShader,
	});

	const wireframeModule = device.createShaderModule({
		code: WireframeShader,
	});

	// Shared bind group layout for per-chunk offset (group 1 in both pipelines)
	const chunkOffsetBGL = device.createBindGroupLayout({
		label: 'chunk offset',
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.VERTEX,
				buffer: { type: 'uniform' },
			},
		],
	});

	const mainGroup0BGL = device.createBindGroupLayout({
		label: 'main group 0',
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
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
				texture: { sampleType: 'float', viewDimension: '2d-array' },
			},
			{
				binding: 3,
				visibility: GPUShaderStage.FRAGMENT,
				sampler: { type: 'filtering' },
			},
			{
				binding: 4,
				visibility: GPUShaderStage.FRAGMENT,
				texture: { sampleType: 'float', viewDimension: 'cube' },
			},
		],
	});

	const wireframeGroup0BGL = device.createBindGroupLayout({
		label: 'wireframe group 0',
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.VERTEX,
				buffer: { type: 'uniform' },
			},
			{
				binding: 1,
				visibility: GPUShaderStage.VERTEX,
				buffer: { type: 'read-only-storage' },
			},
		],
	});

	const mainPipelineLayout = device.createPipelineLayout({
		bindGroupLayouts: [mainGroup0BGL, chunkOffsetBGL],
	});

	const wireframePipelineLayout = device.createPipelineLayout({
		bindGroupLayouts: [wireframeGroup0BGL, chunkOffsetBGL],
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
		layout: mainPipelineLayout,
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
			layout: wireframePipelineLayout,
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
	const TEXTURE_SIZE = 1024;
	const blockTextureSources: { layer: number; src: string }[] = [
		{ layer: 0, src: marbleTextureUrl }, // AIR placeholder (never sampled)
		{ layer: 1, src: marbleTextureUrl },
		{ layer: 2, src: bricksTextureUrl },
		{ layer: 3, src: darkMarbleTextureUrl },
	];

	const numLayers = blockTextureSources.length;
	const blockTextureArray = device.createTexture({
		label: 'block texture array',
		size: [TEXTURE_SIZE, TEXTURE_SIZE, numLayers],
		format: 'rgba8unorm',
		mipLevelCount: numMipLevels(TEXTURE_SIZE, TEXTURE_SIZE),
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

	// Populate mip levels 1..N by downsampling from level 0 on the GPU.
	generateMips(device, blockTextureArray);

	// linear min/mag + linear mipmap = trilinear filtering.
	// maxAnisotropy preserves sharpness on surfaces viewed at grazing angles
	// (long sightlines across floors/walls). Requires all filters to be 'linear'.
	// repeat mode for tiling across greedy-meshed quads with world-aligned UVs.
	const sampler = device.createSampler({
		magFilter: 'linear',
		minFilter: 'linear',
		mipmapFilter: 'linear',
		maxAnisotropy: 8,
		addressModeU: 'repeat',
		addressModeV: 'repeat',
	});

	// Uniform buffer layout (WGSL std140):
	// mat4x4f  = 64 bytes (offset 0)
	// vec3f    = 12 bytes (offset 64, aligned to 16) — eyePosition
	// f32      = 4 bytes  (offset 76) — shininess (packs into vec3's trailing slot)
	// f32      = 4 bytes  (offset 80) — specularStrength
	// Total: 84 bytes, round up to 96 for 16-byte alignment
	const uniformBufferSize = 96;
	const uniformBuffer = device.createBuffer({
		label: 'uniforms',
		size: uniformBufferSize,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const uniformValues = new Float32Array(uniformBufferSize / 4);

	const blockTextureView = blockTextureArray.createView({
		dimension: '2d-array',
	});

	// Per-chunk GPU resources
	const chunkRenderMap = new Map<string, ChunkRenderData>();

	// Block properties extracted once for mesher (main-thread sync path + worker init)
	const blockProps = extractBlockProps();

	/** Apply a completed mesh result: create GPU buffers and swap into the render map. */
	function applyMeshResult(
		key: string,
		cx: number,
		cy: number,
		cz: number,
		vertexData: Float32Array<ArrayBuffer>,
		numVertices: number,
	): void {
		// Don't apply if the chunk was unloaded while the mesh was in-flight
		if (!world.hasChunk(cx, cy, cz)) return;

		const old = chunkRenderMap.get(key);

		if (numVertices === 0) {
			if (old) {
				old.vertexBuffer.destroy();
				old.offsetBuffer.destroy();
				chunkRenderMap.delete(key);
			}
			return;
		}

		const vertexBuffer = device.createBuffer({
			label: `chunk ${key} vertex buffer`,
			size: vertexData.byteLength,
			usage:
				GPUBufferUsage.VERTEX |
				GPUBufferUsage.STORAGE |
				GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(vertexBuffer, 0, vertexData);

		const wireframeBindGroup = device.createBindGroup({
			label: `chunk ${key} wireframe bindgroup`,
			layout: wireframeGroup0BGL,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: { buffer: vertexBuffer } },
			],
		});

		const offsetBuffer = device.createBuffer({
			label: `chunk ${key} offset`,
			size: 16, // vec4f
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});

		const offsetBindGroup = device.createBindGroup({
			label: `chunk ${key} offset bindgroup`,
			layout: chunkOffsetBGL,
			entries: [{ binding: 0, resource: { buffer: offsetBuffer } }],
		});

		// Swap-then-destroy: old mesh stays visible until the new one is ready
		chunkRenderMap.set(key, {
			cx,
			cy,
			cz,
			vertexBuffer,
			wireframeBindGroup,
			offsetBuffer,
			offsetBindGroup,
			numVertices,
		});

		if (old) {
			old.vertexBuffer.destroy();
			old.offsetBuffer.destroy();
		}
	}

	/** Synchronous mesh path — used for initial load only. */
	function meshChunkSync(cx: number, cy: number, cz: number): void {
		if (!world.getChunk(cx, cy, cz)) return;
		const paddedBlocks = world.buildPaddedBlocks(cx, cy, cz);
		const { vertexData, numVertices } = greedyMesh(
			paddedBlocks,
			cx,
			cy,
			cz,
			world.blockSize,
			blockProps,
		);
		applyMeshResult(
			chunkKey(cx, cy, cz),
			cx,
			cy,
			cz,
			vertexData,
			numVertices,
		);
	}

	// Mesh scheduler: sends meshing work to a web worker
	const meshScheduler = new MeshScheduler(
		world.blockSize,
		blockProps,
		(key, cx, cy, cz, result) => {
			applyMeshResult(
				key,
				cx,
				cy,
				cz,
				result.vertexData,
				result.numVertices,
			);
		},
	);

	/** Async mesh path — submits work to the web worker. */
	function scheduleMeshChunk(
		cx: number,
		cy: number,
		cz: number,
		priority: 'interactive' | 'streaming',
	): void {
		if (!world.getChunk(cx, cy, cz)) return;
		const key = chunkKey(cx, cy, cz);
		const paddedBlocks = world.buildPaddedBlocks(cx, cy, cz);
		meshScheduler.scheduleMesh(key, paddedBlocks, cx, cy, cz, priority);
	}

	/** Destroy GPU resources for a chunk and cancel pending worker jobs. */
	function unmeshChunk(cx: number, cy: number, cz: number): void {
		const key = chunkKey(cx, cy, cz);
		meshScheduler.cancel(key);
		const data = chunkRenderMap.get(key);
		if (data) {
			data.vertexBuffer.destroy();
			data.offsetBuffer.destroy();
			chunkRenderMap.delete(key);
		}
	}

	// ChunkLoader: handles vertical streaming
	const chunkLoader = new ChunkLoader({
		world,
		verticalRadius: VERTICAL_RADIUS,
		loadsPerFrame: 4,
		scheduleMeshChunk: (cx, cy, cz) => {
			scheduleMeshChunk(cx, cy, cz, 'streaming');
		},
		unmeshChunk,
	});

	// Initial synchronous load + mesh (sync path so world is visible on first frame)
	chunkLoader.loadInitial(SPAWN_CY);
	world.forEachChunk((chunk) => {
		meshChunkSync(chunk.cx, chunk.cy, chunk.cz);
	});

	// Initialize skybox
	const skybox: SkyboxResources = await initSkybox(
		device,
		presentationFormat,
	);

	// Bind group for main shader
	const bindGroup = device.createBindGroup({
		label: 'bind group for chunk(s)',
		layout: mainGroup0BGL,
		entries: [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			{ binding: 1, resource: sampler },
			{ binding: 2, resource: blockTextureView },
			{ binding: 3, resource: skybox.sampler },
			{
				binding: 4,
				resource: skybox.texture.createView({ dimension: 'cube' }),
			},
		],
	});

	// Entity system (enemies, etc.)
	const entityRenderer = initEntityRenderer(
		device,
		presentationFormat,
		mainGroup0BGL,
		bindGroup,
	);
	const entityManager = new EntityManager(entityRenderer, device, world);
	entityManager.spawn({
		shape: Shape.Sphere,
		material: Material.DarkMarble,
		role: Role.Rush,
		x: worldCenter,
		y: worldCenter + 100,
		z: worldCenter - 100,
		size: 20,
		vx: 2,
		vz: 2,
	});

	entityManager.spawn({
		shape: Shape.Sphere,
		material: Material.Marble,
		role: Role.Rush,
		x: worldCenter,
		y: worldCenter + 100,
		z: worldCenter - 100,
		size: 10,
		vx: 3,
		vz: -2,
	});

	entityManager.spawn({
		shape: Shape.Sphere,
		material: Material.Brick,
		role: Role.Rush,
		x: worldCenter,
		y: worldCenter + 100,
		z: worldCenter - 100,
		size: 15,
		vx: 3,
		vz: -2,
	});

	// Phase 2 cube: spawned above terrain, falls under gravity and settles
	// on the first solid voxel beneath it. Spheres that roll into it will
	// bounce off (cube treated as infinite mass).
	entityManager.spawn({
		shape: Shape.Cube,
		material: Material.DarkMarble,
		role: Role.Zone,
		x: worldCenter + 60,
		y: worldCenter + 100,
		z: worldCenter - 200,
		size: 20,
	});

	// Initialize block highlight outline
	// const highlight = initHighlight(device, presentationFormat);

	// TODO: re-enable water once it supports chunked worlds

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
	const gameState = createGameState();

	const bpOrb = document.querySelector<HTMLElement>('.bp-orb-value');
	if (!bpOrb) throw new Error('BP orb element not found');
	const bpOrbEl: HTMLElement = bpOrb;

	function updateBPDisplay(): void {
		bpOrbEl.textContent = String(gameState.bp);
	}
	updateBPDisplay();

	/** Schedule remeshing for a chunk and any boundary neighbors affected by a block change. */
	function onBlockChanged(bx: number, by: number, bz: number): void {
		// Wrap horizontal block coords so chunk lookups resolve correctly
		const wb = world.widthChunks * CHUNK_SIZE;
		bx = ((bx % wb) + wb) % wb;
		bz = ((bz % wb) + wb) % wb;

		const cx = Math.floor(bx / CHUNK_SIZE);
		const cy = Math.floor(by / CHUNK_SIZE);
		const cz = Math.floor(bz / CHUNK_SIZE);
		scheduleMeshChunk(cx, cy, cz, 'interactive');

		// If the block is on a chunk boundary, remesh the neighbor for correct AO
		const lx = ((bx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
		const ly = ((by % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
		const lz = ((bz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

		const w = world.widthChunks;
		if (lx === 0)
			scheduleMeshChunk((((cx - 1) % w) + w) % w, cy, cz, 'interactive');
		if (lx === CHUNK_SIZE - 1)
			scheduleMeshChunk((cx + 1) % w, cy, cz, 'interactive');
		if (ly === 0) scheduleMeshChunk(cx, cy - 1, cz, 'interactive');
		if (ly === CHUNK_SIZE - 1)
			scheduleMeshChunk(cx, cy + 1, cz, 'interactive');
		if (lz === 0)
			scheduleMeshChunk(cx, cy, (((cz - 1) % w) + w) % w, 'interactive');
		if (lz === CHUNK_SIZE - 1)
			scheduleMeshChunk(cx, cy, (cz + 1) % w, 'interactive');
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

		// Wrap player position horizontally
		const worldWidth = world.widthChunks * CHUNK_SIZE * BLOCK_SIZE;
		cameraPos[0] = ((cameraPos[0] % worldWidth) + worldWidth) % worldWidth;
		cameraPos[2] = ((cameraPos[2] % worldWidth) + worldWidth) % worldWidth;

		// Stream chunks vertically around the player
		const playerCY = Math.floor(cameraPos[1] / (CHUNK_SIZE * BLOCK_SIZE));
		chunkLoader.update(playerCY);

		// Auto-climb: place a block beneath feet whenever there's air there.
		// Suppressed when holding Shift or in freecam.
		if (!debuggerParams.freecam && !keysDown.has('ShiftLeft')) {
			const climbed = autoClimb(
				cameraPos,
				playerHeight,
				BLOCK_SIZE,
				world,
				entityManager,
				gameState,
			);
			if (climbed) {
				onBlockChanged(climbed.x, climbed.y, climbed.z);
				updateBPDisplay();
			}
		}

		entityManager.update(dt, cameraPos, playerHalfWidth, playerHeight);

		// Raycast from camera to find targeted block
		currentHit = raycast(cameraPos, cameraFront, world, MAX_REACH);
		debuggerParams.targetBlock = currentHit
			? currentHit.blockPos.join(', ')
			: 'none';
		// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
		debuggerParams.playerPos = `${Math.round(cameraPos[0] / BLOCK_SIZE)}, ${Math.round(cameraPos[1] / BLOCK_SIZE)}, ${Math.round(cameraPos[2] / BLOCK_SIZE)}`;

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

		// Upload uniforms: VP matrix + eye position + reflection params
		uniformValues.set(viewProjectionMatrix);
		uniformValues[16] = cameraPos[0]; // eyePosition.x
		uniformValues[17] = cameraPos[1]; // eyePosition.y
		uniformValues[18] = cameraPos[2]; // eyePosition.z
		uniformValues[19] = debuggerParams.shininess; // shininess
		uniformValues[20] = debuggerParams.specularStrength; // specularStrength
		uniformValues[21] = debuggerParams.fogStart; // fogStart
		uniformValues[22] = debuggerParams.fogEnd; // fogEnd
		device.queue.writeBuffer(uniformBuffer, 0, uniformValues);

		// Compute and upload per-chunk wrap offsets
		const ww = world.widthChunks * CHUNK_SIZE * BLOCK_SIZE;
		const hw = ww / 2;
		const offsetData = new Float32Array(4);
		const halfChunk = (CHUNK_SIZE * BLOCK_SIZE) / 2;
		for (const chunkRender of chunkRenderMap.values()) {
			const dx =
				chunkRender.cx * CHUNK_SIZE * BLOCK_SIZE +
				halfChunk -
				cameraPos[0];
			const dz =
				chunkRender.cz * CHUNK_SIZE * BLOCK_SIZE +
				halfChunk -
				cameraPos[2];

			offsetData[0] = dx > hw ? -ww : dx < -hw ? ww : 0;
			offsetData[2] = dz > hw ? -ww : dz < -hw ? ww : 0;

			device.queue.writeBuffer(chunkRender.offsetBuffer, 0, offsetData);
		}

		// Draw all chunk meshes
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bindGroup);
		for (const chunkRender of chunkRenderMap.values()) {
			pass.setBindGroup(1, chunkRender.offsetBindGroup);
			pass.setVertexBuffer(0, chunkRender.vertexBuffer);
			pass.draw(chunkRender.numVertices);
			debuggerParams.vertices += chunkRender.numVertices;
		}

		// Draw wireframes
		if (debuggerParams.wireframe) {
			pass.setPipeline(barycentricCoordinatesBasedWireframePipeline);
			for (const chunkRender of chunkRenderMap.values()) {
				pass.setBindGroup(0, chunkRender.wireframeBindGroup);
				pass.setBindGroup(1, chunkRender.offsetBindGroup);
				pass.draw(chunkRender.numVertices);
			}
		}

		// Draw block highlight outline on targeted block
		if (currentHit) {
			// drawHighlight(
			// 	pass,
			// 	device,
			// 	highlight,
			// 	viewProjectionMatrix,
			// 	currentHit.blockPos[0],
			// 	currentHit.blockPos[1],
			// 	currentHit.blockPos[2],
			// 	BLOCK_SIZE,
			// );
		}

		// Draw entities (after terrain, before skybox)
		entityManager.draw(pass);

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
			// Left click = break block (gains 1 BP)
			const [bx, by, bz] = currentHit.blockPos;
			world.setBlock(bx, by, bz, AIR);
			onBlockChanged(bx, by, bz);
			gameState.bp++;
			updateBPDisplay();
		} else if (e.button === 2) {
			// Right click = place block (costs 1 BP)
			if (gameState.bp <= 0) return;
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

			if (!tryPlaceBlock(world, entityManager, px, py, pz, MARBLE)) {
				return; // would overlap an entity
			}
			onBlockChanged(px, py, pz);
			gameState.bp--;
			updateBPDisplay();
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
		if (e.code === 'KeyF') {
			debuggerParams.freecam = !debuggerParams.freecam;
			if (!debuggerParams.freecam) {
				playerState.velX = 0;
				playerState.velY = 0;
				playerState.velZ = 0;
			}
			refreshDebug();
		}
		if (e.code === 'KeyT') {
			entityManager.tipAllCubesTowardPlayer(cameraPos, onBlockChanged);
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
