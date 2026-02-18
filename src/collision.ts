import type Block from './Block';
import { NOTHING } from './Block';

function isSolid(
	blocks: Block[][][],
	bx: number,
	by: number,
	bz: number,
	dims: [number, number, number],
): boolean {
	const [dimX, dimY, dimZ] = dims;
	if (bx < 0 || bx >= dimX || by < 0 || by >= dimY || bz < 0 || bz >= dimZ) {
		return false;
	}
	const block = blocks[by]?.[bz]?.[bx];
	return block !== undefined && block.type !== NOTHING;
}

export interface CollisionResult {
	onGround: boolean;
	collidedX: boolean;
	collidedZ: boolean;
	collidedCeiling: boolean;
}

/**
 * Moves the player position by delta, resolving collisions against the block
 * grid axis-by-axis (X, then Z, then Y). Mutates pos in place.
 *
 * The player AABB is defined relative to pos (the eye/camera position):
 *   X: [pos.x - halfWidth, pos.x + halfWidth]
 *   Y: [pos.y - height,    pos.y]
 *   Z: [pos.z - halfWidth, pos.z + halfWidth]
 */
export function moveAndCollide(
	pos: Float32Array,
	delta: [number, number, number],
	blocks: Block[][][],
	dims: [number, number, number],
	blockSize: number,
	halfWidth: number,
	height: number,
): CollisionResult {
	let px = pos[0] ?? 0;
	let py = pos[1] ?? 0;
	let pz = pos[2] ?? 0;

	// --- X axis ---
	px += delta[0];
	const xResult = resolveX(
		px,
		py,
		pz,
		blocks,
		dims,
		blockSize,
		halfWidth,
		height,
		delta[0],
	);
	px = xResult.px;

	// --- Z axis ---
	pz += delta[2];
	const zResult = resolveZ(
		px,
		py,
		pz,
		blocks,
		dims,
		blockSize,
		halfWidth,
		height,
		delta[2],
	);
	pz = zResult.pz;

	// --- Y axis ---
	py += delta[1];
	const yResult = resolveY(
		px,
		py,
		pz,
		blocks,
		dims,
		blockSize,
		halfWidth,
		height,
		delta[1],
	);
	py = yResult.py;

	pos[0] = px;
	pos[1] = py;
	pos[2] = pz;

	return {
		onGround: yResult.onGround,
		collidedX: xResult.collided,
		collidedZ: zResult.collided,
		collidedCeiling: yResult.collidedCeiling,
	};
}

function resolveX(
	px: number,
	py: number,
	pz: number,
	blocks: Block[][][],
	dims: [number, number, number],
	blockSize: number,
	halfWidth: number,
	height: number,
	direction: number,
): { px: number; collided: boolean } {
	const minX = px - halfWidth;
	const maxX = px + halfWidth;
	const minY = py - height;
	const maxY = py;
	const minZ = pz - halfWidth;
	const maxZ = pz + halfWidth;

	const bxMin = Math.floor(minX / blockSize);
	const bxMax = Math.floor((maxX - 1e-6) / blockSize);
	const byMin = Math.floor(minY / blockSize);
	const byMax = Math.floor((maxY - 1e-6) / blockSize);
	const bzMin = Math.floor(minZ / blockSize);
	const bzMax = Math.floor((maxZ - 1e-6) / blockSize);

	let collided = false;

	for (let by = byMin; by <= byMax; by++) {
		for (let bz = bzMin; bz <= bzMax; bz++) {
			for (let bx = bxMin; bx <= bxMax; bx++) {
				if (!isSolid(blocks, bx, by, bz, dims)) continue;

				collided = true;
				if (direction > 0) {
					px = bx * blockSize - halfWidth;
				} else if (direction < 0) {
					px = (bx + 1) * blockSize + halfWidth;
				}
			}
		}
	}

	return { px, collided };
}

function resolveZ(
	px: number,
	py: number,
	pz: number,
	blocks: Block[][][],
	dims: [number, number, number],
	blockSize: number,
	halfWidth: number,
	height: number,
	direction: number,
): { pz: number; collided: boolean } {
	const minX = px - halfWidth;
	const maxX = px + halfWidth;
	const minY = py - height;
	const maxY = py;
	const minZ = pz - halfWidth;
	const maxZ = pz + halfWidth;

	const bxMin = Math.floor(minX / blockSize);
	const bxMax = Math.floor((maxX - 1e-6) / blockSize);
	const byMin = Math.floor(minY / blockSize);
	const byMax = Math.floor((maxY - 1e-6) / blockSize);
	const bzMin = Math.floor(minZ / blockSize);
	const bzMax = Math.floor((maxZ - 1e-6) / blockSize);

	let collided = false;

	for (let by = byMin; by <= byMax; by++) {
		for (let bz = bzMin; bz <= bzMax; bz++) {
			for (let bx = bxMin; bx <= bxMax; bx++) {
				if (!isSolid(blocks, bx, by, bz, dims)) continue;

				collided = true;
				if (direction > 0) {
					pz = bz * blockSize - halfWidth;
				} else if (direction < 0) {
					pz = (bz + 1) * blockSize + halfWidth;
				}
			}
		}
	}

	return { pz, collided };
}

function resolveY(
	px: number,
	py: number,
	pz: number,
	blocks: Block[][][],
	dims: [number, number, number],
	blockSize: number,
	halfWidth: number,
	height: number,
	direction: number,
): { py: number; onGround: boolean; collidedCeiling: boolean } {
	const minX = px - halfWidth;
	const maxX = px + halfWidth;
	const minY = py - height;
	const maxY = py;
	const minZ = pz - halfWidth;
	const maxZ = pz + halfWidth;

	const bxMin = Math.floor(minX / blockSize);
	const bxMax = Math.floor((maxX - 1e-6) / blockSize);
	const byMin = Math.floor(minY / blockSize);
	const byMax = Math.floor((maxY - 1e-6) / blockSize);
	const bzMin = Math.floor(minZ / blockSize);
	const bzMax = Math.floor((maxZ - 1e-6) / blockSize);

	let onGround = false;
	let collidedCeiling = false;

	for (let by = byMin; by <= byMax; by++) {
		for (let bz = bzMin; bz <= bzMax; bz++) {
			for (let bx = bxMin; bx <= bxMax; bx++) {
				if (!isSolid(blocks, bx, by, bz, dims)) continue;

				if (direction < 0) {
					py = (by + 1) * blockSize + height;
					onGround = true;
				} else if (direction > 0) {
					py = by * blockSize;
					collidedCeiling = true;
				}
			}
		}
	}

	return { py, onGround, collidedCeiling };
}
