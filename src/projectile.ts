/**
 * Projectile types — pure data definitions for the mining system.
 *
 * Runtime behavior (spawn, tick, collision, dispose) lives in
 * `projectile-manager.ts`. This file is the type contract that
 * Tools, ProjectileProfiles, and Hitboxes share.
 *
 * Hardness/strength rule (encoded in ProjectileManager, surfaced here
 * only by `strength` + `firstHit`):
 * - First block hit ALWAYS breaks regardless of strength vs. hardness.
 *   Strength decrements by hardness anyway (the freebie still costs).
 * - Subsequent blocks break iff `strength > hardness`. Same decrement.
 * - Projectile disposes when: (a) strength ≤ 0 after a break,
 *   (b) it hits a block it can't break, (c) age exceeds maxLifetime.
 */

import type { Tool } from './tool';

export type VoxelCoord = readonly [number, number, number];

/**
 * A projectile's collision shape. Stateless: given position + orientation,
 * returns the voxel cells the hitbox currently overlaps, ordered
 * "leading-edge first" — the cell furthest along the projectile's forward
 * direction (column 2 of orientation) at index 0.
 *
 * Consumers iterate the returned list and process the first SOLID cell
 * (skipping over air); see ProjectileManager.update. Multiple cells with
 * tied forward projection are common for wide hitboxes — the ordering
 * only meaningfully ranks cells along the direction of travel, so
 * iterate-until-solid keeps a side-clipping cell from being lost to an
 * air cell that happened to win an arbitrary tiebreaker.
 *
 * `orientation` is a 4×4 column-major matrix; its third column is the
 * projectile's forward vector in world space.
 */
export interface Hitbox {
	cellsAt(
		position: Float32Array,
		orientation: Float32Array,
		blockSize: number,
	): VoxelCoord[];
}

/**
 * Oriented bounding box hitbox of half-extent `halfSize` in world units,
 * rotated by the projectile's orientation matrix. The box's local axes
 * are the columns of `orientation`.
 *
 * Returns every voxel cell the rotated box overlaps, sorted leading-edge
 * first along the projectile's forward direction.
 *
 * Algorithm:
 * 1. Compute the world-AABB of the rotated box to enumerate candidate cells.
 * 2. For each candidate, SAT-test the OBB against the cell (axis-aligned
 *    unit voxel). Cell is included iff no separating axis exists.
 * 3. Sort by leading-edge projection.
 *
 * SAT uses 15 axes: 3 OBB local axes, 3 world axes, 9 cross products.
 * Constant time per cell (~50 ops worst case). For halfSize < blockSize,
 * the world-AABB spans 1-8 cells, so total per-call work is ≤ ~400 ops.
 */
export function obbHitbox(halfSize: number): Hitbox {
	return {
		cellsAt(position, orientation, blockSize) {
			// OBB local axes: right, up, forward (columns 0, 1, 2).
			const rx = orientation[0];
			const ry = orientation[1];
			const rz = orientation[2];
			const ux = orientation[4];
			const uy = orientation[5];
			const uz = orientation[6];
			const fx = orientation[8];
			const fy = orientation[9];
			const fz = orientation[10];

			// World-AABB half-extents: project the OBB's three half-extent
			// vectors onto each world axis and sum absolute values.
			const aabbHX =
				halfSize * (Math.abs(rx) + Math.abs(ux) + Math.abs(fx));
			const aabbHY =
				halfSize * (Math.abs(ry) + Math.abs(uy) + Math.abs(fy));
			const aabbHZ =
				halfSize * (Math.abs(rz) + Math.abs(uz) + Math.abs(fz));

			const xMin = Math.floor((position[0] - aabbHX) / blockSize);
			const xMax = Math.floor((position[0] + aabbHX) / blockSize);
			const yMin = Math.floor((position[1] - aabbHY) / blockSize);
			const yMax = Math.floor((position[1] + aabbHY) / blockSize);
			const zMin = Math.floor((position[2] - aabbHZ) / blockSize);
			const zMax = Math.floor((position[2] + aabbHZ) / blockSize);

			const hb = blockSize * 0.5;
			const cells: VoxelCoord[] = [];
			const projs: number[] = [];

			for (let x = xMin; x <= xMax; x++) {
				for (let y = yMin; y <= yMax; y++) {
					for (let z = zMin; z <= zMax; z++) {
						const ccx = (x + 0.5) * blockSize;
						const ccy = (y + 0.5) * blockSize;
						const ccz = (z + 0.5) * blockSize;
						const dx = ccx - position[0];
						const dy = ccy - position[1];
						const dz = ccz - position[2];
						if (
							satOverlap(
								dx,
								dy,
								dz,
								rx,
								ry,
								rz,
								ux,
								uy,
								uz,
								fx,
								fy,
								fz,
								halfSize,
								hb,
							)
						) {
							cells.push([x, y, z]);
							projs.push(dx * fx + dy * fy + dz * fz);
						}
					}
				}
			}

			insertionSortByProj(cells, projs);
			return cells;
		},
	};
}

/**
 * SAT overlap test: OBB (centered at origin in projectile-local space)
 * vs. axis-aligned voxel cell whose center is offset by (dx,dy,dz)
 * from the projectile center.
 *
 * OBB local axes are (r, u, f); OBB half-extent is `h` (uniform). Cell
 * half-extent is `hb` (= blockSize/2). All math inlined to avoid temp
 * vec3 allocations in a hot path.
 *
 * Returns true iff no separating axis exists (i.e., shapes overlap).
 */
function satOverlap(
	dx: number,
	dy: number,
	dz: number,
	rx: number,
	ry: number,
	rz: number,
	ux: number,
	uy: number,
	uz: number,
	fx: number,
	fy: number,
	fz: number,
	h: number,
	hb: number,
): boolean {
	// 3 OBB axes
	if (
		testAxis(
			dx,
			dy,
			dz,
			rx,
			ry,
			rz,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			h,
			hb,
		)
	)
		return false;
	if (
		testAxis(
			dx,
			dy,
			dz,
			ux,
			uy,
			uz,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			h,
			hb,
		)
	)
		return false;
	if (
		testAxis(
			dx,
			dy,
			dz,
			fx,
			fy,
			fz,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			h,
			hb,
		)
	)
		return false;

	// 3 world axes (1,0,0), (0,1,0), (0,0,1)
	if (
		testAxis(dx, dy, dz, 1, 0, 0, rx, ry, rz, ux, uy, uz, fx, fy, fz, h, hb)
	)
		return false;
	if (
		testAxis(dx, dy, dz, 0, 1, 0, rx, ry, rz, ux, uy, uz, fx, fy, fz, h, hb)
	)
		return false;
	if (
		testAxis(dx, dy, dz, 0, 0, 1, rx, ry, rz, ux, uy, uz, fx, fy, fz, h, hb)
	)
		return false;

	// 9 cross products of OBB axes × world axes
	// r × (1,0,0) = (0, rz, -ry), etc.
	if (
		testAxis(
			dx,
			dy,
			dz,
			0,
			rz,
			-ry,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			h,
			hb,
		)
	)
		return false;
	if (
		testAxis(
			dx,
			dy,
			dz,
			-rz,
			0,
			rx,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			h,
			hb,
		)
	)
		return false;
	if (
		testAxis(
			dx,
			dy,
			dz,
			ry,
			-rx,
			0,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			h,
			hb,
		)
	)
		return false;
	if (
		testAxis(
			dx,
			dy,
			dz,
			0,
			uz,
			-uy,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			h,
			hb,
		)
	)
		return false;
	if (
		testAxis(
			dx,
			dy,
			dz,
			-uz,
			0,
			ux,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			h,
			hb,
		)
	)
		return false;
	if (
		testAxis(
			dx,
			dy,
			dz,
			uy,
			-ux,
			0,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			h,
			hb,
		)
	)
		return false;
	if (
		testAxis(
			dx,
			dy,
			dz,
			0,
			fz,
			-fy,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			h,
			hb,
		)
	)
		return false;
	if (
		testAxis(
			dx,
			dy,
			dz,
			-fz,
			0,
			fx,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			h,
			hb,
		)
	)
		return false;
	if (
		testAxis(
			dx,
			dy,
			dz,
			fy,
			-fx,
			0,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			h,
			hb,
		)
	)
		return false;

	return true;
}

/**
 * SAT axis test: returns true iff (ax,ay,az) is a separating axis.
 * Zero-length axes (cross of parallel vectors) are skipped automatically
 * — their projection sum is 0 on both sides, so the inequality fails.
 */
function testAxis(
	dx: number,
	dy: number,
	dz: number,
	ax: number,
	ay: number,
	az: number,
	rx: number,
	ry: number,
	rz: number,
	ux: number,
	uy: number,
	uz: number,
	fx: number,
	fy: number,
	fz: number,
	h: number,
	hb: number,
): boolean {
	const obbExtent =
		h *
		(Math.abs(rx * ax + ry * ay + rz * az) +
			Math.abs(ux * ax + uy * ay + uz * az) +
			Math.abs(fx * ax + fy * ay + fz * az));
	const cellExtent = hb * (Math.abs(ax) + Math.abs(ay) + Math.abs(az));
	const dist = Math.abs(dx * ax + dy * ay + dz * az);
	return dist > obbExtent + cellExtent;
}

/** In-place insertion sort of parallel cells/projs arrays, descending by proj. */
function insertionSortByProj(cells: VoxelCoord[], projs: number[]): void {
	for (let i = 1; i < cells.length; i++) {
		const cell = cells[i];
		const p = projs[i];
		let j = i - 1;
		while (j >= 0 && projs[j] < p) {
			cells[j + 1] = cells[j];
			projs[j + 1] = projs[j];
			j--;
		}
		cells[j + 1] = cell;
		projs[j + 1] = p;
	}
}

// prettier-ignore
const IDENTITY_4X4 = new Float32Array([
	1, 0, 0, 0,
	0, 1, 0, 0,
	0, 0, 1, 0,
	0, 0, 0, 1,
]);

/**
 * Build a 4×4 column-major rotation matrix that aligns the local +Z axis
 * with `direction`. Used at spawn to compute a projectile's orientation
 * from its velocity.
 *
 * Reference up is world-Y; falls back to world-X when forward is too
 * close to vertical (otherwise cross product is degenerate).
 *
 * Writes into `out` to avoid allocation. Caller owns `out`.
 */
export function orientationFromDirection(
	direction: Float32Array,
	out: Float32Array,
): void {
	const dx = direction[0];
	const dy = direction[1];
	const dz = direction[2];
	const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
	if (len < 1e-6) {
		// Degenerate: zero velocity → identity orientation.
		out.set(IDENTITY_4X4);
		return;
	}
	const fx = dx / len;
	const fy = dy / len;
	const fz = dz / len;

	// Reference up: world Y unless forward is near-vertical, then world X.
	const nearVertical = Math.abs(fy) > 0.99;
	const upRefX = nearVertical ? 1 : 0;
	const upRefY = nearVertical ? 0 : 1;

	// right = normalize(cross(refUp, forward)) — order chosen so that with
	// forward=+Z and refUp=+Y, right comes out as +X (standard RH frame).
	const crx = upRefY * fz - 0 * fy;
	const cry = 0 * fx - upRefX * fz;
	const crz = upRefX * fy - upRefY * fx;
	const rLen = Math.sqrt(crx * crx + cry * cry + crz * crz);
	const rx = crx / rLen;
	const ry = cry / rLen;
	const rz = crz / rLen;

	// up = cross(forward, right) — already unit since fwd ⊥ right.
	const ux = fy * rz - fz * ry;
	const uy = fz * rx - fx * rz;
	const uz = fx * ry - fy * rx;

	// Columns: right, up, forward, translation (zero).
	out[0] = rx;
	out[1] = ry;
	out[2] = rz;
	out[3] = 0;
	out[4] = ux;
	out[5] = uy;
	out[6] = uz;
	out[7] = 0;
	out[8] = fx;
	out[9] = fy;
	out[10] = fz;
	out[11] = 0;
	out[12] = 0;
	out[13] = 0;
	out[14] = 0;
	out[15] = 1;
}

/**
 * Template for a class of projectiles. Frozen at design time and shared
 * across spawns — spawning fills in origin/direction on a Projectile
 * instance and keeps a reference to the profile.
 */
export interface ProjectileProfile {
	/** Initial strength; decrements by `block.hardness` on each break. */
	strength: number;
	/** Travel speed in world units per second. */
	speed: number;
	/** Collision shape. Stateless and shareable across instances. */
	hitbox: Hitbox;
	/** Seconds before the projectile disposes if nothing kills it first. */
	maxLifetime: number;
	/**
	 * Edge length applied as a uniform scale to the renderer's unit-cube
	 * mesh. For v1 every projectile renders as a cube of this size; when
	 * per-profile meshes land, this becomes a richer `{ mesh, color, ... }`
	 * visual struct. Should usually match the hitbox size so what you see
	 * is what hits.
	 */
	visualSize: number;
}

/**
 * Live projectile instance. Owned by ProjectileManager; do not construct
 * directly — go through `manager.spawn()`.
 */
export interface Projectile {
	profile: ProjectileProfile;
	position: Float32Array;
	velocity: Float32Array;
	/**
	 * 4×4 column-major rotation matrix. Local axes (right, up, forward)
	 * are the first three columns. Computed at spawn from velocity; constant
	 * for the projectile's lifetime (v1 has no spin or trajectory bending).
	 */
	orientation: Float32Array;
	/** Current strength; consumed by hardness on each break. */
	strength: number;
	/** Seconds since spawn. Compared against `profile.maxLifetime`. */
	age: number;
	/**
	 * True until the projectile has successfully broken a block. Implements
	 * the "first block always breaks" freebie. Cleared on the first break.
	 */
	firstHit: boolean;
	/**
	 * The tool that spawned this projectile. Carried so the break callback
	 * can dispatch per-tool effects (BP payout, FX, sounds). The manager
	 * never reads tool fields itself — opaque pass-through.
	 */
	sourceTool: Tool;
}
