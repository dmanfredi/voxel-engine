/**
 * ProjectileManager — runtime for the projectile mining system.
 *
 * Owns the live projectile list, runs the per-tick move + collide loop,
 * applies the first-contact-freebie hardness rule, and disposes
 * projectiles on strength exhaustion, hard-block stop, or lifetime expiry.
 *
 * Deliberately parallel to EntityManager rather than folded into it:
 * projectiles have a different per-tick shape (no AI, no pair resolution),
 * a different voxel-collision response (consume the voxel rather than
 * bouncing), different material semantics (strength + hitbox vs.
 * density + restitution), and a higher spawn rate. See the design
 * conversation for the full split.
 *
 * v1 deliberately omits sub-stepping. Pickaxe speed is 2 blocks/sec ≈
 * 0.033 blocks/tick @ 60fps — far below the 0.5-block tunneling threshold.
 * Add sub-stepping when a faster projectile profile actually tunnels.
 */

import { mat4 } from 'wgpu-matrix';
import { AIR, blockRegistry } from './block';
import { CHUNK_SIZE } from './chunk';
import {
	createProjectileRenderData,
	updateProjectileTransform,
	drawProjectiles,
	drawProjectileWireframes,
	destroyProjectileRenderData,
} from './projectile-renderer';
import type {
	ProjectileRenderer,
	ProjectileRenderData,
} from './projectile-renderer';
import type { World } from './world';
import {
	orientationFromDirection,
	type Projectile,
	type ProjectileProfile,
} from './projectile';

export interface ProjectileManagerCallbacks {
	/**
	 * Fired after the manager has set the voxel to AIR. The caller is
	 * responsible for all downstream effects: schedule chunk remesh,
	 * invalidate any AI caches (flow field), award BP, update HUD.
	 * Keeps the manager decoupled from game-state and rendering concerns.
	 */
	onBlockBroken(bx: number, by: number, bz: number): void;
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
	 * direction × profile.speed.
	 */
	spawn(
		profile: ProjectileProfile,
		origin: Float32Array,
		direction: Float32Array,
	): void {
		const position = new Float32Array([origin[0], origin[1], origin[2]]);
		const velocity = new Float32Array([
			direction[0] * profile.speed,
			direction[1] * profile.speed,
			direction[2] * profile.speed,
		]);
		// Orientation derived from velocity at spawn. Constant for the
		// projectile's lifetime — v1 has no spin or trajectory bending.
		const orientation = new Float32Array(16);
		orientationFromDirection(velocity, orientation);
		const projectile: Projectile = {
			profile,
			position,
			velocity,
			orientation,
			strength: profile.strength,
			age: 0,
			firstHit: true,
		};
		const renderData = createProjectileRenderData(
			this.device,
			this.renderer,
		);
		this.projectiles.push(projectile);
		this.renderDatas.push(renderData);
		// Initial transform — without this the projectile renders at the
		// origin for one frame before its first update tick lands.
		this.writeTransform(projectile, renderData);
	}

	/**
	 * Per-tick update. Iterates backward so swap-pop dispose doesn't skip
	 * elements. Order within a tick: age check → move → wrap → scan
	 * hitbox cells for the first solid → break-or-stop.
	 */
	update(dt: number): void {
		const bs = this.world.blockSize;
		const ww = this.worldWidthUnits;

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

			// Collide. One-impact-one-block per tick: scan cells in
			// leading-edge order and process the first SOLID one found.
			// Air cells are skipped over rather than short-circuiting —
			// otherwise a hitbox whose leading-edge cell is air (e.g. the
			// just-broken cell ahead, with side cells clipping into a
			// wall) misses the solid entirely.
			//
			// Still one impact per tick: we stop at the first solid.
			// Subsequent solid cells remain reachable on later ticks if
			// the hitbox still overlaps them.
			let disposed = false;
			const cells = p.profile.hitbox.cellsAt(
				p.position,
				p.orientation,
				bs,
			);
			let hitBX = 0;
			let hitBY = 0;
			let hitBZ = 0;
			let hitBlockId = AIR;
			for (const cell of cells) {
				const id = this.world.getBlock(cell[0], cell[1], cell[2]);
				if (id !== AIR) {
					hitBX = cell[0];
					hitBY = cell[1];
					hitBZ = cell[2];
					hitBlockId = id;
					break;
				}
			}

			if (hitBlockId !== AIR) {
				const props = blockRegistry.get(hitBlockId);
				if (props) {
					const hardness = props.hardness;
					if (p.firstHit || p.strength > hardness) {
						// First-contact freebie OR strength-affords-it.
						// Strength decrements regardless — freebie still costs.
						this.world.setBlock(hitBX, hitBY, hitBZ, AIR);
						this.callbacks.onBlockBroken(hitBX, hitBY, hitBZ);
						p.strength -= hardness;
						p.firstHit = false;
						if (p.strength <= 0) {
							this.disposeAt(i);
							disposed = true;
						}
					} else {
						// Hit a block we can't afford and freebie spent.
						// Projectile stops here, block remains intact.
						this.disposeAt(i);
						disposed = true;
					}
				}
			}

			// Survived this tick — push the new transform to the GPU.
			if (!disposed) {
				this.writeTransform(p, this.renderDatas[i]);
			}
		}
	}

	private writeTransform(p: Projectile, rd: ProjectileRenderData): void {
		// Cube mesh vertices live in [-1, 1] (half-extent convention,
		// matching entity meshes), so scale by visualSize/2 to produce a
		// cube of `visualSize` edge length. The hitbox uses the same
		// half-extent (visualSize * 0.5) so collision and visual align.
		const s = p.profile.visualSize * 0.5;
		mat4.translation(
			[p.position[0], p.position[1], p.position[2]],
			this.modelScratch,
		);
		mat4.multiply(this.modelScratch, p.orientation, this.modelScratch);
		mat4.scale(this.modelScratch, [s, s, s], this.modelScratch);
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

	/**
	 * Debug visualization. Draws each projectile's OBB outline in cyan
	 * and the wireframe of every voxel cell its hitbox reports as
	 * overlapping in magenta. Both layers use `depthCompare: 'always'`
	 * so they remain visible through terrain.
	 *
	 * If a cell visually clipped by the cube does NOT show up as a
	 * magenta wireframe → hitbox enumeration is missing it. If it DOES
	 * show up but no break happens → the collision logic / leading-edge
	 * sort isn't picking it.
	 *
	 * Wireframe mesh lives in [-1, 1] (matching the solid cube mesh), so
	 * scales here mirror writeTransform: `visualSize * 0.5` for OBB,
	 * `blockSize * 0.5` for cells. Match the conventions exactly or the
	 * wireframes drift from what the manager actually thinks.
	 */
	drawDebugWireframes(pass: GPURenderPassEncoder): void {
		const bs = this.world.blockSize;
		const stride = 80 / 4; // 20 floats per instance (mat4 + vec4 color)
		const staging = this.renderer.wireframeStaging;
		const cap = this.renderer.wireframeInstanceCapacity;
		let count = 0;

		const writeInstance = (
			model: Float32Array<ArrayBuffer>,
			r: number,
			g: number,
			b: number,
		): void => {
			if (count >= cap) return;
			const base = count * stride;
			staging.set(model, base);
			staging[base + 16] = r;
			staging[base + 17] = g;
			staging[base + 18] = b;
			staging[base + 19] = 1;
			count++;
		};

		// OBB outlines — cyan. Same T * R * S as writeTransform so the
		// wireframe is the exact outline of the rendered cube.
		for (const p of this.projectiles) {
			const s = p.profile.visualSize * 0.5;
			mat4.translation(
				[p.position[0], p.position[1], p.position[2]],
				this.modelScratch,
			);
			mat4.multiply(this.modelScratch, p.orientation, this.modelScratch);
			mat4.scale(this.modelScratch, [s, s, s], this.modelScratch);
			writeInstance(this.modelScratch, 0, 1, 1);
		}

		// Cell outlines — magenta. Re-runs cellsAt to get the same set the
		// manager would. Each cell renders as a unit cube ([-1, 1]) scaled
		// by blockSize/2 → edge length blockSize, positioned at cell center.
		const cellScale = bs * 0.5;
		for (const p of this.projectiles) {
			const cells = p.profile.hitbox.cellsAt(
				p.position,
				p.orientation,
				bs,
			);
			for (const cell of cells) {
				mat4.translation(
					[
						(cell[0] + 0.5) * bs,
						(cell[1] + 0.5) * bs,
						(cell[2] + 0.5) * bs,
					],
					this.modelScratch,
				);
				mat4.scale(
					this.modelScratch,
					[cellScale, cellScale, cellScale],
					this.modelScratch,
				);
				writeInstance(this.modelScratch, 1, 0, 1);
			}
		}

		drawProjectileWireframes(pass, this.device, this.renderer, count);
	}
}
