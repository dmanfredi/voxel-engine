/**
 * Cube physics — gravity + axis-separated AABB-vs-voxel collision, plus
 * the tipping primitive (rotation about an edge to a destination cell).
 *
 * Cubes don't bounce; axis velocity zeros on contact (platform/obstacle
 * intent). Sphere-vs-cube lives in `entity-interactions.ts`.
 *
 * EntityManager dispatches between physics and tip animation each frame
 * based on whether `entity.tip` is null.
 */

import { mat4 } from 'wgpu-matrix';
import { CHUNK_SIZE } from './chunk';
import { Shape } from './entity';
import type { World } from './world';
import type { Entity } from './entity';
import {
	MC_TICK,
	GRAVITY,
	TERMINAL_VELOCITY,
	NEGLIGIBLE,
} from './entity-physics-shared';

/**
 * Mid-tip animation state. Position is snapped to the destination cell at
 * tip start; the render transform arcs the cube back through its pre-tip
 * pose to the destination using the stored pivot/offset/axis.
 *
 *   M = T(pivot) · R(axis, progress·endAngle) · T(sourceOffset) · baseOrientation · S(scale)
 *
 * `endAngle` is π/2 for horizontal tips, π for climbs (handspring around the
 * shared top-forward edge). Geometry differs only in pivot Y offset,
 * sourceOffset Y, and endAngle.
 */
export interface TipState {
	progress: number; // 0..1 over entity.tipDuration seconds
	pivot: Float32Array<ArrayBuffer>; // vec3, world-space pivot edge midpoint
	sourceOffset: Float32Array<ArrayBuffer>; // vec3, sourceCenter − pivot
	axis: Float32Array<ArrayBuffer>; // vec3, unit rotation axis
	endAngle: number; // radians at progress=1 (π/2 horizontal, π climb)
	baseOrientation: Float32Array<ArrayBuffer>; // mat4, orientation at tip start
}

/**
 * Gravity + axis-separated AABB-vs-voxel collision. Velocity along contact
 * axis zeros (no bounce). AABB half-extent = `entity.scale` on all axes.
 */
export function entityCubePhysicsTick(
	entity: Entity,
	world: World,
	dt: number,
): void {
	const t = dt / MC_TICK;

	entity.vy -= GRAVITY * t;
	if (entity.vy < TERMINAL_VELOCITY) entity.vy = TERMINAL_VELOCITY;

	if (Math.abs(entity.vx) < NEGLIGIBLE * t) entity.vx = 0;
	if (Math.abs(entity.vz) < NEGLIGIBLE * t) entity.vz = 0;

	entity.grounded = false;

	const s = entity.scale;
	const blockSize = world.blockSize;

	// X → Z → Y resolution order mirrors the player's moveAndCollide. Each
	// axis integrates, then snaps back if the swept AABB lands inside solid.
	const dx = entity.vx * t;
	if (dx !== 0) {
		entity.x += dx;
		if (resolveCubeAxis(entity, world, blockSize, s, 0, Math.sign(dx))) {
			entity.vx = 0;
		}
	}

	const dz = entity.vz * t;
	if (dz !== 0) {
		entity.z += dz;
		if (resolveCubeAxis(entity, world, blockSize, s, 2, Math.sign(dz))) {
			entity.vz = 0;
		}
	}

	const dy = entity.vy * t;
	if (dy !== 0) {
		entity.y += dy;
		const dir = Math.sign(dy);
		if (resolveCubeAxis(entity, world, blockSize, s, 1, dir)) {
			if (dir < 0) entity.grounded = true;
			entity.vy = 0;
		}
	}

	const ww = world.widthChunks * CHUNK_SIZE * blockSize;
	entity.x = ((entity.x % ww) + ww) % ww;
	entity.z = ((entity.z % ww) + ww) % ww;
}

/**
 * Resolve cube AABB vs voxel grid on one axis. On overlap, snaps to the
 * contact face of the nearest blocking cell and returns true.
 * `axis`: 0=x, 1=y, 2=z; `direction`: sign of motion.
 */
function resolveCubeAxis(
	entity: Entity,
	world: World,
	blockSize: number,
	s: number,
	axis: number,
	direction: number,
): boolean {
	const minX = entity.x - s;
	const maxX = entity.x + s;
	const minY = entity.y - s;
	const maxY = entity.y + s;
	const minZ = entity.z - s;
	const maxZ = entity.z + s;

	const bxMin = Math.floor(minX / blockSize);
	const bxMax = Math.floor((maxX - 1e-6) / blockSize);
	const byMin = Math.floor(minY / blockSize);
	const byMax = Math.floor((maxY - 1e-6) / blockSize);
	const bzMin = Math.floor(minZ / blockSize);
	const bzMax = Math.floor((maxZ - 1e-6) / blockSize);

	let collided = false;
	let best = direction > 0 ? Infinity : -Infinity;

	for (let bx = bxMin; bx <= bxMax; bx++) {
		for (let by = byMin; by <= byMax; by++) {
			for (let bz = bzMin; bz <= bzMax; bz++) {
				if (!world.isSolid(bx, by, bz)) continue;
				collided = true;
				const b = axis === 0 ? bx : axis === 1 ? by : bz;
				if (direction > 0) {
					if (b < best) best = b;
				} else if (b > best) best = b;
			}
		}
	}

	if (!collided) return false;

	const snap =
		direction > 0 ? best * blockSize - s : (best + 1) * blockSize + s;
	if (axis === 0) entity.x = snap;
	else if (axis === 1) entity.y = snap;
	else entity.z = snap;
	return true;
}

/**
 * Kick off a tip. Returns false (with warn) if destination cells aren't
 * all air, or no ground beneath the destination footprint (no pivot edge).
 * Rejects non-cubes and already-tipping cubes silently.
 *
 * `direction = [dx, dy, dz]`:
 *   - dy=0, axis-aligned (dx,dz) → 90° horizontal walk
 *   - dy=+1, axis-aligned (dx,dz) → 180° climb (handspring onto wall)
 *
 * On success: position snaps to destination, velocity zeros, `entity.tip`
 * populated. Mid-tip collision is deferred (see notes/cube-enemy.md).
 */
export function startCubeTip(
	entity: Entity,
	world: World,
	direction: [number, number, number],
): boolean {
	if (entity.shape !== Shape.Cube) return false;
	if (entity.tip !== null) return false;

	const [dx, dy, dz] = direction;
	const blockSize = world.blockSize;
	const s = entity.scale;
	const edge = 2 * s;
	const nVox = Math.round(edge / blockSize);

	// Destination center: one edge forward (and up, for climbs).
	const destX = entity.x + dx * edge;
	const destY = entity.y + dy * edge;
	const destZ = entity.z + dz * edge;

	// Feasibility: destination cells all air, ground beneath them (pivot
	// edge must be a real block corner — wall top for climbs, floor for walks).
	const dMinBX = Math.floor((destX - s) / blockSize);
	const dMinBY = Math.floor((destY - s) / blockSize);
	const dMinBZ = Math.floor((destZ - s) / blockSize);
	for (let ix = 0; ix < nVox; ix++) {
		for (let iy = 0; iy < nVox; iy++) {
			for (let iz = 0; iz < nVox; iz++) {
				if (world.isSolid(dMinBX + ix, dMinBY + iy, dMinBZ + iz)) {
					console.warn(
						`cube tip blocked: destination cell (${String(dMinBX + ix)}, ${String(dMinBY + iy)}, ${String(dMinBZ + iz)}) is solid`,
					);
					return false;
				}
			}
		}
	}
	for (let ix = 0; ix < nVox; ix++) {
		for (let iz = 0; iz < nVox; iz++) {
			if (!world.isSolid(dMinBX + ix, dMinBY - 1, dMinBZ + iz)) {
				console.warn(
					`cube tip blocked: no ground beneath destination at (${String(dMinBX + ix)}, ${String(dMinBY - 1)}, ${String(dMinBZ + iz)})`,
				);
				return false;
			}
		}
	}

	// Pivot edge: bottom-forward of source for horizontal (dy=0); top-forward
	// (shared with wall's top-back edge) for climb (dy=1).
	// sourceOffset = sourceCenter − pivot.
	const pivotYOffset = dy === 0 ? -s : s;
	const pivotX = entity.x + dx * s;
	const pivotY = entity.y + pivotYOffset;
	const pivotZ = entity.z + dz * s;
	const sourceOffset = new Float32Array([-dx * s, -pivotYOffset, -dz * s]);

	// Axis = cross(up, direction) = (dz, 0, −dx) — runs along the pivot edge
	// in both cases. Only endAngle changes.
	const axis = new Float32Array([dz, 0, -dx]);
	const endAngle = dy === 0 ? Math.PI / 2 : Math.PI;

	// Snapshot into a fresh buffer — stored matrix is immutable thereafter.
	const baseOrientation = new Float32Array(entity.orientation);

	// Snap to destination up-front: physics stays grid-aligned and pair
	// collision sees a stable post-tip position.
	entity.x = destX;
	entity.y = destY;
	entity.z = destZ;
	entity.vx = 0;
	entity.vy = 0;
	entity.vz = 0;

	entity.tip = {
		progress: 0,
		pivot: new Float32Array([pivotX, pivotY, pivotZ]),
		sourceOffset,
		axis,
		endAngle,
		baseOrientation,
	};
	return true;
}

/**
 * Advance progress by `dt`. On crossing 1.0, commit the final rotation
 * into `entity.orientation` and clear `entity.tip`.
 */
export function advanceCubeTip(entity: Entity, dt: number): void {
	const tip = entity.tip;
	if (!tip) return;
	tip.progress += dt / entity.tipDuration;
	if (tip.progress >= 1) {
		// orientation = R(axis, endAngle) · baseOrientation (world-frame
		// pre-multiplication, matches updateRolling). Climbs land upside-down
		// relative to pre-tip pose — intentional.
		const finalRot = mat4.axisRotation(tip.axis, tip.endAngle);
		mat4.multiply(finalRot, tip.baseOrientation, entity.orientation);
		entity.tip = null;
	}
}
