/**
 * Sphere physics — semi-implicit Euler + closest-point narrowphase against
 * voxels and the player AABB. Pair collisions live in `entity-interactions.ts`;
 * `resolveSphereVsAABB` is exported because both modules need it.
 */

import { mat4 } from 'wgpu-matrix';
import { blockRegistry } from './block';
import { CHUNK_SIZE } from './chunk';
import type { World } from './world';
import type { Entity } from './entity';
import {
	MC_TICK,
	GRAVITY,
	TERMINAL_VELOCITY,
	NEGLIGIBLE,
	RESTING_THRESHOLD,
} from './entity-physics-shared';

// Per-surface restitution; combined with entity restitution via max().
const PLAYER_RESTITUTION = 0.6;
const DEFAULT_BLOCK_RESTITUTION = 0.3;

// Contact shell — width (world units) of the "in-contact" band outside the
// sphere's geometric radius. Resolution still depenetrates only when the
// real radius overlaps; the shell exists purely so a sphere resting at
// exactly r from a surface still registers `attached` and a contact normal.
//
// Without this, a sphere sitting on a flat floor oscillates between
// `attached` (frame N: gravity dips it into the floor → resolver pushes
// out → contact recorded) and `!attached` (frame N+1: gravity gated by
// `attached`, no penetration, no contacts found → `attached` flips false).
// AI thrust ramps up only to be sabotaged on alternate frames, crawling
// the sphere along at ~1 unit/sec instead of ~8.
//
// 0.5 units is well below BLOCK_SIZE=10 (no false positives from adjacent
// blocks) and well above the integration error a single tick can introduce
// at terminal velocity (also ~0.5/tick worst case).
const SHELL = 0.5;

// Snap-back search radius. Larger than SHELL so the sphere can find a
// corner block from the far side of a convex edge and arc around it
// instead of detaching into air. Smaller than R so strong impulses
// (sphere bonk, cube tip launch) can clear it in one frame and genuinely
// detach. At v=8 units/sec and 60fps the per-frame drift is ~0.13 —
// SNAP=4 gives ~30x headroom.
const SNAP = 4;

// Scratch matrices for rolling — shared across entities/frames.
const scratchRotation = mat4.identity();
const scratchOrientation = mat4.identity();

/**
 * Sphere physics tick: gravity + integration + voxel/player resolution +
 * cosmetic rolling. Pair collisions run in Pass 2.
 */
export function entityPhysicsTick(
	entity: Entity,
	world: World,
	playerPos: Float32Array,
	playerHalfWidth: number,
	playerHeight: number,
	dt: number,
): void {
	const t = dt / MC_TICK;

	// Sticky-by-default: skip gravity while attached. `attached` reflects
	// last frame's contacts, so the first tick after spawn falls until the
	// sphere meets a surface; from then on AI thrust + resolver re-assertion
	// sustain it.
	if (!entity.noGravity && !entity.attached) {
		entity.vy -= GRAVITY * t;
		if (entity.vy < TERMINAL_VELOCITY) entity.vy = TERMINAL_VELOCITY;
	}

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

	// Reset contact state before resolution. `grounded` and `attached` get
	// re-set by any qualifying contact during the resolution passes. Contact
	// normal accumulator is summed across all AABB hits this tick (sphere
	// vs N voxels, sphere vs player, sphere vs cube faces) and normalized
	// once below — keeps wedged-corner cases producing a sensible "outward"
	// direction without per-contact normalization.
	const wasAttached = entity.attached;
	entity.grounded = false;
	entity.attached = false;
	entity.contactNx = 0;
	entity.contactNy = 0;
	entity.contactNz = 0;
	entity.touchedPlayer = false;

	const ww = world.widthChunks * CHUNK_SIZE * world.blockSize;

	resolveSphereVsVoxels(entity, world);
	resolveSphereVsPlayer(entity, playerPos, playerHalfWidth, playerHeight, ww);

	if (entity.attached) {
		const len = Math.hypot(
			entity.contactNx,
			entity.contactNy,
			entity.contactNz,
		);
		if (len > 1e-6) {
			entity.contactNx /= len;
			entity.contactNy /= len;
			entity.contactNz /= len;
		}
	}

	// Snap-back: extend attachment across convex edges by projecting the
	// center to exactly r from the closest solid in the snap band. See
	// applySnap for the contact-state preservation rule.
	if (wasAttached) {
		applySnap(entity, world, entity.attached);
	}

	// Wrap horizontal position (matches player wrapping)
	entity.x = ((entity.x % ww) + ww) % ww;
	entity.z = ((entity.z % ww) + ww) % ww;

	updateRolling(entity, t);
}

function resolveSphereVsVoxels(entity: Entity, world: World): void {
	const blockSize = world.blockSize;
	const r = entity.scale;
	// Iterate over the shell-inflated AABB so blocks one tick away from real
	// overlap still get a chance to register a shell-only contact.
	const rShell = r + SHELL;

	// AABB in block coordinates
	const bxMin = Math.floor((entity.x - rShell) / blockSize);
	const bxMax = Math.floor((entity.x + rShell) / blockSize);
	const byMin = Math.floor((entity.y - rShell) / blockSize);
	const byMax = Math.floor((entity.y + rShell) / blockSize);
	const bzMin = Math.floor((entity.z - rShell) / blockSize);
	const bzMax = Math.floor((entity.z + rShell) / blockSize);

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

	const minX = px - playerHalfWidth;
	const maxX = px + playerHalfWidth;
	const minY = py - playerHeight;
	const maxY = py;
	const minZ = pz - playerHalfWidth;
	const maxZ = pz + playerHalfWidth;

	// Contact flag for the self-destruct fuse — sampled before resolution
	// depenetrates the sphere back to the surface. Real overlap only (true
	// radius, not the shell), so it means "actually reached the player."
	const cpX = Math.max(minX, Math.min(entity.x, maxX));
	const cpY = Math.max(minY, Math.min(entity.y, maxY));
	const cpZ = Math.max(minZ, Math.min(entity.z, maxZ));
	const ddx = entity.x - cpX;
	const ddy = entity.y - cpY;
	const ddz = entity.z - cpZ;
	if (ddx * ddx + ddy * ddy + ddz * ddz < entity.scale * entity.scale) {
		entity.touchedPlayer = true;
	}

	resolveSphereVsAABB(
		entity,
		minX,
		maxX,
		minY,
		maxY,
		minZ,
		maxZ,
		entity.restitution,
		PLAYER_RESTITUTION,
	);
}

/**
 * Project the sphere center to exactly r from the closest point on the
 * union of solid voxels within `r + SNAP`, and zero the normal-component
 * of velocity. Bends trajectory around convex edges (sphere rolling off
 * a platform lip arcs around the corner instead of detaching).
 *
 * Contact state writes are gated on `!preAttached`: when the per-voxel
 * resolver already found contacts this frame, leave its summed sum-of-
 * normals alone. At a concave wedge (sphere pressed into floor + wall)
 * the sum points diagonally outward so AI thrust keeps a +Y tangent
 * component and the sphere climbs; single-closest-point would collapse
 * to whichever block won the iteration tiebreak, killing the climb.
 *
 * Only called when `wasAttached` — never pulls a freshly-airborne
 * sphere onto a surface.
 */
function applySnap(entity: Entity, world: World, preAttached: boolean): void {
	const blockSize = world.blockSize;
	const r = entity.scale;
	const reach = r + SNAP;

	const bxMin = Math.floor((entity.x - reach) / blockSize);
	const bxMax = Math.floor((entity.x + reach) / blockSize);
	const byMin = Math.floor((entity.y - reach) / blockSize);
	const byMax = Math.floor((entity.y + reach) / blockSize);
	const bzMin = Math.floor((entity.z - reach) / blockSize);
	const bzMax = Math.floor((entity.z + reach) / blockSize);

	let bestDistSq = reach * reach;
	let bestCpX = 0;
	let bestCpY = 0;
	let bestCpZ = 0;
	let found = false;

	for (let bx = bxMin; bx <= bxMax; bx++) {
		for (let by = byMin; by <= byMax; by++) {
			for (let bz = bzMin; bz <= bzMax; bz++) {
				if (!blockRegistry.isSolid(world.getBlock(bx, by, bz)))
					continue;

				const boxMinX = bx * blockSize;
				const boxMinY = by * blockSize;
				const boxMinZ = bz * blockSize;
				const boxMaxX = boxMinX + blockSize;
				const boxMaxY = boxMinY + blockSize;
				const boxMaxZ = boxMinZ + blockSize;

				const cpX = Math.max(boxMinX, Math.min(entity.x, boxMaxX));
				const cpY = Math.max(boxMinY, Math.min(entity.y, boxMaxY));
				const cpZ = Math.max(boxMinZ, Math.min(entity.z, boxMaxZ));

				const dx = entity.x - cpX;
				const dy = entity.y - cpY;
				const dz = entity.z - cpZ;
				const distSq = dx * dx + dy * dy + dz * dz;

				// Strict `< bestDistSq` and `> 1e-6` — the latter skips the
				// center-inside-box case (no well-defined normal from a zero
				// vector; the regular resolver's inside-box branch already
				// handled depenetration).
				if (distSq < bestDistSq && distSq > 1e-6) {
					bestDistSq = distSq;
					bestCpX = cpX;
					bestCpY = cpY;
					bestCpZ = cpZ;
					found = true;
				}
			}
		}
	}

	if (!found) return;

	const dist = Math.sqrt(bestDistSq);
	const nx = (entity.x - bestCpX) / dist;
	const ny = (entity.y - bestCpY) / dist;
	const nz = (entity.z - bestCpZ) / dist;

	entity.x = bestCpX + nx * r;
	entity.y = bestCpY + ny * r;
	entity.z = bestCpZ + nz * r;

	const vDotN = entity.vx * nx + entity.vy * ny + entity.vz * nz;
	entity.vx -= vDotN * nx;
	entity.vy -= vDotN * ny;
	entity.vz -= vDotN * nz;

	if (!preAttached) {
		entity.attached = true;
		entity.grounded = ny > 0.5;
		entity.contactNx = nx;
		entity.contactNy = ny;
		entity.contactNz = nz;
	}
}

/**
 * Sphere-vs-AABB closest-point test with shell-aware contact reporting.
 *
 *   - distSq ≥ (r+SHELL)²    → no overlap, return.
 *   - r² ≤ distSq < (r+SHELL)² → shell-only contact: record normal +
 *     `attached`/`grounded` so attached AI and resting state remain
 *     stable, but skip depenetration and velocity response.
 *   - distSq < r²            → real overlap: full depenetration +
 *     velocity response (bounce or resting).
 *
 * Sphere-center-inside-box is always a real overlap (penetration ≥ r).
 * Reused by `entity-interactions.ts` for sphere-vs-cube.
 */
export function resolveSphereVsAABB(
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
	const rShell = r + SHELL;

	// Closest point on AABB to sphere center
	const cpX = Math.max(boxMinX, Math.min(entity.x, boxMaxX));
	const cpY = Math.max(boxMinY, Math.min(entity.y, boxMaxY));
	const cpZ = Math.max(boxMinZ, Math.min(entity.z, boxMaxZ));

	const dx = entity.x - cpX;
	const dy = entity.y - cpY;
	const dz = entity.z - cpZ;
	const distSq = dx * dx + dy * dy + dz * dz;

	if (distSq >= rShell * rShell) return; // beyond shell

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

	// Contact reporting fires for shell-or-real overlap. Sticky AI and
	// resting-state stability depend on this being set even when the sphere
	// isn't actually penetrating — that's the whole point of the shell.
	if (ny > 0.5) entity.grounded = true;
	entity.attached = true;
	entity.contactNx += nx;
	entity.contactNy += ny;
	entity.contactNz += nz;

	// Shell-only contact: no real overlap → nothing to depenetrate, and
	// nothing to bounce off. Skip the rest. (penetration < 0 means the
	// sphere's surface is `|penetration|` units away from the box.)
	if (penetration <= 0) return;

	// Depenetrate
	entity.x += nx * penetration;
	entity.y += ny * penetration;
	entity.z += nz * penetration;

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
 * Visual rolling — rotate around `(v_tangent × n) / |v_tangent × n|`, where
 * n is the contact normal and v_tangent is velocity projected onto the
 * surface plane. Equivalent to the canonical `ω = (n × v) / r` for rolling
 * without slipping, just with the sign convention the original floor-only
 * code happened to use; preserved so existing rolling looks identical.
 *
 * Falls back to n = (0,1,0) when airborne. That keeps falling/non-sticky
 * spheres looking the same as before (axis stays in the XZ plane, vy
 * doesn't contribute), while sticky spheres climbing a wall pick up the
 * actual contact normal and roll around the correct axis.
 *
 * Purely cosmetic — no angular momentum carries between frames.
 */
function updateRolling(entity: Entity, t: number): void {
	const nx = entity.attached ? entity.contactNx : 0;
	const ny = entity.attached ? entity.contactNy : 1;
	const nz = entity.attached ? entity.contactNz : 0;

	// Strip normal component → tangent velocity along the surface
	const vDotN = entity.vx * nx + entity.vy * ny + entity.vz * nz;
	const vtx = entity.vx - vDotN * nx;
	const vty = entity.vy - vDotN * ny;
	const vtz = entity.vz - vDotN * nz;
	const vtSpeedSq = vtx * vtx + vty * vty + vtz * vtz;
	if (vtSpeedSq < 1e-4) return;
	const vtSpeed = Math.sqrt(vtSpeedSq);

	// axis = v_tangent × n
	const axisX = vty * nz - vtz * ny;
	const axisY = vtz * nx - vtx * nz;
	const axisZ = vtx * ny - vty * nx;
	const axisLen = Math.hypot(axisX, axisY, axisZ);
	if (axisLen < 1e-6) return;

	const angle = -(vtSpeed * t) / entity.scale;

	mat4.axisRotation(
		[axisX / axisLen, axisY / axisLen, axisZ / axisLen],
		angle,
		scratchRotation,
	);
	// Pre-multiply: orientation = R * orientation (rotation in world frame)
	mat4.multiply(scratchRotation, entity.orientation, scratchOrientation);
	mat4.copy(scratchOrientation, entity.orientation);
}
