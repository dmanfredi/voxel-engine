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
 * Sub-stepping is deliberately omitted. Collision samples only the new
 * position each tick, so sufficiently fast profiles can tunnel; address that
 * separately when projectile motion is revisited.
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
	type Projectile,
	type ProjectileProfile,
} from './projectile';

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

	constructor(
		world: World,
		callbacks: ProjectileManagerCallbacks,
		device: GPUDevice,
		renderer: ProjectileRenderer,
	) {
		this.world = world;
		this.callbacks = callbacks;
		this.worldWidthUnits = world.widthChunks * CHUNK_SIZE * world.blockSize;
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
	 */
	spawn(
		profile: ProjectileProfile,
		origin: Float32Array,
		direction: Float32Array,
		sourceTool: Tool,
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
	 * elements. Order within a tick: age check → move → wrap → sweep-break
	 * overlapped cells → render-time wrap-offset upload. `playerPos` drives
	 * the render-side wrap so projectiles on the far side of the seam draw at
	 * their nearer copy.
	 */
	update(dt: number, playerPos: Float32Array): void {
		const bs = this.world.blockSize;
		const ww = this.worldWidthUnits;
		const hw = ww / 2;
		const px = playerPos[0];
		const pz = playerPos[2];

		for (let i = this.projectiles.length - 1; i >= 0; i--) {
			const p = this.projectiles[i];

			// Lifetime first — bounded work per projectile even if it never
			// touches anything (e.g., fires into open sky).
			p.age += dt;
			if (p.age >= p.profile.maxLifetime) {
				this.disposeAt(i);
				continue;
			}

			// Integrate
			p.position[0] += p.velocity[0] * dt;
			p.position[1] += p.velocity[1] * dt;
			p.position[2] += p.velocity[2] * dt;

			// Wrap X/Z — Y is open (no vertical wrap)
			p.position[0] = ((p.position[0] % ww) + ww) % ww;
			p.position[2] = ((p.position[2] % ww) + ww) % ww;

			// Sweep-break: destroy every solid cell the hitbox overlaps this
			// tick, charging strength by each block's hardness. The whole
			// overlap breaks before the strength check, so strength is a soft
			// cap that rounds up to the last complete sweep rather than
			// leaving a slice half-cleared (which would read as piecemeal).
			let disposed = false;
			let brokenCount = 0;
			let minBX = Infinity;
			let minBY = Infinity;
			let minBZ = Infinity;
			let maxBX = -Infinity;
			let maxBY = -Infinity;
			let maxBZ = -Infinity;
			const cellCount = p.profile.hitbox.cellsAt(
				p.position,
				p.orientation,
				bs,
				this.cellScratch,
			);
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
			if (p.strength <= 0) {
				this.disposeAt(i);
				disposed = true;
			}

			// Survived this tick — push the new transform to the GPU.
			// Render-time wrap: if the projectile sits on the far side of
			// the wrapping world relative to the player, offset it to its
			// nearer copy. Same trick chunks and entities use.
			if (!disposed) {
				const dx = p.position[0] - px;
				const dz = p.position[2] - pz;
				const offsetX = dx > hw ? -ww : dx < -hw ? ww : 0;
				const offsetZ = dz > hw ? -ww : dz < -hw ? ww : 0;
				this.writeTransform(p, this.renderDatas[i], offsetX, offsetZ);
			}
		}
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
