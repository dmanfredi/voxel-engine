/**
 * Entity physics — semi-implicit Euler integration + impulse-based collision
 * response for spheres. Mirrors the player's physics model in movement.ts for
 * consistency (same MC_TICK, same GRAVITY, same terminal velocity).
 *
 * Currently only Sphere shape is handled; other shapes fall through.
 */

import { mat4 } from 'wgpu-matrix';
import { blockRegistry } from './block';
import { CHUNK_SIZE } from './chunk';
import type { World } from './world';
import type { Entity } from './entity';
import { Shape } from './entity';

const MC_TICK = 0.05;
const GRAVITY = 0.8;
const TERMINAL_VELOCITY = -39.2;
const NEGLIGIBLE = 0.05;
const RESTING_THRESHOLD = 1.0;
const PLAYER_RESTITUTION = 0.6;
const DEFAULT_BLOCK_RESTITUTION = 0.3;

// Scratch matrices for visual rolling — reused across all entities/frames
// to avoid per-frame Float32Array allocations.
const scratchRotation = mat4.identity();
const scratchOrientation = mat4.identity();

export function entityPhysicsTick(
	entity: Entity,
	world: World,
	playerPos: Float32Array,
	playerHalfWidth: number,
	playerHeight: number,
	entityRestitution: number,
	dt: number,
): void {
	// Only spheres for now; other shapes are no-op until their physics lands
	if (entity.shape !== Shape.Sphere) return;

	const t = dt / MC_TICK;

	// Gravity + terminal velocity
	entity.vy -= GRAVITY * t;
	if (entity.vy < TERMINAL_VELOCITY) entity.vy = TERMINAL_VELOCITY;

	// Zero tiny horizontal velocities (prevents eternal micro-drift)
	if (Math.abs(entity.vx) < NEGLIGIBLE * t) entity.vx = 0;
	if (Math.abs(entity.vz) < NEGLIGIBLE * t) entity.vz = 0;
	// Intentionally NOT zeroing vy — gravity needs to keep accumulating

	// Integrate position
	entity.x += entity.vx * t;
	entity.y += entity.vy * t;
	entity.z += entity.vz * t;

	// Reset grounded before resolution; any contact with upward normal sets it
	entity.grounded = false;

	resolveSphereVsVoxels(entity, world, entityRestitution);
	resolveSphereVsPlayer(
		entity,
		playerPos,
		playerHalfWidth,
		playerHeight,
		entityRestitution,
	);

	// Wrap horizontal position to match the wrapping world (like the player does)
	const ww = world.widthChunks * CHUNK_SIZE * world.blockSize;
	entity.x = ((entity.x % ww) + ww) % ww;
	entity.z = ((entity.z % ww) + ww) % ww;

	updateRolling(entity, t);
}

function resolveSphereVsVoxels(
	entity: Entity,
	world: World,
	entityRestitution: number,
): void {
	const blockSize = world.blockSize;
	const r = entity.scale;

	// AABB in block coordinates
	const bxMin = Math.floor((entity.x - r) / blockSize);
	const bxMax = Math.floor((entity.x + r) / blockSize);
	const byMin = Math.floor((entity.y - r) / blockSize);
	const byMax = Math.floor((entity.y + r) / blockSize);
	const bzMin = Math.floor((entity.z - r) / blockSize);
	const bzMax = Math.floor((entity.z + r) / blockSize);

	for (let bx = bxMin; bx <= bxMax; bx++) {
		for (let by = byMin; by <= byMax; by++) {
			for (let bz = bzMin; bz <= bzMax; bz++) {
				const blockId = world.getBlock(bx, by, bz);
				if (!blockRegistry.isSolid(blockId)) continue;

				const boxMinX = bx * blockSize;
				const boxMinY = by * blockSize;
				const boxMinZ = bz * blockSize;
				const blockRest =
					blockRegistry.get(blockId)?.restitution ??
					DEFAULT_BLOCK_RESTITUTION;

				resolveSphereVsAABB(
					entity,
					boxMinX,
					boxMinX + blockSize,
					boxMinY,
					boxMinY + blockSize,
					boxMinZ,
					boxMinZ + blockSize,
					entityRestitution,
					blockRest,
				);
			}
		}
	}
}

function resolveSphereVsPlayer(
	entity: Entity,
	playerPos: Float32Array,
	playerHalfWidth: number,
	playerHeight: number,
	entityRestitution: number,
): void {
	const px = playerPos[0] ?? 0;
	const py = playerPos[1] ?? 0;
	const pz = playerPos[2] ?? 0;

	resolveSphereVsAABB(
		entity,
		px - playerHalfWidth,
		px + playerHalfWidth,
		py - playerHeight,
		py,
		pz - playerHalfWidth,
		pz + playerHalfWidth,
		entityRestitution,
		PLAYER_RESTITUTION,
	);
}

/**
 * Sphere-vs-AABB closest-point test. If overlapping, depenetrates the sphere
 * along the contact normal and resolves velocity (bounce or resting contact).
 */
function resolveSphereVsAABB(
	entity: Entity,
	boxMinX: number,
	boxMaxX: number,
	boxMinY: number,
	boxMaxY: number,
	boxMinZ: number,
	boxMaxZ: number,
	entityRestitution: number,
	otherRestitution: number,
): void {
	const r = entity.scale;

	// Closest point on AABB to sphere center
	const cpX = Math.max(boxMinX, Math.min(entity.x, boxMaxX));
	const cpY = Math.max(boxMinY, Math.min(entity.y, boxMaxY));
	const cpZ = Math.max(boxMinZ, Math.min(entity.z, boxMaxZ));

	const dx = entity.x - cpX;
	const dy = entity.y - cpY;
	const dz = entity.z - cpZ;
	const distSq = dx * dx + dy * dy + dz * dz;

	if (distSq >= r * r) return; // no overlap

	let nx: number, ny: number, nz: number, penetration: number;

	if (distSq < 1e-6) {
		// Sphere center inside box — push out along nearest face
		const distToMinX = entity.x - boxMinX;
		const distToMaxX = boxMaxX - entity.x;
		const distToMinY = entity.y - boxMinY;
		const distToMaxY = boxMaxY - entity.y;
		const distToMinZ = entity.z - boxMinZ;
		const distToMaxZ = boxMaxZ - entity.z;

		let minDist = distToMinX;
		nx = -1;
		ny = 0;
		nz = 0;

		if (distToMaxX < minDist) {
			minDist = distToMaxX;
			nx = 1;
			ny = 0;
			nz = 0;
		}
		if (distToMinY < minDist) {
			minDist = distToMinY;
			nx = 0;
			ny = -1;
			nz = 0;
		}
		if (distToMaxY < minDist) {
			minDist = distToMaxY;
			nx = 0;
			ny = 1;
			nz = 0;
		}
		if (distToMinZ < minDist) {
			minDist = distToMinZ;
			nx = 0;
			ny = 0;
			nz = -1;
		}
		if (distToMaxZ < minDist) {
			minDist = distToMaxZ;
			nx = 0;
			ny = 0;
			nz = 1;
		}

		penetration = minDist + r;
	} else {
		const dist = Math.sqrt(distSq);
		nx = dx / dist;
		ny = dy / dist;
		nz = dz / dist;
		penetration = r - dist;
	}

	// Depenetrate
	entity.x += nx * penetration;
	entity.y += ny * penetration;
	entity.z += nz * penetration;

	// Grounded flag: contact normal points substantially upward
	if (ny > 0.5) entity.grounded = true;

	// Velocity response
	const vDotN = entity.vx * nx + entity.vy * ny + entity.vz * nz;
	if (vDotN >= 0) return; // already separating — leave velocity alone

	const inwardSpeed = -vDotN;
	const e = Math.max(entityRestitution, otherRestitution);
	// Below threshold: zero inward component only (resting contact).
	// Above threshold: reflect with restitution (bounce).
	const factor = inwardSpeed < RESTING_THRESHOLD ? 1 : 1 + e;

	entity.vx -= factor * vDotN * nx;
	entity.vy -= factor * vDotN * ny;
	entity.vz -= factor * vDotN * nz;
}

/**
 * Visual rolling — accumulate rotation around the axis perpendicular to
 * horizontal velocity. No angular physics; purely cosmetic.
 */
function updateRolling(entity: Entity, t: number): void {
	const hSpeedSq = entity.vx * entity.vx + entity.vz * entity.vz;
	if (hSpeedSq < 1e-4) return;

	const hSpeed = Math.sqrt(hSpeedSq);
	const axisX = -entity.vz / hSpeed;
	const axisZ = entity.vx / hSpeed;
	const angle = -(hSpeed * t) / entity.scale;

	mat4.axisRotation([axisX, 0, axisZ], angle, scratchRotation);
	// Pre-multiply: orientation = R * orientation (rotation in world frame)
	mat4.multiply(scratchRotation, entity.orientation, scratchOrientation);
	mat4.copy(scratchOrientation, entity.orientation);
}
