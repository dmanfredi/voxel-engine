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
	 * Debug helper — triggers a tip on every idle cube toward the player's
	 * dominant horizontal axis. Cubes with infeasible destinations warn via
	 * console and stay idle. Used by the KeyT keybind to validate tip
	 * animation before AI dispatch is wired up (Phase 4).
	 */
	tipAllCubesTowardPlayer(playerPos: Float32Array): void {
		const px = playerPos[0] ?? 0;
		const pz = playerPos[2] ?? 0;
		const ww = this.world.widthChunks * CHUNK_SIZE * this.world.blockSize;
		const hw = ww / 2;

		for (const entity of this.entities) {
			if (entity.shape !== Shape.Cube) continue;
			if (entity.tip !== null) continue;

			// Wrap-aware player-relative direction
			let dx = px - entity.x;
			let dz = pz - entity.z;
			if (dx > hw) dx -= ww;
			else if (dx < -hw) dx += ww;
			if (dz > hw) dz -= ww;
			else if (dz < -hw) dz += ww;

			// Snap to dominant axis; ties break toward X.
			let dirX = 0;
			let dirZ = 0;
			if (Math.abs(dx) >= Math.abs(dz)) {
				dirX = dx >= 0 ? 1 : -1;
			} else {
				dirZ = dz >= 0 ? 1 : -1;
			}
			startCubeTip(entity, this.world, [dirX, 0, dirZ]);
		}
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
			const theta = tip.progress * (Math.PI / 2);
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
