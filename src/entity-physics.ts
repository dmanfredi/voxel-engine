/**
 * Entity physics — semi-implicit Euler integration + collision response for
 * non-voxel entities. Mirrors the player's physics model in movement.ts for
 * consistency (same MC_TICK, same GRAVITY, same terminal velocity).
 *
 * Spheres use closest-point narrowphase + restitution-driven bounce.
 * Cubes use axis-separated AABB-vs-grid snap-and-zero (no bounce — cubes
 * are treated as platforms/obstacles). Shape dispatch happens at the
 * EntityManager level, not here.
 */

import { mat4 } from 'wgpu-matrix';
import { blockRegistry } from './block';
import { CHUNK_SIZE } from './chunk';
import { Shape } from './entity';
import type { World } from './world';
import type { Entity } from './entity';

const MC_TICK = 0.05;
const GRAVITY = 0.8;
const TERMINAL_VELOCITY = -39.2;
const NEGLIGIBLE = 0.05;
const RESTING_THRESHOLD = 2.0;
const PLAYER_RESTITUTION = 0.6;
const DEFAULT_BLOCK_RESTITUTION = 0.3;

/**
 * Mid-tip animation state. Present on a Cube entity between tip start and
 * completion; null otherwise. Entity position (`x/y/z`) is snapped to the
 * destination cell at tip start; the composite transform in `uploadTransform`
 * uses the stored pivot/offset/axis to render the cube arcing back through
 * its pre-tip pose toward the destination.
 *
 * Composite model matrix:
 *   M = T(pivot) · R(axis, progress·endAngle) · T(sourceOffset) · baseOrientation · S(scale)
 * where sourceOffset = sourceCenter − pivot (both world-space).
 *
 * `endAngle` is π/2 for horizontal tips and π for climbs. Climbs pivot around
 * the top-forward edge of the wall (shared with the cube's top-leading edge),
 * so the cube sweeps a 180° arc that carries it up and over onto the wall —
 * a handspring motion. Geometry is unified by branching only pivot Y offset,
 * sourceOffset Y, and endAngle on dy.
 */
export interface TipState {
	progress: number; // 0..1 over TIP_DURATION
	pivot: Float32Array<ArrayBuffer>; // vec3, world-space pivot edge midpoint
	sourceOffset: Float32Array<ArrayBuffer>; // vec3, sourceCenter − pivot
	axis: Float32Array<ArrayBuffer>; // vec3, unit rotation axis
	endAngle: number; // radians at progress=1 (π/2 horizontal, π climb)
	baseOrientation: Float32Array<ArrayBuffer>; // mat4, orientation at tip start
}

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
	// Caller dispatches by shape; this function is sphere-only.
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
 * Cube physics tick — gravity + axis-separated AABB-vs-voxel collision.
 * No bounce on landing (restitution ignored); velocity along the contact
 * axis is zeroed. Cubes are symmetric around their center: AABB half-extent
 * equals `entity.scale` on all three axes (mesh spans [-1, +1]³).
 *
 * No AI hook, no player collision, no rolling update. Tipping and player
 * interaction land in later phases.
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
 * Resolve a cube's AABB against the voxel grid along a single axis. If any
 * solid block overlaps the AABB, snaps the cube to the contact surface of
 * the block nearest to the pre-move position (smallest bx for +dir,
 * largest for -dir) and returns true.
 *
 * `axis` is 0 (x), 1 (y), 2 (z); `direction` is the sign of motion.
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
 * Kick off a tip in the given axis-aligned direction. Returns false and
 * warns to console if the tip is infeasible — destination cells not all air,
 * or the cell directly below the destination footprint not solid (no pivot
 * edge to rotate around). Also rejects if the entity isn't a cube or is
 * already tipping.
 *
 * `direction = [dx, dy, dz]`:
 *   - dy=0, (dx,dz) axis-aligned unit → horizontal walk (90° tip)
 *   - dy=+1, (dx,dz) axis-aligned unit → climb up onto adjacent wall (180° tip)
 *   - Other combinations (corners, dy=-1, straight-up) not supported.
 *
 * On success: entity position snaps to the destination cell, velocity zeros,
 * and `entity.tip` is populated. The render transform compensates so the
 * cube visually starts at its pre-tip position and arcs around the pivot
 * edge to land at the destination over TIP_DURATION seconds.
 *
 * Mid-tip collision (vs spheres, vs voxels) is deferred — tipping cubes are
 * simply non-interactive for the brief arc duration. Per the Phase 3 plan
 * (see notes/cube-enemy.md).
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

	// Source center (current entity position) and destination center. For
	// a climb (dy=1) the destination is one cube-edge forward AND up.
	const destX = entity.x + dx * edge;
	const destY = entity.y + dy * edge;
	const destZ = entity.z + dz * edge;

	// Feasibility: every destination cell is air, and the layer immediately
	// beneath destination is solid (the pivot edge must be a real block
	// corner). For climbs that layer is the top of the wall; for horizontal
	// walks it's the ground. Same check, different semantics.
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

	// Pivot selection branches on dy:
	//   Horizontal (dy=0): bottom-forward edge of source at (dx·s, −s, dz·s).
	//   Climb (dy=1): top-forward edge of source at (dx·s, +s, dz·s) — this
	//     edge is shared with the top-back edge of the wall the cube climbs.
	// sourceOffset = sourceCenter − pivot; inverts pivot's local offset.
	const pivotYOffset = dy === 0 ? -s : s;
	const pivotX = entity.x + dx * s;
	const pivotY = entity.y + pivotYOffset;
	const pivotZ = entity.z + dz * s;
	const sourceOffset = new Float32Array([-dx * s, -pivotYOffset, -dz * s]);

	// Rotation axis = cross(up, direction) = (dz, 0, −dx). Same for both
	// cases — the axis runs along the pivot edge either way. Only the total
	// rotation amount changes: 90° for horizontal, 180° for climb.
	const axis = new Float32Array([dz, 0, -dx]);
	const endAngle = dy === 0 ? Math.PI / 2 : Math.PI;

	// Snapshot orientation into a fresh ArrayBuffer-backed view so the stored
	// matrix can't be mutated by subsequent orientation updates.
	const baseOrientation = new Float32Array(entity.orientation);

	// Snap position to destination up-front. Simpler than tracking arc
	// position: physics stays grid-aligned and pair collision sees a stable
	// post-tip position (for the frames it still runs — tipping cubes are
	// excluded from pair checks per the plan).
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
 * Advance a tip's progress by `dt`. When progress crosses 1.0, commits the
 * 90° rotation into `entity.orientation` (so the next idle render picks up
 * the new pose) and clears `entity.tip`.
 */
export function advanceCubeTip(entity: Entity, dt: number): void {
	const tip = entity.tip;
	if (!tip) return;
	tip.progress += dt / entity.tipDuration;
	if (tip.progress >= 1) {
		// Commit final rotation: orientation = R(axis, endAngle) · baseOrientation.
		// Matches the world-frame pre-multiplication pattern used by
		// updateRolling, so subsequent rolls compose correctly. For a climb,
		// endAngle=π means the cube lands "upside-down" relative to its
		// pre-tip pose — the former bottom face is now on top. Intentional.
		const finalRot = mat4.axisRotation(tip.axis, tip.endAngle);
		mat4.multiply(finalRot, tip.baseOrientation, entity.orientation);
		entity.tip = null;
	}
}

/**
 * Sphere-vs-cube collision. Wrap-aware: shifts the cube to the copy nearest
 * the sphere before the AABB test. The cube is treated as infinite mass —
 * only the sphere moves and receives impulse. Cube restitution forced to 0
 * so bounce is driven by the sphere's own restitution alone; matches the
 * design intent that cubes act as inelastic platforms.
 */
export function resolveSphereVsCube(
	sphere: Entity,
	cube: Entity,
	ww: number,
): void {
	const hw = ww / 2;
	let cx = cube.x;
	let cz = cube.z;
	const dxRaw = sphere.x - cx;
	const dzRaw = sphere.z - cz;
	if (dxRaw > hw) cx += ww;
	else if (dxRaw < -hw) cx -= ww;
	if (dzRaw > hw) cz += ww;
	else if (dzRaw < -hw) cz -= ww;

	const s = cube.scale;
	resolveSphereVsAABB(
		sphere,
		cx - s,
		cx + s,
		cube.y - s,
		cube.y + s,
		cz - s,
		cz + s,
		sphere.restitution,
		0,
	);
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
