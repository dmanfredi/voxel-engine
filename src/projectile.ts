/**
 * Projectile types — pure data definitions for the mining system.
 *
 * Runtime behavior (spawn, tick, collision, dispose) lives in
 * `projectile-manager.ts`. This file is the type contract that
 * Tools, ProjectileProfiles, and Hitboxes share.
 *
 * Hardness/strength rule (encoded in ProjectileManager, surfaced here
 * only by `strength`):
 * - Sweep-break: every solid cell the hitbox overlaps in a tick breaks — a
 *   projectile never stops without destroying what it touches.
 * - Strength decrements by each broken block's hardness. The whole tick's
 *   overlap breaks before the strength ≤ 0 check, so strength is a soft cap
 *   that rounds up to the last full sweep rather than cutting a slice short.
 * - Disposes when: (a) strength ≤ 0 after a sweep, (b) age exceeds
 *   maxLifetime.
 */

import type { Tool } from './tool';
import type { TimingFunction } from './timing';

export type VoxelCoord = readonly [number, number, number];

/**
 * What a projectile does on contact. Motion (spawn, timing curve, sub-stepping,
 * wrap, lifetime) is identical across every effect; only the contact
 * resolution differs, and it differs enough to need different queries — Mine
 * consumes the whole overlap set, Build needs the single first cell along
 * travel.
 */
export enum ProjectileEffect {
	/** Sweep-break every overlapped cell; `strength` gates penetration depth. */
	Mine,
	/**
	 * Stop dead at the first solid contact and hand the impact to the growth
	 * system. `strength` is unread — a build projectile carries no mining
	 * budget, it just needs to arrive.
	 */
	Build,
}

/** Upper bound on cells one query may report; sizes the caller's scratch. */
export const MAX_HITBOX_CELLS = 256;

/**
 * A projectile's collision shape. One Hitbox is shared across every
 * projectile of a profile, so `cellsAt` must not retain per-call state that
 * outlives the call.
 *
 * Allocation-free contract: `cellsAt` writes the overlapped voxel cells into
 * the caller's `out` buffer as flat x,y,z triples and returns the cell count
 * — it never allocates a per-call array. `out` must hold at least
 * 3·MAX_HITBOX_CELLS ints. Cells are unordered: the consumer sweep-breaks
 * every solid one, so no ranking is needed.
 */
export interface Hitbox {
	cellsAt(
		position: Float32Array,
		orientation: Float32Array,
		blockSize: number,
		out: Int32Array,
	): number;
}

/**
 * One oriented box of a compound hitbox, in the projectile's local frame
 * (axes: right, up, forward), world units. A shape is a convex decomposition
 * into these boxes — a slab is one box, an arc a handful.
 */
export interface LocalBox {
	/** Center offset from the projectile origin along local right/up/forward. */
	offset: readonly [number, number, number];
	/** Half-extents along local right, up, forward. */
	half: readonly [number, number, number];
}

/**
 * Hitbox as a union of oriented boxes, each rasterized against the voxel grid
 * via SAT and merged into the overlapped-cell set. Analytic rather than an
 * integer voxel mask, so it stays exact at any orientation — a rotated box
 * rasterizes cleanly where a rotated mask would alias into holes. Non-convex
 * shapes fall out of the union of convex boxes.
 *
 * Fully allocation-free and stateless: cellsAt writes into the caller's
 * buffer and retains nothing across calls.
 */
export function compoundHitbox(boxes: readonly LocalBox[]): Hitbox {
	// A single box's nested loops already emit distinct cells; only a
	// multi-box union can revisit a cell at a seam, so dedup is skipped
	// entirely for the common one-box case.
	const single = boxes.length === 1;

	return {
		cellsAt(position, orientation, blockSize, out) {
			const rx = orientation[0];
			const ry = orientation[1];
			const rz = orientation[2];
			const ux = orientation[4];
			const uy = orientation[5];
			const uz = orientation[6];
			const fx = orientation[8];
			const fy = orientation[9];
			const fz = orientation[10];
			const hb = blockSize * 0.5;

			let count = 0;
			let full = false;

			for (let b = 0; b < boxes.length && !full; b++) {
				const box = boxes[b];
				const ox = box.offset[0];
				const oy = box.offset[1];
				const oz = box.offset[2];
				const hr = box.half[0];
				const hu = box.half[1];
				const hf = box.half[2];

				// Box center in world = projectile position + orientation·offset.
				const bcx = position[0] + rx * ox + ux * oy + fx * oz;
				const bcy = position[1] + ry * ox + uy * oy + fy * oz;
				const bcz = position[2] + rz * ox + uz * oy + fz * oz;

				// World-AABB of the rotated box → candidate cell range.
				const aabbHX =
					hr * Math.abs(rx) + hu * Math.abs(ux) + hf * Math.abs(fx);
				const aabbHY =
					hr * Math.abs(ry) + hu * Math.abs(uy) + hf * Math.abs(fy);
				const aabbHZ =
					hr * Math.abs(rz) + hu * Math.abs(uz) + hf * Math.abs(fz);
				const xMin = Math.floor((bcx - aabbHX) / blockSize);
				const xMax = Math.floor((bcx + aabbHX) / blockSize);
				const yMin = Math.floor((bcy - aabbHY) / blockSize);
				const yMax = Math.floor((bcy + aabbHY) / blockSize);
				const zMin = Math.floor((bcz - aabbHZ) / blockSize);
				const zMax = Math.floor((bcz + aabbHZ) / blockSize);

				for (let x = xMin; x <= xMax && !full; x++) {
					for (let y = yMin; y <= yMax && !full; y++) {
						for (let z = zMin; z <= zMax; z++) {
							const ccx = (x + 0.5) * blockSize;
							const ccy = (y + 0.5) * blockSize;
							const ccz = (z + 0.5) * blockSize;
							if (
								!satOverlap(
									ccx - bcx,
									ccy - bcy,
									ccz - bcz,
									rx,
									ry,
									rz,
									ux,
									uy,
									uz,
									fx,
									fy,
									fz,
									hr,
									hu,
									hf,
									hb,
								)
							) {
								continue;
							}

							if (!single) {
								let dup = false;
								for (let k = 0; k < count; k++) {
									if (
										out[3 * k] === x &&
										out[3 * k + 1] === y &&
										out[3 * k + 2] === z
									) {
										dup = true;
										break;
									}
								}
								if (dup) continue;
							}

							// Capacity guard: never-hit safety net for a pathologically
							// large shape. Stop cleanly rather than silently no-op the
							// out-of-range typed-array writes.
							if (count >= MAX_HITBOX_CELLS) {
								full = true;
								break;
							}

							out[3 * count] = x;
							out[3 * count + 1] = y;
							out[3 * count + 2] = z;
							count++;
						}
					}
				}
			}

			return count;
		},
	};
}

/**
 * Single centered box of uniform half-extent — the one-box compound, kept as
 * a convenience for cube-shaped projectiles.
 */
export function obbHitbox(halfSize: number): Hitbox {
	return compoundHitbox([
		{ offset: [0, 0, 0], half: [halfSize, halfSize, halfSize] },
	]);
}

/**
 * SAT overlap test: an oriented box (local axes r,u,f; per-axis half-extents
 * hr,hu,hf) vs an axis-aligned voxel cell whose center is offset by
 * (dx,dy,dz) from the box center, cell half-extent `hb`. Returns true iff no
 * separating axis exists. Fully inlined to avoid temp vec3 allocations.
 *
 * SAT uses 15 axes: 3 box local axes, 3 world axes, 9 cross products.
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
	hr: number,
	hu: number,
	hf: number,
	hb: number,
): boolean {
	// 3 box axes
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
			hr,
			hu,
			hf,
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
			hr,
			hu,
			hf,
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
			hr,
			hu,
			hf,
			hb,
		)
	)
		return false;

	// 3 world axes
	if (
		testAxis(
			dx,
			dy,
			dz,
			1,
			0,
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
			hr,
			hu,
			hf,
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
			1,
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
			hr,
			hu,
			hf,
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
			0,
			1,
			rx,
			ry,
			rz,
			ux,
			uy,
			uz,
			fx,
			fy,
			fz,
			hr,
			hu,
			hf,
			hb,
		)
	)
		return false;

	// 9 cross products of box axes × world axes (r×, u×, f× each world axis)
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
			hr,
			hu,
			hf,
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
			hr,
			hu,
			hf,
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
			hr,
			hu,
			hf,
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
			hr,
			hu,
			hf,
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
			hr,
			hu,
			hf,
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
			hr,
			hu,
			hf,
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
			hr,
			hu,
			hf,
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
			hr,
			hu,
			hf,
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
			hr,
			hu,
			hf,
			hb,
		)
	)
		return false;

	return true;
}

/**
 * SAT axis test: true iff (ax,ay,az) separates the box from the cell.
 * Zero-length axes (crosses of parallel vectors) self-skip — their extent
 * sums are 0 on both sides, so the strict inequality fails.
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
	hr: number,
	hu: number,
	hf: number,
	hb: number,
): boolean {
	const obbExtent =
		hr * Math.abs(rx * ax + ry * ay + rz * az) +
		hu * Math.abs(ux * ax + uy * ay + uz * az) +
		hf * Math.abs(fx * ax + fy * ay + fz * az);
	const cellExtent = hb * (Math.abs(ax) + Math.abs(ay) + Math.abs(az));
	const dist = Math.abs(dx * ax + dy * ay + dz * az);
	return dist > obbExtent + cellExtent;
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
 * Resolves a shooter's forward vector into the direction a projectile travels,
 * writing the unit result into `out` and returning false to reject the shot. A
 * null constraint on a profile means "fire straight down the aim ray".
 */
export type AimConstraint = (
	aimDir: Float32Array,
	out: Float32Array,
) => boolean;

/**
 * Fire only when the aim falls within `slackDeg` of one of the six axes,
 * snapping to that exact axis so constrained projectiles stay grid-aligned;
 * otherwise reject the shot.
 */
export function cardinalLock(slackDeg: number): AimConstraint {
	const minDot = Math.cos((slackDeg * Math.PI) / 180);
	return (aimDir, out) => {
		const x = aimDir[0];
		const y = aimDir[1];
		const z = aimDir[2];
		// Nearest axis = the largest-magnitude component. For a unit aimDir
		// that magnitude is cos(angle to the axis), so it compares directly
		// against the cone's cos threshold.
		const ax = Math.abs(x);
		const ay = Math.abs(y);
		const az = Math.abs(z);
		let dot: number;
		if (ax >= ay && ax >= az) {
			dot = ax;
			out[0] = Math.sign(x);
			out[1] = 0;
			out[2] = 0;
		} else if (ay >= az) {
			dot = ay;
			out[0] = 0;
			out[1] = Math.sign(y);
			out[2] = 0;
		} else {
			dot = az;
			out[0] = 0;
			out[1] = 0;
			out[2] = Math.sign(z);
		}
		return dot >= minDot;
	};
}

/**
 * Template for a class of projectiles. Frozen at design time and shared
 * across spawns — spawning fills in origin/direction on a Projectile
 * instance and keeps a reference to the profile.
 */
export interface ProjectileProfile {
	/** Contact resolution. Determines which manager branch runs on overlap. */
	effect: ProjectileEffect;
	/** Initial strength; decrements by `block.hardness` on each break. */
	strength: number;
	/** Average travel speed across a complete normalized timing curve. */
	speed: number;
	/** Normalized age → normalized distance; must be monotonic from 0 to 1. */
	timing: TimingFunction;
	/** Collision shape. Stateless and shareable across instances. */
	hitbox: Hitbox;
	/** Seconds before the projectile disposes if nothing kills it first. */
	maxLifetime: number;
	/**
	 * Edge lengths [right, up, forward] applied as a non-uniform scale to the
	 * renderer's [-1,1] cube, so the drawn box is visualSize long on each
	 * local axis. Should match the hitbox extents (half = visualSize/2) so
	 * what you see is what hits. When per-profile meshes land this becomes a
	 * richer `{ mesh, color, ... }` visual struct.
	 */
	visualSize: readonly [number, number, number];
	/**
	 * Muzzle offset from the shooter, in shooter-local axes
	 * [right, up, forward], world units. Scales with the projectile rather
	 * than the shooter: a wide slab has to clear the view by more than a small
	 * bolt does, which is why it rides here and not on whatever fires it.
	 */
	spawnOffset: Float32Array;
	/**
	 * Optional aim resolver; null fires straight down the aim ray. A
	 * constraint can snap the direction (e.g. cardinal lock) or reject the
	 * shot, in which case the fire path bails without spending cooldown or
	 * cost. A property of the hitbox's shape — a tall constrained box wants
	 * grid-aligned lanes whatever is holding it.
	 */
	aimConstraint: AimConstraint | null;
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
	 * are the first three columns. Computed at spawn from velocity;
	 * constant for the projectile's lifetime — no spin or trajectory
	 * bending.
	 */
	orientation: Float32Array;
	/** Current strength; consumed by hardness on each break. */
	strength: number;
	/** Seconds since spawn. Compared against `profile.maxLifetime`. */
	age: number;
	/**
	 * The tool that spawned this projectile. Carried so the break callback
	 * can dispatch per-tool effects (BP payout, FX, sounds). The manager
	 * never reads tool fields itself — opaque pass-through.
	 */
	sourceTool: Tool;
	/**
	 * Cell a Build-effect impact should plan back toward — the player's foot
	 * cell captured at launch, so a span meets where they fired from rather
	 * than where they have drifted to since. Null on Mine projectiles.
	 *
	 * Captured at the feet rather than at the visual spawn point: the muzzle
	 * sits near chest height, and a span terminating there would be neither
	 * walkable nor placeable (the player's own AABB blocks those cells).
	 */
	buildAnchor: VoxelCoord | null;
}
