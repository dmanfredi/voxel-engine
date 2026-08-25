/**
 * ProjectileManager — runtime for the projectile mining system.
 *
 * Owns the live projectile list, runs the per-tick move + collide loop,
 * applies sweep-break hardness, and disposes projectiles on strength
 * exhaustion or lifetime expiry.
 *
 * Deliberately parallel to EntityManager rather than folded into it:
 * projectiles have a different per-tick shape (no AI, no pair resolution),
 * a different voxel-collision response (consume the voxel rather than
 * bouncing), different material semantics (strength + hitbox vs.
 * density + restitution), and a higher spawn rate.
 *
 * Movement is collision-sampled in half-block sub-steps. This reuses every
 * Hitbox implementation unchanged while preventing ordinary fast projectiles
 * from skipping entire voxel cells between rendered frames.
 */

import { mat4 } from 'wgpu-matrix';
import { AIR, blockRegistry } from './block';
import { CHUNK_SIZE } from './chunk';
import {
	createProjectileRenderData,
	updateProjectileTransform,
	drawProjectiles,
	destroyProjectileRenderData,
} from './projectile-renderer';
import type {
	ProjectileRenderer,
	ProjectileRenderData,
} from './projectile-renderer';
import type { Tool } from './tool';
import type { World } from './world';
import {
	MAX_HITBOX_CELLS,
	orientationFromDirection,
	ProjectileEffect,
	type Projectile,
	type ProjectileProfile,
	type VoxelCoord,
} from './projectile';
import { deriveImpactNormal, type ImpactContext } from './growth';

const MAX_SUBSTEP_BLOCKS = 0.5;

export interface ProjectileManagerCallbacks {
	/**
	 * Fired once after a projectile sweep has set every reported voxel to AIR.
	 * Bounds conservatively enclose the exact, potentially non-convex changed
	 * cells; `count` is the number actually broken. The caller is
	 * responsible for all downstream effects: schedule chunk remesh,
	 * invalidate any AI caches (flow field), award BP, update HUD.
	 * `sourceTool` is the tool that fired the projectile — callbacks
	 * dispatch per-tool payouts/FX off it. Keeps the manager decoupled
	 * from game-state and rendering concerns.
	 */
	onBlocksBroken(
		minBX: number,
		minBY: number,
		minBZ: number,
		maxBX: number,
		maxBY: number,
		maxBZ: number,
		count: number,
		sourceTool: Tool,
	): void;

	/**
	 * Fired once when a Build-effect projectile comes to rest, immediately
	 * before it disposes — on first solid contact, or at the end of its flight
	 * if it never touched anything (`ctx.normal` is null in that case). The
	 * caller hands the context to the growth system, which decides whether a
	 * site without a face builds anything; the manager itself knows nothing
	 * about growths.
	 */
	onBuildImpact(ctx: ImpactContext, sourceTool: Tool): void;
}

export class ProjectileManager {
	// Parallel arrays kept in lockstep — projectiles[i] is rendered by
	// renderDatas[i]. Avoids per-frame allocation that map() would introduce.
	private projectiles: Projectile[] = [];
	private renderDatas: ProjectileRenderData[] = [];

	private readonly world: World;
	private readonly callbacks: ProjectileManagerCallbacks;
	private readonly worldWidthUnits: number;

	private readonly device: GPUDevice;
	private readonly renderer: ProjectileRenderer;

	// Scratch model matrix — reused across all writeTransform calls.
	// (Fresh allocation per projectile per frame is unnecessary GC pressure.)
	private readonly modelScratch = mat4.create() as Float32Array<ArrayBuffer>;

	// Scratch cell buffer for hitbox queries — flat x,y,z triples. Reused
	// across every projectile: cellsAt fills it and the collision scan
	// consumes it before the next call, so no per-frame allocation.
	private readonly cellScratch = new Int32Array(3 * MAX_HITBOX_CELLS);

	// Scratch face normal for build impacts; copied into the context on use.
	private readonly normalScratch: [number, number, number] = [0, 0, 0];

	/** World width in cells — seam-nearest resolution for build anchors. */
	private readonly worldWidthCells: number;

	constructor(
		world: World,
		callbacks: ProjectileManagerCallbacks,
		device: GPUDevice,
		renderer: ProjectileRenderer,
	) {
		this.world = world;
		this.callbacks = callbacks;
		this.worldWidthUnits = world.widthChunks * CHUNK_SIZE * world.blockSize;
		this.worldWidthCells = world.widthChunks * CHUNK_SIZE;
		this.device = device;
		this.renderer = renderer;
	}

	/**
	 * Spawn a projectile. `origin` and `direction` are copied into fresh
	 * buffers — the caller may mutate or reuse the inputs after the call.
	 * `direction` must be a unit vector; velocity is computed as
	 * direction × profile.speed. `sourceTool` is stamped on the projectile
	 * and threaded to the break callback so the callback can dispatch
	 * per-tool effects (BP payout, FX, sounds).
	 *
	 * `buildAnchor` is only meaningful for Build-effect profiles: it is the
	 * cell the resulting growth should plan back toward, captured now so the
	 * span meets where the shot was fired rather than where the shooter ends
	 * up. Mine projectiles pass null.
	 */
	spawn(
		profile: ProjectileProfile,
		origin: Float32Array,
		direction: Float32Array,
		sourceTool: Tool,
		buildAnchor: VoxelCoord | null = null,
	): void {
		const position = new Float32Array([origin[0], origin[1], origin[2]]);
		const velocity = new Float32Array([
			direction[0] * profile.speed,
			direction[1] * profile.speed,
			direction[2] * profile.speed,
		]);
		// Orientation derived from velocity at spawn. Constant for the
		// projectile's lifetime — no spin or trajectory bending.
		const orientation = new Float32Array(16);
		orientationFromDirection(velocity, orientation);
		const projectile: Projectile = {
			profile,
			position,
			velocity,
			orientation,
			strength: profile.strength,
			age: 0,
			sourceTool,
			buildAnchor,
		};
		const renderData = createProjectileRenderData(
			this.device,
			this.renderer,
		);
		this.projectiles.push(projectile);
		this.renderDatas.push(renderData);
		// Initial transform — without this the projectile renders at the
		// origin for one frame before its first update tick lands. Offsets
		// are 0: spawn position is at the camera (within a hip-fire nudge),
		// so the player-relative dx/dz are inside the [-hw, hw] no-wrap
		// band by construction.
		this.writeTransform(projectile, renderData, 0, 0);
	}

	/**
	 * Per-tick update. Iterates backward so swap-pop dispose doesn't skip
	 * elements. Order within a tick: age check → sub-step move + sweep-break →
	 * canonical wrap → one downstream block batch → render transform upload.
	 * `playerPos` drives the render-side wrap so projectiles on the far side of
	 * the seam draw at their nearer copy.
	 */
	update(dt: number, playerPos: Float32Array): void {
		const bs = this.world.blockSize;
		const ww = this.worldWidthUnits;
		const hw = ww / 2;
		const px = playerPos[0];
		const pz = playerPos[2];

		for (let i = this.projectiles.length - 1; i >= 0; i--) {
			const p = this.projectiles[i];

			// Timing maps normalized lifetime to normalized distance. Differencing
			// the curve at this frame's endpoints is frame-rate independent; scaling
			// by maxLifetime preserves total range at speed * maxLifetime.
			const maxLifetime = p.profile.maxLifetime;
			const previousAge = p.age;
			const nextAge = Math.min(previousAge + dt, maxLifetime);
			const previousProgress = previousAge / maxLifetime;
			const nextProgress = nextAge / maxLifetime;
			const motionTime =
				maxLifetime *
				(p.profile.timing(nextProgress) -
					p.profile.timing(previousProgress));
			p.age = nextAge;
			const lifetimeExpired = nextAge >= maxLifetime;
			const maxStepDistance = bs * MAX_SUBSTEP_BLOCKS;
			const travelDistance = Math.abs(p.profile.speed * motionTime);
			const substepCount = Math.max(
				1,
				Math.ceil(travelDistance / maxStepDistance),
			);
			const substepTime = motionTime / substepCount;

			// Accumulate one notification across every sub-step. Each individual
			// overlap breaks completely before strength is checked, preserving the
			// soft-cap rule without letting an exhausted projectile travel farther.
			const building = p.profile.effect === ProjectileEffect.Build;
			let brokenCount = 0;
			let minBX = Infinity;
			let minBY = Infinity;
			let minBZ = Infinity;
			let maxBX = -Infinity;
			let maxBY = -Infinity;
			let maxBZ = -Infinity;
			let impacted = false;
			let impactX = 0;
			let impactY = 0;
			let impactZ = 0;
			for (let step = 0; step < substepCount; step++) {
				// Cell occupied before this step — the reference for working out
				// which face a build impact arrived through.
				const preX = Math.floor(p.position[0] / bs);
				const preY = Math.floor(p.position[1] / bs);
				const preZ = Math.floor(p.position[2] / bs);

				p.position[0] += p.velocity[0] * substepTime;
				p.position[1] += p.velocity[1] * substepTime;
				p.position[2] += p.velocity[2] * substepTime;

				const cellCount = p.profile.hitbox.cellsAt(
					p.position,
					p.orientation,
					bs,
					this.cellScratch,
				);

				if (building) {
					// Stop at the solid cell nearest where this step began — of
					// everything the hitbox straddles, that is the one travel
					// reached first.
					let bestCell = -1;
					let bestDistance = Infinity;
					for (let c = 0; c < cellCount; c++) {
						const bx = this.cellScratch[3 * c];
						const by = this.cellScratch[3 * c + 1];
						const bz = this.cellScratch[3 * c + 2];
						if (!this.world.isSolid(bx, by, bz)) continue;
						const ddx = bx - preX;
						const ddy = by - preY;
						const ddz = bz - preZ;
						const d = ddx * ddx + ddy * ddy + ddz * ddz;
						if (d < bestDistance) {
							bestDistance = d;
							bestCell = c;
						}
					}
					if (bestCell >= 0) {
						impacted = true;
						impactX = this.cellScratch[3 * bestCell];
						impactY = this.cellScratch[3 * bestCell + 1];
						impactZ = this.cellScratch[3 * bestCell + 2];
						deriveImpactNormal(
							preX,
							preY,
							preZ,
							impactX,
							impactY,
							impactZ,
							p.velocity,
							this.normalScratch,
						);
						break;
					}
					continue;
				}

				for (let c = 0; c < cellCount; c++) {
					const bx = this.cellScratch[3 * c];
					const by = this.cellScratch[3 * c + 1];
					const bz = this.cellScratch[3 * c + 2];
					const id = this.world.getBlock(bx, by, bz);
					if (id === AIR) continue;
					const props = blockRegistry.get(id);
					if (!props) continue;
					this.world.setBlock(bx, by, bz, AIR);
					brokenCount++;
					if (bx < minBX) minBX = bx;
					if (by < minBY) minBY = by;
					if (bz < minBZ) minBZ = bz;
					if (bx > maxBX) maxBX = bx;
					if (by > maxBY) maxBY = by;
					if (bz > maxBZ) maxBZ = bz;
					p.strength -= props.hardness;
				}

				if (p.strength <= 0) break;
			}

			// Cell the bolt came to rest in — the struck cell, or wherever its
			// flight ran out. Captured before the canonical wrap so it shares
			// the unwrapped frame the impact cell was resolved in.
			let restX = impactX;
			let restY = impactY;
			let restZ = impactZ;
			if (building && !impacted) {
				restX = Math.floor(p.position[0] / bs);
				restY = Math.floor(p.position[1] / bs);
				restZ = Math.floor(p.position[2] / bs);
			}

			// Keep coordinates unwrapped during sub-stepping so a seam-crossing
			// batch has compact raw bounds (e.g. 318..321, not 0..319).
			p.position[0] = ((p.position[0] % ww) + ww) % ww;
			p.position[2] = ((p.position[2] % ww) + ww) % ww;

			// One condition for both resolving and disposing, so a build can
			// never be dropped by a disposal path that forgot to resolve it.
			const disposing = impacted || p.strength <= 0 || lifetimeExpired;

			if (brokenCount > 0) {
				this.callbacks.onBlocksBroken(
					minBX,
					minBY,
					minBZ,
					maxBX,
					maxBY,
					maxBZ,
					brokenCount,
					p.sourceTool,
				);
			}
			// A build bolt resolves wherever it stops, contact or not; the null
			// normal is what tells the planner which happened.
			if (building && disposing && p.buildAnchor) {
				this.callbacks.onBuildImpact(
					{
						// Resolved to the copy nearest the anchor: a shot that
						// crossed the world seam mid-flight would otherwise plan a
						// span the long way around the world.
						cell: [
							this.nearestCellCopy(restX, p.buildAnchor[0]),
							restY,
							this.nearestCellCopy(restZ, p.buildAnchor[2]),
						],
						normal: impacted
							? [
									this.normalScratch[0],
									this.normalScratch[1],
									this.normalScratch[2],
								]
							: null,
						direction: unitVector(p.velocity),
						anchor: p.buildAnchor,
					},
					p.sourceTool,
				);
			}
			if (disposing) {
				this.disposeAt(i);
				continue;
			}

			// Survived every sub-step — push the final transform to the GPU.
			// Render-time wrap: if the projectile sits on the far side of
			// the wrapping world relative to the player, offset it to its
			// nearer copy. Same trick chunks and entities use.
			const dx = p.position[0] - px;
			const dz = p.position[2] - pz;
			const offsetX = dx > hw ? -ww : dx < -hw ? ww : 0;
			const offsetZ = dz > hw ? -ww : dz < -hw ? ww : 0;
			this.writeTransform(p, this.renderDatas[i], offsetX, offsetZ);
		}
	}

	/**
	 * Shift a cell coordinate to whichever wrapped copy sits nearest
	 * `reference`, so span planning works in one continuous space.
	 */
	private nearestCellCopy(cell: number, reference: number): number {
		const w = this.worldWidthCells;
		const half = w / 2;
		let d = cell - reference;
		while (d > half) {
			cell -= w;
			d -= w;
		}
		while (d < -half) {
			cell += w;
			d += w;
		}
		return cell;
	}

	private writeTransform(
		p: Projectile,
		rd: ProjectileRenderData,
		offsetX: number,
		offsetZ: number,
	): void {
		// Cube mesh vertices live in [-1, 1] (half-extent convention, matching
		// entity meshes). Scale each local axis by visualSize/2 — a
		// non-uniform scale turns the cube into the box the hitbox tests
		// (half = visualSize/2), keeping what-you-see = what-hits.
		const vs = p.profile.visualSize;
		mat4.translation(
			[p.position[0] + offsetX, p.position[1], p.position[2] + offsetZ],
			this.modelScratch,
		);
		mat4.multiply(this.modelScratch, p.orientation, this.modelScratch);
		mat4.scale(
			this.modelScratch,
			[vs[0] * 0.5, vs[1] * 0.5, vs[2] * 0.5],
			this.modelScratch,
		);
		updateProjectileTransform(this.device.queue, rd, this.modelScratch);
	}

	draw(pass: GPURenderPassEncoder): void {
		drawProjectiles(pass, this.renderer, this.renderDatas);
	}

	/**
	 * Swap-pop removal of both parallel arrays. Index must be valid.
	 * Order of survivors is irrelevant.
	 */
	private disposeAt(index: number): void {
		const last = this.projectiles.length - 1;
		destroyProjectileRenderData(this.renderDatas[index]);
		if (index !== last) {
			this.projectiles[index] = this.projectiles[last];
			this.renderDatas[index] = this.renderDatas[last];
		}
		this.projectiles.pop();
		this.renderDatas.pop();
	}
}

/** Normalized copy of `v`. Allocates — only called once per build impact. */
function unitVector(v: Float32Array): Float32Array {
	const len = Math.hypot(v[0], v[1], v[2]);
	if (len < 1e-6) return new Float32Array([0, 0, 0]);
	return new Float32Array([v[0] / len, v[1] / len, v[2] / len]);
}
