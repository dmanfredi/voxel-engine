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
const RESTING_THRESHOLD = 2.0;
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

	// Friction. universal and not material dependent
	// this make the spheres "cling" to corners, Bad!
	// if (entity.grounded) {
	// 	entity.vx = Math.max(entity.vx - 0.005, 0);
	// 	entity.vz = Math.max(entity.vz - 0.005, 0);
	// }

	// Integrate position
	entity.x += entity.vx * t;
	entity.y += entity.vy * t;
	entity.z += entity.vz * t;

	// Reset grounded before resolution; any contact with upward normal sets it
	entity.grounded = false;

	const ww = world.widthChunks * CHUNK_SIZE * world.blockSize;

	resolveSphereVsVoxels(entity, world);
	resolveSphereVsPlayer(entity, playerPos, playerHalfWidth, playerHeight, ww);

	// Wrap horizontal position to match the wrapping world (like the player does)
	entity.x = ((entity.x % ww) + ww) % ww;
	entity.z = ((entity.z % ww) + ww) % ww;

	updateRolling(entity, t);
}

function resolveSphereVsVoxels(entity: Entity, world: World): void {
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
					entity.restitution,
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
	ww: number,
): void {
	let px = playerPos[0] ?? 0;
	const py = playerPos[1] ?? 0;
	let pz = playerPos[2] ?? 0;

	// Shift the player to the wrapped copy closest to the entity so the
	// closest-point test works near the world boundary.
	const hw = ww / 2;
	const dxRaw = entity.x - px;
	const dzRaw = entity.z - pz;
	if (dxRaw > hw) px += ww;
	else if (dxRaw < -hw) px -= ww;
	if (dzRaw > hw) pz += ww;
	else if (dzRaw < -hw) pz -= ww;

	resolveSphereVsAABB(
		entity,
		px - playerHalfWidth,
		px + playerHalfWidth,
		py - playerHeight,
		py,
		pz - playerHalfWidth,
		pz + playerHalfWidth,
		entity.restitution,
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
 * Sphere-vs-sphere collision. Wrap-aware contact normal; mass-weighted
 * depenetration (heavier moves less); classical impulse response along the
 * normal with combined-max restitution. Sub-threshold approaches get the
 * resting-contact treatment (zero inward component, no bounce) — same pattern
 * as wall contacts, prevents micro-jitter when spheres settle into contact
 * under gravity.
 *
 * Momentum is conserved (equal-and-opposite impulse on both spheres).
 * Angular effects are omitted — consistent with `updateRolling` being purely
 * cosmetic.
 */
export function resolveSpherePair(a: Entity, b: Entity, ww: number): void {
	const hw = ww / 2;

	// Wrap-aware vector from B to A (horizontal wraps; Y does not)
	let dx = a.x - b.x;
	let dz = a.z - b.z;
	if (dx > hw) dx -= ww;
	else if (dx < -hw) dx += ww;
	if (dz > hw) dz -= ww;
	else if (dz < -hw) dz += ww;
	const dy = a.y - b.y;

	const distSq = dx * dx + dy * dy + dz * dz;
	const totalR = a.scale + b.scale;
	if (distSq >= totalR * totalR) return; // no overlap

	let nx: number, ny: number, nz: number, penetration: number;
	if (distSq < 1e-6) {
		// Centers coincide — arbitrary up-normal, full overlap
		nx = 0;
		ny = 1;
		nz = 0;
		penetration = totalR;
	} else {
		const dist = Math.sqrt(distSq);
		nx = dx / dist;
		ny = dy / dist;
		nz = dz / dist;
		penetration = totalR - dist;
	}

	// Mass-weighted depenetration: push distance splits so heavier moves less.
	// aPush = pen * mB/(mA+mB), bPush = pen * mA/(mA+mB), via inverse-mass form.
	const invMassSum = 1 / a.mass + 1 / b.mass;
	const aPush = (penetration * (1 / a.mass)) / invMassSum;
	const bPush = (penetration * (1 / b.mass)) / invMassSum;
	a.x += nx * aPush;
	a.y += ny * aPush;
	a.z += nz * aPush;
	b.x -= nx * bPush;
	b.y -= ny * bPush;
	b.z -= nz * bPush;

	// Grounded flag: whichever sphere sits atop the other gets ground-state
	if (ny > 0.5) a.grounded = true;
	if (ny < -0.5) b.grounded = true;

	// Relative velocity along contact normal
	const vrx = a.vx - b.vx;
	const vry = a.vy - b.vy;
	const vrz = a.vz - b.vz;
	const vn = vrx * nx + vry * ny + vrz * nz;
	if (vn >= 0) return; // already separating — leave velocity alone

	const inwardSpeed = -vn;
	const e = Math.max(a.restitution, b.restitution);
	const factor = inwardSpeed < RESTING_THRESHOLD ? 1 : 1 + e;

	// Impulse magnitude along n: j = factor * inwardSpeed / (1/mA + 1/mB)
	const j = (factor * inwardSpeed) / invMassSum;
	a.vx += (j / a.mass) * nx;
	a.vy += (j / a.mass) * ny;
	a.vz += (j / a.mass) * nz;
	b.vx -= (j / b.mass) * nx;
	b.vy -= (j / b.mass) * ny;
	b.vz -= (j / b.mass) * nz;
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
