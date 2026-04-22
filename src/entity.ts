/**
 * Entity system — types, lifecycle management, and world integration.
 *
 * Enemies are defined by 5 composable axes:
 *   Shape    → mesh geometry, movement physics, behavior palette
 *   Role     → specific AI strategy from the shape's palette
 *   Material → texture, physical stats (density, speed, hardness, restitution)
 *   Size     → stat scaling (passed as `size` at spawn)
 *   Traits   → bolt-on behavioral modifiers (future)
 */

import { mat4 } from 'wgpu-matrix';
import { MARBLE, BRICK, DARK_MARBLE } from './block';
import { CHUNK_SIZE } from './chunk';
import { createIcosphere } from './icosphere';
import { createBeveledCube } from './cube';
import {
	createEntityRenderData,
	updateEntityTransform,
	drawEntities,
	destroyEntityRenderData,
} from './entity-renderer';
import type { EntityRenderer, EntityRenderData } from './entity-renderer';
import {
	entityPhysicsTick,
	entityCubePhysicsTick,
	resolveSpherePair,
	resolveSphereVsCube,
	startCubeTip,
	advanceCubeTip,
} from './entity-physics';
import type { TipState } from './entity-physics';
import { entityAITick } from './entity-ai';
import type { World } from './world';

// ── Axes ────────────────────────────────────────────────────────────

export const Shape = { Sphere: 0, Cube: 1 } as const;
export type Shape = (typeof Shape)[keyof typeof Shape];

export const Role = { Rush: 0, Zone: 1, Crush: 2 } as const;
export type Role = (typeof Role)[keyof typeof Role];

export const Material = { Marble: 0, Brick: 1, DarkMarble: 2 } as const;
export type Material = (typeof Material)[keyof typeof Material];

export type Trait = number;

// ── Material properties ─────────────────────────────────────────────

interface MaterialProperties {
	name: string;
	texLayer: number; // index into block texture array
	textureScale: number; // UV tiling density (matches block registry values)
	density: number; // drives mass = density * size³
	baseSpeed: number; // movement speed multiplier
	hardness: number; // durability multiplier
	restitution: number; // bounciness 0..1
}

// Mass = density * size^MASS_SIZE_POWER, normalized so a reference sphere
// (density 2, size 10 — roughly player-height modal size) has mass = 1. Keeps
// AI constants interpretable without re-tuning base values. Mass scales thrust
// (a = F/m) and drag's time constant, so heavier spheres accelerate AND
// decelerate slowly. Terminal speed is ~invariant across masses. Bump power
// to 2 for gentler scaling if n=3 feels too extreme; volumetric is physically
// honest but dramatic (a 2x-larger sphere is 8x heavier).
const MASS_SIZE_POWER = 2;
const MASS_REFERENCE_SIZE = 10;
const MASS_REFERENCE_DENSITY = 2;
const MASS_NORMALIZATION =
	MASS_REFERENCE_DENSITY * MASS_REFERENCE_SIZE ** MASS_SIZE_POWER;

// Seconds between per-cube AI tip attempts. Paired with TIP_DURATION=0.4s,
// this gives cubes ~0.6s of idle per cycle — visible beat rather than
// continuous tumble, matching the design doc's "roll-over → pause → roll-
// over" cadence. Each fresh cube spawns with a random initial cooldown
// phase so a group doesn't fire in lockstep.
const TIP_INTERVAL = 1.0;

function computeMass(density: number, size: number): number {
	return (density * size ** MASS_SIZE_POWER) / MASS_NORMALIZATION;
}

const materials: Record<Material, MaterialProperties> = {
	[Material.Marble]: {
		name: 'marble',
		texLayer: MARBLE,
		textureScale: 6,
		density: 2.7,
		baseSpeed: 1.0,
		hardness: 0.8,
		restitution: 0.4,
	},
	[Material.Brick]: {
		name: 'brick',
		texLayer: BRICK,
		textureScale: 3,
		density: 1.8,
		baseSpeed: 0.7,
		hardness: 1.0,
		restitution: 0.2,
	},
	[Material.DarkMarble]: {
		name: 'darkMarble',
		texLayer: DARK_MARBLE,
		textureScale: 6,
		density: 4,
		baseSpeed: 1.0,
		hardness: 1.2,
		restitution: 0.4,
	},
};

// ── Entity ──────────────────────────────────────────────────────────

export interface Entity {
	id: number;
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
	orientation: Float32Array<ArrayBuffer>;
	grounded: boolean;
	scale: number;
	mass: number;
	restitution: number;
	shape: Shape;
	material: Material;
	role: Role;
	traits: Trait[];
	renderData: EntityRenderData;
	// Non-null only while a Cube is mid-tip. Physics + pair collision skip
	// entities with an active tip; uploadTransform switches to the tip
	// composite transform.
	tip: TipState | null;
	// Last climb tip's horizontal direction. Drives the Option-A zigzag:
	// each vertical-intent climb flips sign from the previous one, netting
	// +2·edge vertical and zero horizontal across each pair of climbs.
	// Both zero = cube has never climbed; the AI picks the first direction
	// from player-relative geometry. Only climb tips (dy=1) update these;
	// horizontal walks leave them alone so the zigzag resumes intact after
	// a detour. Set inside `tryTipCube` after `startCubeTip` succeeds.
	lastClimbDx: number;
	lastClimbDz: number;
	// Seconds until the next AI tip attempt for a Cube. Decrements each
	// frame while idle (not mid-tip). When ≤ 0 AND the cube is grounded,
	// the AI fires a tip and resets to TIP_INTERVAL. Skipped entirely for
	// non-cube shapes (value is irrelevant).
	tipCooldown: number;
}

export interface SpawnConfig {
	shape: Shape;
	material: Material;
	role: Role;
	x: number;
	y: number;
	z: number;
	size: number;
	vx?: number;
	vy?: number;
	vz?: number;
	traits?: Trait[];
}

// ── Mesh cache ──────────────────────────────────────────────────────

interface CachedMesh {
	vertices: Float32Array<ArrayBuffer>;
	vertexCount: number;
}

// ── EntityManager ───────────────────────────────────────────────────

export class EntityManager {
	private entities: Entity[] = [];
	private nextId = 0;
	private renderer: EntityRenderer;
	private device: GPUDevice;
	private world: World;
	private meshCache = new Map<Shape, CachedMesh>();

	constructor(renderer: EntityRenderer, device: GPUDevice, world: World) {
		this.renderer = renderer;
		this.device = device;
		this.world = world;
	}

	spawn(config: SpawnConfig): number {
		// Cubes must span a whole number of voxels. Keeps Phase 4 navigation
		// (tip destinations, scaffold footprints) grid-aligned — no fractional
		// cell reasoning. Throws at authoring time so the constraint can't
		// silently drift into the codebase.
		if (config.shape === Shape.Cube) {
			const edge = 2 * config.size;
			const ratio = edge / this.world.blockSize;
			if (Math.abs(ratio - Math.round(ratio)) > 1e-6) {
				throw new Error(
					`Cube size must produce a whole-voxel edge: got size=${String(config.size)} (edge=${String(edge)}) with blockSize=${String(this.world.blockSize)}`,
				);
			}
		}

		let mesh = this.meshCache.get(config.shape);
		if (!mesh) {
			mesh = this.generateMesh(config.shape);
			this.meshCache.set(config.shape, mesh);
		}

		const mat = materials[config.material];
		// texScale converts entity-mesh UV to sampled UV. Shape-specific
		// because mesh UVs are parameterized differently per shape.
		//
		// Reference density (blocks): the greedy mesher emits UV in
		// block-index units divided by textureScale, so one block face
		// spans 1/textureScale UV — i.e. one texture wrap per
		// (textureScale × blockSize) world units. For marble that's
		// 1 wrap per 60 world units (textureScale=6, blockSize=10).
		//
		//   Cube — face UV spans -1..+1 in unit-cube space; world face
		//     width is 2·size. `size/(textureScale·10)` gives sampled UV
		//     spanning 2·size/(textureScale·10) per face, which equals
		//     2·size/60 = size/30 wraps for marble — matches block
		//     density. Uses the same formula as sphere because both
		//     need the implicit /blockSize that the mesher's
		//     block-index UV scheme bakes in.
		//
		//   Sphere — spherical UV wraps 0..1 once around the equator;
		//     world circumference is 2π·size. `size/10` gives ~1 wrap
		//     per equator at size=10, landing near block density
		//     (~63 vs 60 world units per wrap) by happy coincidence
		//     of blockSize=10. Intentionally drops textureScale so all
		//     sphere materials share the same UV density — the bug-
		//     induced uniform look you tuned to. Add a /textureScale
		//     here later if material-aware sphere density is wanted.
		const texScale =
			config.shape === Shape.Cube
				? config.size / (mat.textureScale * 10)
				: config.size / 10;
		const renderData = createEntityRenderData(
			this.device,
			this.renderer,
			mesh.vertices,
			mesh.vertexCount,
			mat.texLayer,
			texScale,
		);

		const id = this.nextId++;
		this.entities.push({
			id,
			x: config.x,
			y: config.y,
			z: config.z,
			vx: config.vx ?? 0,
			vy: config.vy ?? 0,
			vz: config.vz ?? 0,
			orientation: mat4.identity(),
			grounded: false,
			scale: config.size,
			mass: computeMass(mat.density, config.size),
			restitution: mat.restitution,
			shape: config.shape,
			material: config.material,
			role: config.role,
			traits: config.traits ?? [],
			renderData,
			tip: null,
			lastClimbDx: 0,
			lastClimbDz: 0,
			// Random phase so groups of cubes don't tip in unison.
			// Non-cube shapes ignore this field.
			tipCooldown:
				config.shape === Shape.Cube ? Math.random() * TIP_INTERVAL : 0,
		});

		// Initial upload with zero offset — next update() will apply proper wrap
		this.uploadTransform(this.entities[this.entities.length - 1], 0, 0);
		return id;
	}

	/** Per-frame update: step physics for each entity, then upload transforms. */
	update(
		dt: number,
		playerPos: Float32Array,
		playerHalfWidth: number,
		playerHeight: number,
		onBlockChanged: (bx: number, by: number, bz: number) => void,
	): void {
		const ww = this.world.widthChunks * CHUNK_SIZE * this.world.blockSize;
		const hw = ww / 2;
		const px = playerPos[0] ?? 0;
		const pz = playerPos[2] ?? 0;

		// Pass 1 — per-entity AI + solo physics, dispatched by shape.
		// Spheres run AI + sphere physics (gravity, voxel/player contact).
		// Cubes either advance an active tip (gravity suspended, position
		// already snapped to destination) or run cube physics. Mid-tip cubes
		// are intentionally inert — no AI, no gravity, no voxel collision —
		// the tip finishes and normal physics resumes next frame.
		for (const entity of this.entities) {
			if (entity.shape === Shape.Sphere) {
				const mat = materials[entity.material];
				entityAITick(
					entity,
					playerPos,
					mat.baseSpeed,
					entity.mass,
					ww,
					dt,
				);
				entityPhysicsTick(
					entity,
					this.world,
					playerPos,
					playerHalfWidth,
					playerHeight,
					dt,
				);
			} else if (entity.shape === Shape.Cube) {
				// AI-then-physics ordering mirrors the sphere branch above:
				// the AI decides whether to start a tip this frame, and if
				// it does, we route through advanceCubeTip instead of the
				// normal physics tick. Cooldown ticks regardless of grounded
				// state — if a cube is airborne when its timer expires, the
				// next grounded frame fires immediately rather than adding
				// another full interval of delay.
				if (entity.tip === null) {
					entity.tipCooldown -= dt;
					if (entity.tipCooldown <= 0 && entity.grounded) {
						this.tipCubeTowardPlayer(
							entity,
							playerPos,
							onBlockChanged,
						);
						entity.tipCooldown = TIP_INTERVAL;
					}
				}
				if (entity.tip !== null) {
					advanceCubeTip(entity, dt);
				} else {
					entityCubePhysicsTick(entity, this.world, dt);
				}
			}
		}

		// Pass 2 — pair resolution. O(n²) iteration; fine at small n.
		// Splitting this out of Pass 1 means each pair sees finalized
		// post-integration positions on both sides. Cubes are treated as
		// infinite mass vs spheres (sphere bounces, cube doesn't budge),
		// matching the "cubes are platforms" design. Mid-tip cubes skip
		// all pair checks — they're briefly non-collidable so spheres pass
		// through them during the arc (Option A from the Phase 3 plan).
		for (let i = 0; i < this.entities.length; i++) {
			const a = this.entities[i];
			if (a.shape === Shape.Cube && a.tip !== null) continue;
			for (let j = i + 1; j < this.entities.length; j++) {
				const b = this.entities[j];
				if (b.shape === Shape.Cube && b.tip !== null) continue;
				if (a.shape === Shape.Sphere && b.shape === Shape.Sphere) {
					resolveSpherePair(a, b, ww);
				} else if (a.shape === Shape.Sphere && b.shape === Shape.Cube) {
					resolveSphereVsCube(a, b, ww);
				} else if (a.shape === Shape.Cube && b.shape === Shape.Sphere) {
					resolveSphereVsCube(b, a, ww);
				}
				// TODO(phase 2+): cube-vs-cube depenetration. At spawn cubes
				// are authored apart and no dynamics currently push them into
				// each other, so this pair is intentionally a no-op. Revisit
				// once sphere impulses can shove cubes or tipping lands.
			}
		}

		// Pass 3 — render-time wrap offset + transform upload.
		// Render-time wrap: if the entity is on the "wrong side" of the
		// wrapping world relative to the player, offset it to appear at
		// the closer wrap. Matches the per-chunk wrap offset trick.
		for (const entity of this.entities) {
			const dx = entity.x - px;
			const dz = entity.z - pz;
			const offsetX = dx > hw ? -ww : dx < -hw ? ww : 0;
			const offsetZ = dz > hw ? -ww : dz < -hw ? ww : 0;
			this.uploadTransform(entity, offsetX, offsetZ);
		}
	}

	/**
	 * Gameplay-level tip. Before delegating to the low-level `startCubeTip`
	 * physics primitive, fills in any missing ground beneath the destination
	 * with an N³ sub-cube of the cube's own material (dark-marble cubes place
	 * dark-marble blocks, etc.). This is the entry point AI and debug tools
	 * should call — `startCubeTip` alone only checks for ground, it can't
	 * create it.
	 *
	 * Scaffold policy — same formula handles horizontal walks AND climbs:
	 *   - Destination AABB must be fully air.
	 *   - N³ region directly beneath the destination: any air cells become
	 *     the cube's material. Cells already solid are left alone — we never
	 *     overwrite existing terrain. For horizontal tips, this region is
	 *     "the ground" below destination (fills pits). For climbs (dy=1),
	 *     it's the wall between source and destination (completes or creates
	 *     the wall the cube tips onto).
	 *   - If any scaffold cell would overlap an entity, stall. Prevents the
	 *     cube from crushing spheres (or future entities) to build ground.
	 *   - Full N³ scaffold even when geometrically less is needed —
	 *     simplification per the Phase 4 spec. Deep pits and tall walls get
	 *     fully filled.
	 *
	 * Returns true if the tip started (scaffold may or may not have been
	 * needed). Returns false and console.warns on any blocker.
	 *
	 * `onBlockChanged` is invoked once per scaffold block placed so the
	 * caller can schedule remeshes. Always called before the tip starts —
	 * the first frame of the animation already sees the new terrain.
	 */
	tryTipCube(
		entity: Entity,
		direction: [number, number, number],
		onBlockChanged: (bx: number, by: number, bz: number) => void,
	): boolean {
		if (entity.shape !== Shape.Cube) return false;
		if (entity.tip !== null) return false;

		const [dx, dy, dz] = direction;
		const blockSize = this.world.blockSize;
		const s = entity.scale;
		const edge = 2 * s;
		const nVox = Math.round(edge / blockSize);

		const destX = entity.x + dx * edge;
		const destY = entity.y + dy * edge;
		const destZ = entity.z + dz * edge;
		const dMinBX = Math.floor((destX - s) / blockSize);
		const dMinBY = Math.floor((destY - s) / blockSize);
		const dMinBZ = Math.floor((destZ - s) / blockSize);

		// Pre-flight: destination cells must all be air. Checked here (not
		// just in startCubeTip) so we don't start scaffolding for a tip that
		// can't happen anyway.
		for (let ix = 0; ix < nVox; ix++) {
			for (let iy = 0; iy < nVox; iy++) {
				for (let iz = 0; iz < nVox; iz++) {
					if (
						this.world.isSolid(
							dMinBX + ix,
							dMinBY + iy,
							dMinBZ + iz,
						)
					) {
						console.warn(
							`cube tip blocked: destination cell (${String(dMinBX + ix)}, ${String(dMinBY + iy)}, ${String(dMinBZ + iz)}) is solid`,
						);
						return false;
					}
				}
			}
		}

		// Collect scaffold work: cells in the N³ directly below destination
		// that are currently air. Two-phase commit — we validate everything
		// first (no entity overlaps), then mutate + remesh together. If any
		// cell fails the entity check, nothing is placed.
		//
		// iy ∈ [1, nVox]: iy=1 is the layer immediately under destination
		// (same layer startCubeTip's ground check reads), iy=nVox is the
		// deepest layer of the N³ scaffold cube.
		const scaffoldCells: [number, number, number][] = [];
		for (let ix = 0; ix < nVox; ix++) {
			for (let iy = 1; iy <= nVox; iy++) {
				for (let iz = 0; iz < nVox; iz++) {
					const bx = dMinBX + ix;
					const by = dMinBY - iy;
					const bz = dMinBZ + iz;
					if (this.world.isSolid(bx, by, bz)) continue;
					if (this.blockIntersectsEntity(bx, by, bz)) {
						console.warn(
							`cube tip blocked: entity in scaffold cell (${String(bx)}, ${String(by)}, ${String(bz)})`,
						);
						return false;
					}
					scaffoldCells.push([bx, by, bz]);
				}
			}
		}

		// Commit phase — mutate world + notify remesher. Use the cube's own
		// material for placed blocks (marble cube → MARBLE, brick → BRICK,
		// dark-marble → DARK_MARBLE) so scaffolded terrain reads as the
		// cube's trail.
		const blockId = materials[entity.material].texLayer;
		for (const [bx, by, bz] of scaffoldCells) {
			this.world.setBlock(bx, by, bz, blockId);
			onBlockChanged(bx, by, bz);
		}

		// startCubeTip re-checks destination + ground. After scaffold,
		// ground-layer check will now pass. If something unexpected fails,
		// it returns false and console.warns — blocks are already placed
		// but nothing catastrophic: the scaffold just becomes inert terrain.
		const ok = startCubeTip(entity, this.world, direction);
		if (ok && dy === 1) {
			// Remember this climb's horizontal direction so the next climb
			// alternates (Option-A zigzag for net-vertical progress).
			entity.lastClimbDx = dx;
			entity.lastClimbDz = dz;
		}
		return ok;
	}

	/**
	 * Per-cube targeting — beeline toward the player. Caller is responsible
	 * for gating (mid-tip / not-grounded cubes should be skipped before
	 * calling). Routes through `tryTipCube` so scaffolding runs.
	 *
	 * Targeting policy:
	 *   - **Player meaningfully above cube (Δy > edge):** vertical-intent
	 *     mode. Pick a climb by alternating from `lastClimbDx/Dz` — flips
	 *     sign each tip, so two climbs net to zero horizontal and
	 *     +2·edge vertical (Option-A zigzag). First climb (both signs 0)
	 *     seeds direction from the dominant horizontal axis to the player.
	 *   - **Otherwise:** horizontal walk toward dominant player axis.
	 *     If horizontal is blocked (typically a wall), fall back to a
	 *     same-direction climb; scaffolding fills the wall as needed.
	 *
	 * Successful climbs update `lastClimbDx/Dz` inside `tryTipCube`, so
	 * whether a climb fires from the vertical-intent branch or the
	 * horizontal fallback, the next vertical-intent tip will alternate
	 * correctly.
	 */
	private tipCubeTowardPlayer(
		entity: Entity,
		playerPos: Float32Array,
		onBlockChanged: (bx: number, by: number, bz: number) => void,
	): void {
		const px = playerPos[0] ?? 0;
		const py = playerPos[1] ?? 0;
		const pz = playerPos[2] ?? 0;
		const ww = this.world.widthChunks * CHUNK_SIZE * this.world.blockSize;
		const hw = ww / 2;

		// Wrap-aware player-relative direction (Y doesn't wrap)
		let dx = px - entity.x;
		const dy = py - entity.y;
		let dz = pz - entity.z;
		if (dx > hw) dx -= ww;
		else if (dx < -hw) dx += ww;
		if (dz > hw) dz -= ww;
		else if (dz < -hw) dz += ww;

		const edge = 2 * entity.scale;

		// Vertical-intent branch: player is more than one cube-edge above.
		// Pick a climb by alternating the last climb's horizontal direction.
		// If the cube has never climbed, seed direction from the dominant
		// horizontal axis to the player.
		if (dy > edge) {
			let climbDx: number;
			let climbDz: number;
			if (entity.lastClimbDx !== 0 || entity.lastClimbDz !== 0) {
				climbDx = -entity.lastClimbDx;
				climbDz = -entity.lastClimbDz;
			} else if (Math.abs(dx) >= Math.abs(dz)) {
				climbDx = dx >= 0 ? 1 : -1;
				climbDz = 0;
			} else {
				climbDx = 0;
				climbDz = dz >= 0 ? 1 : -1;
			}
			if (
				this.tryTipCube(entity, [climbDx, 1, climbDz], onBlockChanged)
			) {
				return;
			}
			// Alternation pick blocked — fall through to horizontal behavior.
			// Horizontal→climb fallback may still find a way, and any climb
			// that fires will re-seed lastClimbDx/Dz so the zigzag recovers
			// on subsequent tips.
		}

		// Horizontal walk toward dominant player axis; ties break to X.
		let dirX = 0;
		let dirZ = 0;
		if (Math.abs(dx) >= Math.abs(dz)) {
			dirX = dx >= 0 ? 1 : -1;
		} else {
			dirZ = dz >= 0 ? 1 : -1;
		}
		if (this.tryTipCube(entity, [dirX, 0, dirZ], onBlockChanged)) return;
		this.tryTipCube(entity, [dirX, 1, dirZ], onBlockChanged);
	}

	draw(pass: GPURenderPassEncoder): void {
		drawEntities(
			pass,
			this.renderer,
			this.entities.map((e) => e.renderData),
		);
	}

	/**
	 * Returns true if the block at `(bx, by, bz)` would overlap any entity.
	 * Wrap-aware: shifts the block to the nearest wrapped copy relative to
	 * each entity before testing, so placement near the world boundary works.
	 */
	blockIntersectsEntity(bx: number, by: number, bz: number): boolean {
		const blockSize = this.world.blockSize;
		const ww = this.world.widthChunks * CHUNK_SIZE * blockSize;
		const hw = ww / 2;

		const rawMinX = bx * blockSize;
		const rawMinZ = bz * blockSize;
		const boxMinY = by * blockSize;
		const boxMaxY = boxMinY + blockSize;
		const halfBlock = blockSize / 2;

		for (const entity of this.entities) {
			if (entity.shape !== Shape.Sphere) continue;

			// Shift the block to the wrapped copy closest to this entity
			let boxMinX = rawMinX;
			let boxMinZ = rawMinZ;
			const dxRaw = entity.x - (rawMinX + halfBlock);
			const dzRaw = entity.z - (rawMinZ + halfBlock);
			if (dxRaw > hw) boxMinX += ww;
			else if (dxRaw < -hw) boxMinX -= ww;
			if (dzRaw > hw) boxMinZ += ww;
			else if (dzRaw < -hw) boxMinZ -= ww;

			const boxMaxX = boxMinX + blockSize;
			const boxMaxZ = boxMinZ + blockSize;

			const r = entity.scale;
			const cpX = Math.max(boxMinX, Math.min(entity.x, boxMaxX));
			const cpY = Math.max(boxMinY, Math.min(entity.y, boxMaxY));
			const cpZ = Math.max(boxMinZ, Math.min(entity.z, boxMaxZ));
			const dx = entity.x - cpX;
			const dy = entity.y - cpY;
			const dz = entity.z - cpZ;
			if (dx * dx + dy * dy + dz * dz < r * r) return true;
		}
		return false;
	}

	despawn(id: number): void {
		const idx = this.entities.findIndex((e) => e.id === id);
		if (idx === -1) return;
		destroyEntityRenderData(this.entities[idx].renderData);
		this.entities.splice(idx, 1);
	}

	private uploadTransform(
		entity: Entity,
		offsetX: number,
		offsetZ: number,
	): void {
		let model: Float32Array<ArrayBuffer>;
		if (entity.tip !== null) {
			// Tip composite:
			//   M = T(pivot + wrap) · R(axis, θ) · T(sourceOffset) · baseOri · S
			// Applied to a mesh vertex q: scale first, then base orientation,
			// then translate to sourceOffset from pivot, rotate around pivot,
			// and translate pivot to its world position. The wrap offset is
			// absorbed into the outermost translation so horizontal wrapping
			// works the same as the idle branch.
			const tip = entity.tip;
			const theta = tip.progress * tip.endAngle;
			model = mat4.translation([
				tip.pivot[0] + offsetX,
				tip.pivot[1],
				tip.pivot[2] + offsetZ,
			]);
			const rot = mat4.axisRotation(tip.axis, theta);
			mat4.multiply(model, rot, model);
			mat4.translate(model, tip.sourceOffset, model);
			mat4.multiply(model, tip.baseOrientation, model);
			mat4.scale(
				model,
				[entity.scale, entity.scale, entity.scale],
				model,
			);
		} else {
			model = mat4.translation([
				entity.x + offsetX,
				entity.y,
				entity.z + offsetZ,
			]);
			mat4.multiply(model, entity.orientation, model);
			mat4.scale(
				model,
				[entity.scale, entity.scale, entity.scale],
				model,
			);
		}
		updateEntityTransform(this.device.queue, entity.renderData, model);
	}

	private generateMesh(shape: Shape): CachedMesh {
		switch (shape) {
			case Shape.Sphere:
				return createIcosphere(3);
			case Shape.Cube:
				return createBeveledCube();
			default:
				return createIcosphere(0);
		}
	}
}
