import type { World } from './world';

export interface RaycastHit {
	/** Block coordinates (integer grid indices) */
	blockPos: [number, number, number];
	/** Face normal: exactly one component is +1 or -1. Add to blockPos for placement position. */
	faceNormal: [number, number, number];
	/** Distance from ray origin to hit point (world units) */
	distance: number;
}

/**
 * DDA voxel raycast (Amanatides & Woo).
 *
 * Casts a ray from `origin` along `direction` through the voxel grid,
 * stepping exactly from one grid boundary to the next. Returns the first
 * solid block hit and the face it was entered through, or null if nothing
 * is hit within `maxDistance` world units.
 */
export function raycast(
	origin: Float32Array,
	direction: Float32Array,
	world: World,
	maxDistance: number,
): RaycastHit | null {
	const bs = world.blockSize;

	// Convert origin to block-space (continuous coordinates)
	const ox = origin[0] / bs;
	const oy = origin[1] / bs;
	const oz = origin[2] / bs;

	// Current block position (integer cell)
	let bx = Math.floor(ox);
	let by = Math.floor(oy);
	let bz = Math.floor(oz);

	// Direction components
	const dx = direction[0];
	const dy = direction[1];
	const dz = direction[2];

	// Step direction per axis (+1 or -1, 0 if ray is parallel)
	const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
	const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
	const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

	// tDelta: how far along the ray (in block-space t) to cross one full cell
	const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
	const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
	const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

	// tMax: distance to the first grid boundary on each axis
	let tMaxX: number;
	if (dx > 0) {
		tMaxX = (bx + 1 - ox) / dx;
	} else if (dx < 0) {
		tMaxX = (bx - ox) / dx;
	} else {
		tMaxX = Infinity;
	}

	let tMaxY: number;
	if (dy > 0) {
		tMaxY = (by + 1 - oy) / dy;
	} else if (dy < 0) {
		tMaxY = (by - oy) / dy;
	} else {
		tMaxY = Infinity;
	}

	let tMaxZ: number;
	if (dz > 0) {
		tMaxZ = (bz + 1 - oz) / dz;
	} else if (dz < 0) {
		tMaxZ = (bz - oz) / dz;
	} else {
		tMaxZ = Infinity;
	}

	// Max distance in block-space units
	// direction is normalized, so 1 unit of block-space t = blockSize world units
	const maxDistBlock = maxDistance / bs;

	let t = 0;
	let lastAxis = -1; // 0=X, 1=Y, 2=Z

	// Step through the grid. Skip the starting cell (first check is after the first step).
	// This handles freecam-inside-solid-block correctly.
	while (t < maxDistBlock) {
		// Advance to the nearest axis boundary
		if (tMaxX < tMaxY && tMaxX < tMaxZ) {
			bx += stepX;
			t = tMaxX;
			tMaxX += tDeltaX;
			lastAxis = 0;
		} else if (tMaxY < tMaxZ) {
			by += stepY;
			t = tMaxY;
			tMaxY += tDeltaY;
			lastAxis = 1;
		} else {
			bz += stepZ;
			t = tMaxZ;
			tMaxZ += tDeltaZ;
			lastAxis = 2;
		}

		if (t >= maxDistBlock) break;

		if (world.isSolid(bx, by, bz)) {
			// Face normal: opposite to the step direction on the axis we entered through
			const faceNormal: [number, number, number] = [0, 0, 0];
			if (lastAxis === 0) faceNormal[0] = -stepX;
			else if (lastAxis === 1) faceNormal[1] = -stepY;
			else faceNormal[2] = -stepZ;

			return {
				blockPos: [bx, by, bz],
				faceNormal,
				distance: t * bs,
			};
		}
	}

	return null;
}
