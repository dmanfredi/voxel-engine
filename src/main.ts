import { mat4, vec3 } from 'wgpu-matrix';
import VoxelShader from './shader/voxel';
import WireframeShader from './shader/wireframe';
import { initSkybox, drawSkybox, type SkyboxResources } from './skybox';

import { BuildDebug, refreshDebug, debuggerParams, stats } from './debug';
import { greedyMesh } from './greedy-mesh';
import { FREECAM, physicsTick, createPlayerState } from './movement';
import { World } from './world';
import { CHUNK_SIZE, chunkKey } from './chunk';
import { extractBlockProps } from './block';
import { raycast, type RaycastHit } from './raycast';
// import { initHighlight, drawHighlight } from './highlight';
import { createGameState } from './game-state';
import { LOCKOUT_DURATION, type PlayerContext } from './entity-interactions';
import { autoClimb } from './auto-climb';
import { ChunkLoader } from './chunk-loader';
import { MeshScheduler } from './mesh-scheduler';
import { initEntityRenderer } from './entity-renderer';
import { EntityManager, Shape, Role, traitSupportsShape } from './entity';
import { Spawner } from './spawner';
import { tryPlaceBlock } from './placement';
import { generateMips, numMipLevels } from './mipmap';
import { initToolbar } from './toolbar';
import { ProjectileManager } from './projectile-manager';
import { initProjectileRenderer } from './projectile-renderer';
import { initCrushBeamRenderer, drawCrushBeams } from './crush-beam-renderer';
import { canFire, tickToolCooldowns, type Tool } from './tool';
import {
	createVoidFloorState,
	updateVoidFloor,
	voidDeleteFloorCY,
	voidLethalY,
	VOID_MAX_GAP_BLOCKS,
} from './void-floor';
import { initVoidFloorRenderer, drawVoidFloor } from './void-floor-renderer';
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
const AUTO_CLIMB_DURATION = 0.4;

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
const DEBUG_SPAWN_REACH = 2000; // raycast reach for the debug enemy spawner
// Distance under which LMB fires parallel to cameraFront instead of
// aiming at the crosshair-hit point. See fireLMB for the rationale.
const PARALLEL_FIRE_RANGE = 50;
// Half-extent of the void floor's debug planes. Large enough to fill the view
// past terrain edges out to the fog/far plane.
const VOID_PLANE_HALF_EXTENT = 6000;

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

	// Projectile renderer — own pipeline + shader, reads only binding 0 of
	// the shared group 0 (the VP-matrix uniform). No texture sampling.
	const projectileRenderer = initProjectileRenderer(
		device,
		presentationFormat,
		mainGroup0BGL,
		bindGroup,
	);

	// Void floor renderer — own pipeline, shares group-0 binding-0 (VP matrix).
	const voidFloorRenderer = initVoidFloorRenderer(
		device,
		presentationFormat,
		mainGroup0BGL,
		bindGroup,
	);

	// Crush telegraph beam renderer — translucent red column, drawn after the
	// skybox so it composites over everything. Shares group-0 binding-0.
	const crushBeamRenderer = initCrushBeamRenderer(
		device,
		presentationFormat,
		mainGroup0BGL,
		bindGroup,
	);

	// Enemy spawning — enemies are born from terrain near the player. The spawn
	// table + tuning live in spawner.ts; this just drives it each tick.
	// onRegionChanged is a hoisted declaration (defined below), same as the
	// projectile manager's onBlockChanged reference.
	const spawner = new Spawner(world, entityManager, onRegionChanged);

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
	// Mouse-button hold state. Autofire-on-hold is driven from the
	// per-frame tick reading these, not from mousedown — that way the
	// tool cooldown is the rate-limit and the player just keeps holding.
	let lmbDown = false;
	let rmbDown = false;
	let autoClimbRemaining = 0;
	const playerState = createPlayerState();
	const playerHeight = BLOCK_SIZE * 2 * 0.9;
	const playerHalfWidth = BLOCK_SIZE / 4;
	const gameState = createGameState();

	// One stable PlayerContext for the entity system
	const playerContext: PlayerContext = {
		pos: cameraPos,
		vel: playerState,
		halfWidth: playerHalfWidth,
		height: playerHeight,
		hitState: gameState,
	};

	// Void floor — starts at max gap below the player's feet and rises. Effects
	// are stubbed (logged) for now; orb crack/shake + death overlay come later.
	const voidFloorState = createVoidFloorState(
		cameraPos[1] - playerHeight - VOID_MAX_GAP_BLOCKS * BLOCK_SIZE,
	);
	const voidFloorCallbacks = {
		onCrack: (hits: number) => {
			console.log(`[void] crack ${String(hits)}`);
		},
		onHeal: (hits: number) => {
			console.log(`[void] heal ${String(hits)}`);
		},
		onDeath: (cause: 'shatter' | 'lethal') => {
			console.log(`[void] death: ${cause}`);
		},
	};

	const bpOrb = document.querySelector<HTMLElement>('.bp-orb-value');
	const bpOrbBox = document.querySelector<HTMLElement>('.bp-orb');
	const bpOrbRing = document.querySelector<HTMLElement>('.bp-orb-ring');
	if (!bpOrb || !bpOrbBox || !bpOrbRing)
		throw new Error('BP orb elements not found');
	const bpOrbEl: HTMLElement = bpOrb;
	const bpOrbBoxEl: HTMLElement = bpOrbBox;
	const bpOrbRingEl: HTMLElement = bpOrbRing;

	// Dirty-checked: called every frame (a blast can dock BP mid-frame with no
	// callback out), but only writes the DOM when the value actually moved.
	let renderedBP: number | null = null;
	function updateBPDisplay(): void {
		if (gameState.bp === renderedBP) return;
		renderedBP = gameState.bp;
		bpOrbEl.textContent = String(gameState.bp);
	}
	updateBPDisplay();

	// Lockout feedback: dim the orb (disabled look) and melt its outline ring
	// from the top as the timer drains. The class flips once per lock/unlock;
	// the clip-path genuinely animates, so it writes only while draining.
	let lockedNow = false;
	function updateLockoutDisplay(): void {
		const locked = gameState.lockoutRemaining > 0;
		if (locked) {
			if (!lockedNow) {
				bpOrbBoxEl.classList.add('locked');
				lockedNow = true;
			}
			const drained =
				(1 - gameState.lockoutRemaining / LOCKOUT_DURATION) * 100;
			bpOrbRingEl.style.clipPath = `inset(${String(drained)}% 0 0 0)`;
		} else if (lockedNow) {
			bpOrbBoxEl.classList.remove('locked');
			lockedNow = false;
		}
	}
	updateLockoutDisplay();

	// Toolbar — 1-4 keys and scroll wheel write through to gameState so
	// LMB/RMB handlers read from a single source of truth.
	initToolbar({
		initialIndex: gameState.selectedToolIndex,
		onSelect: (i) => {
			gameState.selectedToolIndex = i;
		},
	});

	// Spawn scratch — reused every fire, avoid per-shot allocation. Both
	// are copied inside spawn(), so it's safe to overwrite them next call.
	const spawnOrigin = new Float32Array(3);
	const spawnDirection = new Float32Array(3);
	const cameraRight = new Float32Array(3);

	/**
	 * Fire the given tool's LMB action — spawn one projectile from a
	 * camera-local offset, reset its cooldown, debit its cost. Caller is
	 * responsible for the canFire gate (so the per-frame loop doesn't
	 * pay the offset math when the shot would be rejected anyway).
	 *
	 * Returns false without firing when the tool's aimConstraint rejects the
	 * current aim (e.g. a cardinal-locked tool aimed off its lanes) — no
	 * cooldown or cost is spent, so the player can retry the instant they
	 * line up.
	 */
	function fireLMB(tool: Tool): boolean {
		// camera-local right = normalize(cross(front, up)). cameraUp is
		// world-Y by construction, so this is well-defined unless the
		// player is looking straight up/down — pitch is clamped to ±88°
		// in the mousemove handler so we never reach that singularity.
		cameraRight[0] =
			cameraFront[1] * cameraUp[2] - cameraFront[2] * cameraUp[1];
		cameraRight[1] =
			cameraFront[2] * cameraUp[0] - cameraFront[0] * cameraUp[2];
		cameraRight[2] =
			cameraFront[0] * cameraUp[1] - cameraFront[1] * cameraUp[0];
		const rLen = Math.hypot(cameraRight[0], cameraRight[1], cameraRight[2]);
		cameraRight[0] /= rLen;
		cameraRight[1] /= rLen;
		cameraRight[2] /= rLen;

		const off = tool.spawnOffset;
		for (let i = 0; i < 3; i++) {
			spawnOrigin[i] =
				cameraPos[i] +
				cameraRight[i] * off[0] +
				cameraUp[i] * off[1] +
				cameraFront[i] * off[2];
		}

		// Resolve the travel direction. A tool with an aimConstraint (e.g.
		// cardinal lock) resolves and may reject its own direction; tools
		// without one use the crosshair convergence aiming below.
		if (tool.aimConstraint) {
			if (!tool.aimConstraint(cameraFront, spawnDirection)) {
				return false;
			}
			// Center the spawn on the block grid along Y so a tall constrained
			// hitbox carves whole rows instead of dipping into the floor (the eye sits
			// mid-block). Skip vertical lanes, where Y is the travel axis.
			if (Math.abs(spawnDirection[1]) < 0.5) {
				spawnOrigin[1] =
					(Math.floor(spawnOrigin[1] / BLOCK_SIZE) + 0.5) *
					BLOCK_SIZE;
			}
		} else {
			// Aim correction has two regimes split at PARALLEL_FIRE_RANGE.
			// Beyond it, aim at the hit point on the crosshair ray so the
			// projectile converges on the target. Inside it, fire parallel to
			// cameraFront — the spawn offset is a large fraction of close-range
			// distances, so a convergence-aimed direction over-rotates and the
			// projectile veers heavily off the crosshair. Parallel-at-close
			// keeps the visible offset small and constant (just the spawn nudge).
			const aimReach =
				tool.projectile.speed * tool.projectile.maxLifetime;
			const aimHit = raycast(cameraPos, cameraFront, world, aimReach);
			if (aimHit && aimHit.distance < PARALLEL_FIRE_RANGE) {
				spawnDirection[0] = cameraFront[0];
				spawnDirection[1] = cameraFront[1];
				spawnDirection[2] = cameraFront[2];
			} else {
				const aimDistance = aimHit ? aimHit.distance : aimReach;
				const tx =
					cameraPos[0] +
					cameraFront[0] * aimDistance -
					spawnOrigin[0];
				const ty =
					cameraPos[1] +
					cameraFront[1] * aimDistance -
					spawnOrigin[1];
				const tz =
					cameraPos[2] +
					cameraFront[2] * aimDistance -
					spawnOrigin[2];
				const tLen = Math.hypot(tx, ty, tz);
				spawnDirection[0] = tx / tLen;
				spawnDirection[1] = ty / tLen;
				spawnDirection[2] = tz / tLen;
			}
		}

		projectileManager.spawn(
			tool.projectile,
			spawnOrigin,
			spawnDirection,
			tool,
		);

		tool.lmbCooldownRemaining = tool.lmbCooldown;
		if (tool.lmbCost > 0) {
			gameState.bp -= tool.lmbCost;
			updateBPDisplay();
		}
		return true;
	}

	/**
	 * Fire the given tool's RMB action — resolve the build profile against
	 * the raycast hit, place each cell the player can afford, and reset
	 * the RMB cooldown iff something was actually placed. No-op on
	 * targets that yield zero cells; no rate penalty when nothing lands
	 * (Minecraft-style — holding RMB into open air doesn't cool down).
	 *
	 * onRegionChanged handles the meshing fan-out for any cell count; for
	 * a single cell it does the same surgical neighbor scheduling
	 * onBlockChanged would.
	 */
	function fireRMB(tool: Tool, hit: RaycastHit): void {
		const cells = tool.buildProfile.targetSelector(hit, cameraFront);
		if (cells.length === 0) return;

		// Player AABB in block coords. Computed once; each candidate cell
		// is tested against this so we don't trap the player in their own
		// build.
		const camX = cameraPos[0] / BLOCK_SIZE;
		const camY = cameraPos[1] / BLOCK_SIZE;
		const camZ = cameraPos[2] / BLOCK_SIZE;
		const feetY = camY - playerHeight / BLOCK_SIZE;
		const hw = playerHalfWidth / BLOCK_SIZE;
		const pMinX = Math.floor(camX - hw);
		const pMaxX = Math.floor(camX + hw - 1e-6);
		const pMinY = Math.floor(feetY);
		const pMaxY = Math.floor(camY - 1e-6);
		const pMinZ = Math.floor(camZ - hw);
		const pMaxZ = Math.floor(camZ + hw - 1e-6);

		const { blockId, costPerBlock } = tool.buildProfile;

		let placedAny = false;
		let minBX = Infinity;
		let minBY = Infinity;
		let minBZ = Infinity;
		let maxBX = -Infinity;
		let maxBY = -Infinity;
		let maxBZ = -Infinity;

		for (const [px, py, pz] of cells) {
			if (gameState.bp < costPerBlock) break;
			if (
				px >= pMinX &&
				px <= pMaxX &&
				py >= pMinY &&
				py <= pMaxY &&
				pz >= pMinZ &&
				pz <= pMaxZ
			) {
				continue; // would trap the player
			}
			if (!tryPlaceBlock(world, entityManager, px, py, pz, blockId)) {
				continue; // entity overlap, or cell already non-air
			}
			gameState.bp -= costPerBlock;
			placedAny = true;
			if (px < minBX) minBX = px;
			if (py < minBY) minBY = py;
			if (pz < minBZ) minBZ = pz;
			if (px > maxBX) maxBX = px;
			if (py > maxBY) maxBY = py;
			if (pz > maxBZ) maxBZ = pz;
		}

		if (!placedAny) return;
		onRegionChanged(minBX, minBY, minBZ, maxBX, maxBY, maxBZ);
		updateBPDisplay();
		tool.rmbCooldownRemaining = tool.rmbCooldown;
	}

	// Projectile system. Constructed here (rather than next to entityManager)
	// so its onBlocksBroken callback can close over gameState + updateBPDisplay.
	// onRegionChanged is a hoisted function declaration so referencing it from
	// the callback is safe even though it's defined further down.
	const projectileManager = new ProjectileManager(
		world,
		{
			onBlocksBroken: (
				minBX,
				minBY,
				minBZ,
				maxBX,
				maxBY,
				maxBZ,
				count,
				sourceTool,
			) => {
				onRegionChanged(minBX, minBY, minBZ, maxBX, maxBY, maxBZ);
				entityManager.invalidateFlowField();
				// Carve still lands during lockout; the BP earning is what's frozen.
				if (gameState.lockoutRemaining <= 0) {
					gameState.bp += count * sourceTool.bpPerBreak;
					updateBPDisplay();
				}
			},
		},
		device,
		projectileRenderer,
	);

	/** Schedule a slab of chunks (inclusive ranges). X/Z wrap; Y does not.
	 *  Caller passes raw chunk coords; wrapping happens here at schedule time. */
	function scheduleChunkSlab(
		cxMin: number,
		cxMax: number,
		cyMin: number,
		cyMax: number,
		czMin: number,
		czMax: number,
	): void {
		const w = world.widthChunks;
		for (let cx = cxMin; cx <= cxMax; cx++) {
			const wcx = ((cx % w) + w) % w;
			for (let cy = cyMin; cy <= cyMax; cy++) {
				for (let cz = czMin; cz <= czMax; cz++) {
					const wcz = ((cz % w) + w) % w;
					scheduleMeshChunk(wcx, cy, wcz, 'interactive');
				}
			}
		}
	}

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

	/**
	 * Region equivalent of `onBlockChanged` for bulk placements
	 * Bounds are inclusive in block coords. Schedules every
	 * chunk overlapping the region, plus the 6 outer-face neighbor slabs
	 * when the region's edges hug chunk boundaries (cross-chunk AO).
	 *
	 * Use this instead of looping `onBlockChanged` per cell — for an N³
	 * scaffold whose blocks live in 1-2 chunks, that loop calls the
	 * scheduler N³ times only to dedup down to the same handful of unique
	 * chunks. This routes straight to the unique chunks once.
	 *
	 * X/Z wrap works without special-casing: chunk indices wrap inside
	 * `scheduleChunkSlab`, and the outer-face fan-out uses local block
	 * coords which are wrap-invariant. A cross-seam region (e.g.
	 * minBX=318, maxBX=321 in a 320-wide world) just produces a slab
	 * that spans the seam — both chunks end up scheduled, cross-chunk AO
	 * picks up the new padding from the other side. Y does not wrap.
	 *
	 * Sole constraint: region width < world width on each axis (otherwise
	 * the slab over-iterates). Scaffolds are tiny vs. the world, so it's
	 * never tight.
	 */
	function onRegionChanged(
		minBX: number,
		minBY: number,
		minBZ: number,
		maxBX: number,
		maxBY: number,
		maxBZ: number,
	): void {
		const cMinX = Math.floor(minBX / CHUNK_SIZE);
		const cMaxX = Math.floor(maxBX / CHUNK_SIZE);
		const cMinY = Math.floor(minBY / CHUNK_SIZE);
		const cMaxY = Math.floor(maxBY / CHUNK_SIZE);
		const cMinZ = Math.floor(minBZ / CHUNK_SIZE);
		const cMaxZ = Math.floor(maxBZ / CHUNK_SIZE);

		scheduleChunkSlab(cMinX, cMaxX, cMinY, cMaxY, cMinZ, cMaxZ);

		// Outer-face fan-out: only the region's outer edges can need cross-
		// chunk AO. Interior chunk boundaries inside the region are already
		// covered on both sides because both chunks are in the slab.
		const lMinX = ((minBX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
		const lMaxX = ((maxBX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
		const lMinY = ((minBY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
		const lMaxY = ((maxBY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
		const lMinZ = ((minBZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
		const lMaxZ = ((maxBZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

		if (lMinX === 0)
			scheduleChunkSlab(cMinX - 1, cMinX - 1, cMinY, cMaxY, cMinZ, cMaxZ);
		if (lMaxX === CHUNK_SIZE - 1)
			scheduleChunkSlab(cMaxX + 1, cMaxX + 1, cMinY, cMaxY, cMinZ, cMaxZ);
		if (lMinY === 0)
			scheduleChunkSlab(cMinX, cMaxX, cMinY - 1, cMinY - 1, cMinZ, cMaxZ);
		if (lMaxY === CHUNK_SIZE - 1)
			scheduleChunkSlab(cMinX, cMaxX, cMaxY + 1, cMaxY + 1, cMinZ, cMaxZ);
		if (lMinZ === 0)
			scheduleChunkSlab(cMinX, cMaxX, cMinY, cMaxY, cMinZ - 1, cMinZ - 1);
		if (lMaxZ === CHUNK_SIZE - 1)
			scheduleChunkSlab(cMinX, cMaxX, cMinY, cMaxY, cMaxZ + 1, cMaxZ + 1);
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

		gameState.lockoutRemaining = Math.max(
			0,
			gameState.lockoutRemaining - dt,
		);
		autoClimbRemaining = Math.max(0, autoClimbRemaining - dt);

		if (debuggerParams.freecam) {
			FREECAM(keysDown, cameraPos, cameraFront, cameraUp, dt * 300);
		} else {
			const justJumped = physicsTick(
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
			if (justJumped) autoClimbRemaining = AUTO_CLIMB_DURATION;
		}

		// Wrap player position horizontally
		const worldWidth = world.widthChunks * CHUNK_SIZE * BLOCK_SIZE;
		cameraPos[0] = ((cameraPos[0] % worldWidth) + worldWidth) % worldWidth;
		cameraPos[2] = ((cameraPos[2] % worldWidth) + worldWidth) % worldWidth;

		// Advance the void floor (rise + clamp + damage) before streaming, so
		// the chunk loader sees this frame's consumed-chunk floor.
		const playerFeetY = cameraPos[1] - playerHeight;
		updateVoidFloor(
			voidFloorState,
			dt,
			playerFeetY,
			BLOCK_SIZE,
			voidFloorCallbacks,
		);
		debuggerParams.voidBand = voidFloorState.band;
		debuggerParams.voidHits = voidFloorState.hits;
		debuggerParams.voidGap = (
			(playerFeetY - voidFloorState.surfaceY) /
			BLOCK_SIZE
		).toFixed(1);

		// Stream chunks vertically around the player
		const playerCY = Math.floor(cameraPos[1] / (CHUNK_SIZE * BLOCK_SIZE));
		chunkLoader.update(
			playerCY,
			voidDeleteFloorCY(voidFloorState, BLOCK_SIZE),
		);

		// Auto-climb is briefly armed by a jump. Shift remains the opt-out for
		// precision jumps where the player wants to leave the space untouched.
		if (
			autoClimbRemaining > 0 &&
			!debuggerParams.freecam &&
			!keysDown.has('ShiftLeft')
		) {
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

		// Attempt enemy spawns before the entity update so a fresh spawn's
		// flow-field invalidation and first physics tick land this same frame.
		// Toggleable via the Enemies debug pane; manual spawns still work.
		if (debuggerParams.spawnerEnabled) spawner.update(dt, cameraPos);

		entityManager.update(dt, playerContext, onRegionChanged);
		debuggerParams.enemyCount = entityManager.activeCount;
		// A blast this frame may have docked BP and set the lockout; reflect both.
		updateBPDisplay();
		updateLockoutDisplay();

		projectileManager.update(dt, cameraPos);

		// Raycast from camera to find targeted block
		currentHit = raycast(cameraPos, cameraFront, world, MAX_REACH);
		debuggerParams.targetBlock = currentHit
			? currentHit.blockPos.join(', ')
			: 'none';

		// Tool cooldowns + autofire-on-hold. Runs after raycast so RMB
		// fires against the current frame's hit. Cooldown is the
		// rate-limiter: holding LMB/RMB simply queues the next fire as
		// soon as it expires. The chargeTime === null check guards the
		// autofire branch — charge-up tools will grow their own branch.
		tickToolCooldowns(gameState.tools, dt);
		const selectedTool = gameState.tools[gameState.selectedToolIndex];
		if (selectedTool) {
			if (
				lmbDown &&
				selectedTool.chargeTime === null &&
				canFire(selectedTool, 'lmb', gameState)
			) {
				fireLMB(selectedTool);
			}
			if (
				rmbDown &&
				currentHit &&
				canFire(selectedTool, 'rmb', gameState)
			) {
				fireRMB(selectedTool, currentHit);
			}
		}
		// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
		debuggerParams.playerPos = `${Math.round(cameraPos[0] / BLOCK_SIZE)}, ${Math.round(cameraPos[1] / BLOCK_SIZE)}, ${Math.round(cameraPos[2] / BLOCK_SIZE)}`;

		requestRender();

		requestAnimationFrame(tick);
	}

	BuildDebug(render, {
		onSpawnEnemy: (shape, material, size, traits) => {
			const hit = raycast(
				cameraPos,
				cameraFront,
				world,
				DEBUG_SPAWN_REACH,
			);
			if (!hit) return; // nothing in front of the camera within reach

			// Surface point along the ray, pushed out by the enemy's radius so
			// it rests on the hit face rather than embedded in it.
			const [nx, ny, nz] = hit.faceNormal;
			const y = cameraPos[1] + cameraFront[1] * hit.distance + ny * size;
			let x = cameraPos[0] + cameraFront[0] * hit.distance + nx * size;
			let z = cameraPos[2] + cameraFront[2] * hit.distance + nz * size;

			// Cubes must stay grid-aligned for tipping — snap the footprint to
			// the block grid in X/Z (Y already rests on the surface).
			if (shape === Shape.Cube) {
				x = Math.round((x - size) / BLOCK_SIZE) * BLOCK_SIZE + size;
				z = Math.round((z - size) / BLOCK_SIZE) * BLOCK_SIZE + size;
			}

			entityManager.spawn({
				shape,
				material,
				role: shape === Shape.Cube ? Role.Crush : Role.Rush,
				traits: traits.filter((trait) =>
					traitSupportsShape(trait, shape),
				),
				size,
				x,
				y,
				z,
			});
		},
	});
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
		entityManager.draw(pass, debuggerParams.enemyXray);

		// Draw projectiles — own pipeline, slot before skybox so the
		// less-equal cubemap pass is the final color contributor.
		projectileManager.draw(pass);

		// Draw skybox (after geometry, uses less-equal depth test)
		drawSkybox(pass, device, skybox, viewMatrix, projection);

		// Draw void floor planes last — over the sky, occluded by terrain.
		// Ascending Y so the surface composites over the lethal line. Colors
		// are placeholder debug fills; the real void shader swaps in later.
		drawVoidFloor(
			pass,
			device,
			voidFloorRenderer,
			cameraPos[0],
			cameraPos[2],
			VOID_PLANE_HALF_EXTENT,
			[
				{
					y: voidLethalY(voidFloorState, BLOCK_SIZE),
					color: [0.0, 0.0, 0.0, 0.5],
				},
				{ y: voidFloorState.surfaceY, color: [0.15, 0.15, 0.25, 0.3] },
			],
		);

		// Crush telegraph beams last — translucent red columns drawn over
		// everything, so the marked lane is unmissable.
		drawCrushBeams(
			pass,
			device,
			crushBeamRenderer,
			entityManager.collectCrushBeams(),
		);

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
		// Both LMB and RMB just flip their autofire flag — the actual
		// fire happens in the per-frame tick, gated by canFire.
		if (e.button === 0) lmbDown = true;
		else if (e.button === 2) rmbDown = true;
	});

	canvas.addEventListener('mouseup', (e) => {
		if (e.button === 0) lmbDown = false;
		else if (e.button === 2) rmbDown = false;
	});

	// Pointer-lock loss (user hits Esc, alt-tabs, etc.) skips the mouseup
	// event for whatever was held — flush button state to avoid a "stuck"
	// button that keeps autofiring when the window regains focus.
	document.addEventListener('pointerlockchange', () => {
		if (document.pointerLockElement !== canvas) {
			lmbDown = false;
			rmbDown = false;
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
	});

	document.addEventListener('keyup', (e) => {
		keysDown.delete(e.code);
	});

	// Prevent "stuck key" if the tab loses focus mid-press
	window.addEventListener('blur', () => {
		keysDown.clear();
		lmbDown = false;
		rmbDown = false;
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
