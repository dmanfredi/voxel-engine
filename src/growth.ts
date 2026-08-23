/**
 * Growth — builds that unfold over time.
 *
 * A growth is the second half of a build projectile: the projectile flies and
 * dies on contact, then hands its impact to this system, which lays cells down
 * at a fixed rate until it runs out of plan or runs out of BP. Placement is a
 * *process*, not a transaction — which is the point. A build you can be
 * interrupted during is a build you can gamble on.
 *
 * The split that makes this reusable:
 *
 * - `GrowthProfile` is frozen design data, one per build type, living on the
 *   Tool. It pairs a planner with the rate and cost knobs.
 * - `GrowthPlanner` is a pure function from impact to an ordered cell list.
 *   All the variety between build types lives here — a bridge is a line, a
 *   cage is a shell, a column is a stack. The manager never learns which.
 * - `Growth` is the live instance: plan, cursor, accumulator.
 *
 * The manager deliberately never sees GameState. Affordability arrives as a
 * `spend` callback, so an enemy-owned growth later passes a policy that always
 * allows and nothing in here changes.
 */

import type { BlockId } from './block';
import { canPlaceBlock } from './placement';
import type { EntityManager } from './entity';
import type { Tool } from './tool';
import type { VoxelCoord } from './projectile';
import type { World } from './world';

/** What a planner knows at the moment of impact. */
export interface ImpactContext {
	/** Cell the projectile struck. Typically solid, so plans starting here
	 *  simply skip their first cells and effectively begin at the surface. */
	cell: VoxelCoord;
	/** Face the projectile entered through. See `deriveImpactNormal`. */
	normal: VoxelCoord;
	/** Unit travel direction at impact. */
	direction: Float32Array;
	/** Player's foot cell captured at launch — where a span should reach back to. */
	anchor: VoxelCoord;
}

/**
 * Pure impact → ordered cell list. Order is placement order, so the first
 * cell is where the build starts and the last is where it finishes.
 * Cells may be unplaceable; the manager skips those without charging.
 */
export type GrowthPlanner = (ctx: ImpactContext) => VoxelCoord[];

/** Frozen design data for one build type. Lives on a Tool. */
export interface GrowthProfile {
	planner: GrowthPlanner;
	blockId: BlockId;
	/** BP debited per cell that actually lands. */
	costPerCell: number;
	/**
	 * Propagation rate. A rate rather than a total duration, so a long span
	 * takes proportionally longer — range costs time, and a distant shot is a
	 * real commitment rather than strictly better than a near one.
	 */
	cellsPerSecond: number;
}

/** Live instance. Pure data — behavior lives in the manager. */
interface Growth {
	profile: GrowthProfile;
	cells: VoxelCoord[];
	/** Index of the next cell to attempt. */
	cursor: number;
	/** Fractional cell carried between frames. */
	accumulator: number;
	source: Tool;
}

export interface GrowthManagerCallbacks {
	/**
	 * True (and debits) when `source` can pay for one more cell; false
	 * fizzles the growth where it stands. Inverting this keeps the manager
	 * free of GameState.
	 */
	spend(cost: number, source: Tool): boolean;
	/**
	 * True when a cell overlaps the player. The growth skips it rather than
	 * trapping them — which is also how a span terminates cleanly at someone
	 * standing still, one cell short of their feet.
	 */
	blockedByPlayer(bx: number, by: number, bz: number): boolean;
	/**
	 * One batch per frame across every active growth. Bounds conservatively
	 * enclose the placed cells. The caller schedules remeshing and refreshes
	 * the HUD; the manager handles flow-field invalidation itself.
	 */
	onCellsPlaced(
		minBX: number,
		minBY: number,
		minBZ: number,
		maxBX: number,
		maxBY: number,
		maxBZ: number,
		count: number,
	): void;
}

export class GrowthManager {
	private growths: Growth[] = [];

	private readonly world: World;
	private readonly entityManager: EntityManager;
	private readonly callbacks: GrowthManagerCallbacks;

	constructor(
		world: World,
		entityManager: EntityManager,
		callbacks: GrowthManagerCallbacks,
	) {
		this.world = world;
		this.entityManager = entityManager;
		this.callbacks = callbacks;
	}

	get activeCount(): number {
		return this.growths.length;
	}

	/**
	 * Run the profile's planner and start laying its cells. Plans are computed
	 * once and never revised: the world may change underneath a long span, and
	 * the per-cell placement check absorbs that without re-planning.
	 */
	begin(profile: GrowthProfile, ctx: ImpactContext, source: Tool): void {
		const cells = profile.planner(ctx);
		if (cells.length === 0) return;
		this.growths.push({
			profile,
			cells,
			cursor: 0,
			accumulator: 0,
			source,
		});
	}

	/**
	 * Advance every growth. Iterates backward so swap-pop disposal doesn't
	 * skip elements. Downstream notification is batched across all growths
	 * into a single region: per-cell remeshing and flow-field invalidation
	 * would thrash both systems at these rates.
	 */
	update(dt: number): void {
		if (this.growths.length === 0) return;

		let placed = 0;
		let minBX = Infinity;
		let minBY = Infinity;
		let minBZ = Infinity;
		let maxBX = -Infinity;
		let maxBY = -Infinity;
		let maxBZ = -Infinity;

		for (let i = this.growths.length - 1; i >= 0; i--) {
			const g = this.growths[i];
			g.accumulator += dt * g.profile.cellsPerSecond;
			let budget = Math.floor(g.accumulator);
			g.accumulator -= budget;

			let fizzled = false;
			while (budget > 0 && g.cursor < g.cells.length) {
				const cell = g.cells[g.cursor];
				const bx = cell[0];
				const by = cell[1];
				const bz = cell[2];
				g.cursor++;
				budget--;

				// Occupied, entity-blocked, or inside the player: skip without
				// charging and keep going. Holes are acceptable; stopping at the
				// first obstruction would make spans unusable near clutter.
				if (
					!canPlaceBlock(this.world, this.entityManager, bx, by, bz)
				) {
					continue;
				}
				if (this.callbacks.blockedByPlayer(bx, by, bz)) continue;

				// Charge only for cells that are definitely going to land.
				if (!this.callbacks.spend(g.profile.costPerCell, g.source)) {
					fizzled = true;
					break;
				}

				// Direct rather than via tryPlaceBlock: the rules were just
				// checked by canPlaceBlock, and the flow field is invalidated
				// once for the whole frame below instead of once per cell.
				this.world.setBlock(bx, by, bz, g.profile.blockId);
				placed++;
				if (bx < minBX) minBX = bx;
				if (by < minBY) minBY = by;
				if (bz < minBZ) minBZ = bz;
				if (bx > maxBX) maxBX = bx;
				if (by > maxBY) maxBY = by;
				if (bz > maxBZ) maxBZ = bz;
			}

			if (fizzled || g.cursor >= g.cells.length) {
				const last = this.growths.length - 1;
				if (i !== last) this.growths[i] = this.growths[last];
				this.growths.pop();
			}
		}

		if (placed > 0) {
			this.entityManager.invalidateFlowField();
			this.callbacks.onCellsPlaced(
				minBX,
				minBY,
				minBZ,
				maxBX,
				maxBY,
				maxBZ,
				placed,
			);
		}
	}
}

/**
 * Face-connected voxel line from `from` to `to`, inclusive of both.
 *
 * Steps one axis at a time — the axis whose progress trails its share of the
 * total — so consecutive cells always share a face. A cheaper 8-connected
 * line would place fewer blocks, but its diagonal joints touch only at an
 * edge and leave gaps you can drop through.
 */
export function faceConnectedLine(
	from: VoxelCoord,
	to: VoxelCoord,
): VoxelCoord[] {
	let x = from[0];
	let y = from[1];
	let z = from[2];
	const ax = Math.abs(to[0] - x);
	const ay = Math.abs(to[1] - y);
	const az = Math.abs(to[2] - z);
	const sx = Math.sign(to[0] - x);
	const sy = Math.sign(to[1] - y);
	const sz = Math.sign(to[2] - z);

	const cells: VoxelCoord[] = [[x, y, z]];
	let cx = 0;
	let cy = 0;
	let cz = 0;
	while (cx < ax || cy < ay || cz < az) {
		// Fraction of each axis's travel that stepping it now would complete.
		// Smallest wins, so all three axes advance proportionally.
		const rx = cx < ax ? (cx + 0.5) / ax : Infinity;
		const ry = cy < ay ? (cy + 0.5) / ay : Infinity;
		const rz = cz < az ? (cz + 0.5) / az : Infinity;
		if (rx <= ry && rx <= rz) {
			x += sx;
			cx++;
		} else if (ry <= rz) {
			y += sy;
			cy++;
		} else {
			z += sz;
			cz++;
		}
		cells.push([x, y, z]);
	}
	return cells;
}

/**
 * Bridge: a one-cell-wide span from the impact back to where the player fired.
 *
 * Growing impact-ward-to-player-ward means running out of BP leaves the far
 * portion built and the near portion missing — you watch a finished span you
 * can't reach. That waste is intended: overreaching should cost.
 *
 * Width is a planner concern, not a manager one; a road instead of a tightrope
 * is a change here and nowhere else.
 */
export const bridgePlanner: GrowthPlanner = (ctx) =>
	faceConnectedLine(ctx.cell, ctx.anchor);

/**
 * Cube: a solid block `size` cells on a side, resting against the struck face.
 *
 * Seated entirely clear of the surface along the normal rather than centered
 * on the impact — a cube centered on a cell that is itself solid would bury a
 * whole layer and quietly deliver less than its name promises. Across the
 * face it straddles the impact.
 *
 * Cells are ordered by distance from the cube's own center, so it fills as
 * concentric shells: running dry leaves a smaller cube rather than a lopsided
 * slab, and the ordering needs no special case for any particular size.
 */
export function cubePlanner(size: number): GrowthPlanner {
	if (!Number.isInteger(size) || size < 1) {
		throw new Error(
			`cubePlanner: size must be a positive integer (got ${String(size)})`,
		);
	}
	const lead = Math.floor((size - 1) / 2);
	const mid = (size - 1) / 2;
	return (ctx) => {
		const lo: [number, number, number] = [0, 0, 0];
		for (let a = 0; a < 3; a++) {
			const n = ctx.normal[a];
			if (n > 0) lo[a] = ctx.cell[a] + 1;
			else if (n < 0) lo[a] = ctx.cell[a] - size;
			else lo[a] = ctx.cell[a] - lead;
		}
		const cx = lo[0] + mid;
		const cy = lo[1] + mid;
		const cz = lo[2] + mid;
		const cells: VoxelCoord[] = [];
		for (let x = 0; x < size; x++) {
			for (let y = 0; y < size; y++) {
				for (let z = 0; z < size; z++) {
					cells.push([lo[0] + x, lo[1] + y, lo[2] + z]);
				}
			}
		}
		cells.sort(
			(a, b) =>
				squaredDistance(a, cx, cy, cz) - squaredDistance(b, cx, cy, cz),
		);
		return cells;
	};
}

function squaredDistance(
	cell: VoxelCoord,
	x: number,
	y: number,
	z: number,
): number {
	const dx = cell[0] - x;
	const dy = cell[1] - y;
	const dz = cell[2] - z;
	return dx * dx + dy * dy + dz * dz;
}

/**
 * Face the projectile entered `cell` through, written into `out` as a unit
 * axis vector.
 *
 * Exact when the pre-step cell differs from the impact cell on a single axis,
 * which is the ordinary case for a hitbox around a block or smaller. Wider
 * hitboxes can report an impact cell diagonally off the pre-step cell; there
 * the dominant travel axis is the best available answer.
 */
export function deriveImpactNormal(
	fromX: number,
	fromY: number,
	fromZ: number,
	cellX: number,
	cellY: number,
	cellZ: number,
	velocity: Float32Array,
	out: [number, number, number],
): void {
	const dx = cellX - fromX;
	const dy = cellY - fromY;
	const dz = cellZ - fromZ;
	const axes = (dx !== 0 ? 1 : 0) + (dy !== 0 ? 1 : 0) + (dz !== 0 ? 1 : 0);
	if (axes === 1) {
		out[0] = -Math.sign(dx);
		out[1] = -Math.sign(dy);
		out[2] = -Math.sign(dz);
		return;
	}
	const vx = Math.abs(velocity[0]);
	const vy = Math.abs(velocity[1]);
	const vz = Math.abs(velocity[2]);
	out[0] = 0;
	out[1] = 0;
	out[2] = 0;
	if (vx >= vy && vx >= vz) out[0] = -Math.sign(velocity[0]);
	else if (vy >= vz) out[1] = -Math.sign(velocity[1]);
	else out[2] = -Math.sign(velocity[2]);
}
