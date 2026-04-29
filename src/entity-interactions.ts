/**
 * Cross-shape entity-vs-entity (and player-vs-entity) collision. Runs in
 * Pass 2 / Pass 2.5 of `EntityManager.update` so pair resolution sees
 * finalized post-integration positions.
 *
 *   - sphere ↔ sphere: mass-weighted depenetration + classical impulse.
 *   - sphere ↔ cube: OBB closest-point in cube-local space; cube treated
 *       as infinite mass; only sphere moves. Inelastic on the cube side.
 *   - player ↔ cube: AABB-vs-OBB SAT; player depenetrated, cube unaffected.
 *   - cube ↔ cube: deferred.
 *
 * Pattern for new pairs: wrap-aware narrowphase (use the world-wrapped copy
 * of `b` closest to `a`), inverse-mass depenetration, combined-max
 * restitution with sub-RESTING_THRESHOLD treatment for resting contact.
 *
 * Fling: when a tipping cube depenetrates an entity, the entity's velocity
 * along the tip's horizontal direction is raised to at least the cube's
 * average arc speed × FLING_BOOST. Models the cube "smacking" the entity
 * along its rotation. Hardcoded direction (dx,dz) — vertical fling on
 * climbs is intentionally ignored (simple, satisfying enough).
 */

// Boost over the cube's average horizontal arc speed (`edge / tipDuration`).
const FLING_BOOST = 0.4;
const MAX_FLING_SPEED = 60;
const MIN_FLING_SPEED = 20;

import { getCubeOBB, type CubeOBB } from './cube-physics';
import { RESTING_THRESHOLD } from './entity-physics-shared';
import type { Entity } from './entity';

// Scratch — the pair loop bounds one cube at a time, so a single shared
// instance is safe.
const cubeOBBScratch: CubeOBB = {
	cx: 0,
	cy: 0,
	cz: 0,
	s: 0,
	ax: new Float32Array(3),
	ay: new Float32Array(3),
	az: new Float32Array(3),
};

/**
 * Wrap-aware contact normal; mass-weighted depenetration; classical impulse
 * with combined-max restitution. Sub-threshold approaches use resting-contact
 * (no bounce). Momentum-conserving; no angular effects.
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

	// Mass-weighted depenetration via inverse-mass form: aPush:bPush = mB:mA.
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
 * Sphere-vs-OBB closest-point: project sphere center into cube-local space,
 * clamp to ±s, distance-test in local space, transform contact normal back
 * to world. Cube = infinite mass, restitution 0 (cubes are inelastic
 * platforms by design). Wrap-aware.
 */
export function resolveSphereVsCube(
	sphere: Entity,
	cube: Entity,
	ww: number,
): void {
	getCubeOBB(cube, cubeOBBScratch);
	let cx = cubeOBBScratch.cx;
	const cy = cubeOBBScratch.cy;
	let cz = cubeOBBScratch.cz;
	const s = cubeOBBScratch.s;
	const ax = cubeOBBScratch.ax;
	const ay = cubeOBBScratch.ay;
	const az = cubeOBBScratch.az;

	// Wrap-shift cube center to the copy nearest the sphere.
	const hw = ww / 2;
	const dxRaw = sphere.x - cx;
	const dzRaw = sphere.z - cz;
	if (dxRaw > hw) cx += ww;
	else if (dxRaw < -hw) cx -= ww;
	if (dzRaw > hw) cz += ww;
	else if (dzRaw < -hw) cz -= ww;

	// World-space delta cube → sphere, then project onto cube-local axes.
	const dxw = sphere.x - cx;
	const dyw = sphere.y - cy;
	const dzw = sphere.z - cz;
	const lx = dxw * ax[0] + dyw * ax[1] + dzw * ax[2];
	const ly = dxw * ay[0] + dyw * ay[1] + dzw * ay[2];
	const lz = dxw * az[0] + dyw * az[1] + dzw * az[2];

	const r = sphere.scale;

	// Closest point on the (cube-local, axis-aligned) box.
	const cpX = Math.max(-s, Math.min(s, lx));
	const cpY = Math.max(-s, Math.min(s, ly));
	const cpZ = Math.max(-s, Math.min(s, lz));
	const ldx = lx - cpX;
	const ldy = ly - cpY;
	const ldz = lz - cpZ;
	const distSq = ldx * ldx + ldy * ldy + ldz * ldz;

	if (distSq >= r * r) return;

	let lnx: number, lny: number, lnz: number, penetration: number;
	if (distSq < 1e-6) {
		// Sphere center inside the OBB — push out along the nearest local face.
		const dToMinX = lx + s;
		const dToMaxX = s - lx;
		const dToMinY = ly + s;
		const dToMaxY = s - ly;
		const dToMinZ = lz + s;
		const dToMaxZ = s - lz;

		let minDist = dToMinX;
		lnx = -1;
		lny = 0;
		lnz = 0;
		if (dToMaxX < minDist) {
			minDist = dToMaxX;
			lnx = 1;
			lny = 0;
			lnz = 0;
		}
		if (dToMinY < minDist) {
			minDist = dToMinY;
			lnx = 0;
			lny = -1;
			lnz = 0;
		}
		if (dToMaxY < minDist) {
			minDist = dToMaxY;
			lnx = 0;
			lny = 1;
			lnz = 0;
		}
		if (dToMinZ < minDist) {
			minDist = dToMinZ;
			lnx = 0;
			lny = 0;
			lnz = -1;
		}
		if (dToMaxZ < minDist) {
			minDist = dToMaxZ;
			lnx = 0;
			lny = 0;
			lnz = 1;
		}
		penetration = minDist + r;
	} else {
		const dist = Math.sqrt(distSq);
		lnx = ldx / dist;
		lny = ldy / dist;
		lnz = ldz / dist;
		penetration = r - dist;
	}

	// Local normal back to world: n = lnx·ax + lny·ay + lnz·az.
	const nx = lnx * ax[0] + lny * ay[0] + lnz * az[0];
	const ny = lnx * ax[1] + lny * ay[1] + lnz * az[1];
	const nz = lnx * ax[2] + lny * ay[2] + lnz * az[2];

	sphere.x += nx * penetration;
	sphere.y += ny * penetration;
	sphere.z += nz * penetration;

	if (ny > 0.5) sphere.grounded = true;

	const vDotN = sphere.vx * nx + sphere.vy * ny + sphere.vz * nz;
	if (vDotN < 0) {
		const inwardSpeed = -vDotN;
		const factor =
			inwardSpeed < RESTING_THRESHOLD ? 1 : 1 + sphere.restitution;
		sphere.vx -= factor * vDotN * nx;
		sphere.vy -= factor * vDotN * ny;
		sphere.vz -= factor * vDotN * nz;
	}

	// Fling — only fires when the cube is actively tipping. Raises horizontal
	// velocity along the tip direction to at least the boosted arc speed; if
	// the entity is already moving that fast (or faster), no-op. Naturally
	// handles continuous contact: each frame tops the entity back up to
	// flingSpeed without runaway acceleration.
	const tip = cube.tip;
	if (tip !== null) {
		let flingSpeed = (FLING_BOOST * (2 * cube.scale)) / cube.tipDuration;
		flingSpeed = Math.max(flingSpeed, MIN_FLING_SPEED); // floor
		flingSpeed = Math.min(flingSpeed, MAX_FLING_SPEED); // ceiling
		const along = sphere.vx * tip.dx + sphere.vz * tip.dz;
		if (along < flingSpeed) {
			const delta = flingSpeed - along;
			sphere.vx += delta * tip.dx;
			sphere.vz += delta * tip.dz;
		}
	}
}

// SAT scratch — single instance, repopulated each call to resolvePlayerVsCube.
interface SATState {
	minOverlap: number;
	mtvX: number;
	mtvY: number;
	mtvZ: number;
}
const satState: SATState = { minOverlap: 0, mtvX: 0, mtvY: 0, mtvZ: 0 };

/**
 * Test one separating-axis candidate. Returns false on separation (caller
 * must bail). Otherwise updates `state` if this axis has the smallest
 * overlap so far. Skips degenerate axes (parallel face pairs).
 *
 * `lx,ly,lz` candidate axis (any length; normalized inside).
 * `hwx,hh,hwz` AABB half-extents along world axes.
 * `s, ax,ay,az` OBB uniform half-extent + unit axes.
 * `dx,dy,dz` OBB.center − AABB.center.
 */
function satTestAxis(
	lx: number,
	ly: number,
	lz: number,
	hwx: number,
	hh: number,
	hwz: number,
	s: number,
	ax: Float32Array,
	ay: Float32Array,
	az: Float32Array,
	dx: number,
	dy: number,
	dz: number,
	state: SATState,
): boolean {
	const lenSq = lx * lx + ly * ly + lz * lz;
	if (lenSq < 1e-6) return true; // degenerate (parallel axes — already covered)

	const inv = 1 / Math.sqrt(lenSq);
	const nx = lx * inv;
	const ny = ly * inv;
	const nz = lz * inv;

	// AABB radius along n (world axes are 1,0,0 / 0,1,0 / 0,0,1).
	const rA = hwx * Math.abs(nx) + hh * Math.abs(ny) + hwz * Math.abs(nz);
	// OBB radius along n; uniform extent s.
	const rB =
		s *
		(Math.abs(ax[0] * nx + ax[1] * ny + ax[2] * nz) +
			Math.abs(ay[0] * nx + ay[1] * ny + ay[2] * nz) +
			Math.abs(az[0] * nx + az[1] * ny + az[2] * nz));

	const cd = dx * nx + dy * ny + dz * nz;
	const overlap = rA + rB - Math.abs(cd);
	if (overlap <= 0) return false; // separating axis

	if (overlap < state.minOverlap) {
		state.minOverlap = overlap;
		// Push AABB away from OBB. d points AABB→OBB; cd>0 means OBB sits on
		// the +n side, so MTV = −n. Otherwise +n.
		const sign = cd > 0 ? -1 : 1;
		state.mtvX = sign * nx;
		state.mtvY = sign * ny;
		state.mtvZ = sign * nz;
	}
	return true;
}

/** Minimal player velocity contract — `PlayerState` from movement.ts satisfies it. */
export interface PlayerVelLike {
	velX: number;
	velY: number;
	velZ: number;
}

/**
 * Player AABB vs cube OBB — full SAT (15 axes: 3 world + 3 OBB + 9 edge
 * crosses). On overlap, pushes player along the minimum-translation axis.
 * Cube is infinite mass — only the player moves.
 *
 * If the cube is mid-tip, fling: raise player's horizontal velocity along
 * (tip.dx, tip.dz) to at least the cube's boosted arc speed. Otherwise
 * leaves velocity alone (player's movement system owns it).
 *
 * Player AABB: X/Z in [pos±halfWidth], Y in [pos.y−height, pos.y]. AABB
 * center is `(px, py − height/2, pz)` because `playerPos[1]` is the eye,
 * not the body center.
 */
export function resolvePlayerVsCube(
	playerPos: Float32Array,
	playerVel: PlayerVelLike,
	playerHalfWidth: number,
	playerHeight: number,
	cube: Entity,
	ww: number,
): void {
	getCubeOBB(cube, cubeOBBScratch);
	let cx = cubeOBBScratch.cx;
	const cy = cubeOBBScratch.cy;
	let cz = cubeOBBScratch.cz;
	const s = cubeOBBScratch.s;
	const ax = cubeOBBScratch.ax;
	const ay = cubeOBBScratch.ay;
	const az = cubeOBBScratch.az;

	const px = playerPos[0] ?? 0;
	const py = playerPos[1] ?? 0;
	const pz = playerPos[2] ?? 0;

	// Wrap-shift cube to closest copy of player.
	const hw = ww / 2;
	const dxRaw = px - cx;
	const dzRaw = pz - cz;
	if (dxRaw > hw) cx += ww;
	else if (dxRaw < -hw) cx -= ww;
	if (dzRaw > hw) cz += ww;
	else if (dzRaw < -hw) cz -= ww;

	const hh = playerHeight / 2;
	const aabbCY = py - hh;
	const dx = cx - px;
	const dy = cy - aabbCY;
	const dz = cz - pz;

	satState.minOverlap = Infinity;
	satState.mtvX = 0;
	satState.mtvY = 0;
	satState.mtvZ = 0;

	// 3 world face axes
	if (
		!satTestAxis(
			1,
			0,
			0,
			playerHalfWidth,
			hh,
			playerHalfWidth,
			s,
			ax,
			ay,
			az,
			dx,
			dy,
			dz,
			satState,
		)
	)
		return;
	if (
		!satTestAxis(
			0,
			1,
			0,
			playerHalfWidth,
			hh,
			playerHalfWidth,
			s,
			ax,
			ay,
			az,
			dx,
			dy,
			dz,
			satState,
		)
	)
		return;
	if (
		!satTestAxis(
			0,
			0,
			1,
			playerHalfWidth,
			hh,
			playerHalfWidth,
			s,
			ax,
			ay,
			az,
			dx,
			dy,
			dz,
			satState,
		)
	)
		return;

	// 3 OBB face axes
	if (
		!satTestAxis(
			ax[0],
			ax[1],
			ax[2],
			playerHalfWidth,
			hh,
			playerHalfWidth,
			s,
			ax,
			ay,
			az,
			dx,
			dy,
			dz,
			satState,
		)
	)
		return;
	if (
		!satTestAxis(
			ay[0],
			ay[1],
			ay[2],
			playerHalfWidth,
			hh,
			playerHalfWidth,
			s,
			ax,
			ay,
			az,
			dx,
			dy,
			dz,
			satState,
		)
	)
		return;
	if (
		!satTestAxis(
			az[0],
			az[1],
			az[2],
			playerHalfWidth,
			hh,
			playerHalfWidth,
			s,
			ax,
			ay,
			az,
			dx,
			dy,
			dz,
			satState,
		)
	)
		return;

	// 9 edge crosses: world_i × obb_j for i,j ∈ {0,1,2}.
	for (let j = 0; j < 3; j++) {
		const obb = j === 0 ? ax : j === 1 ? ay : az;
		// (1,0,0) × obb = (0, −obb.z, obb.y)
		if (
			!satTestAxis(
				0,
				-obb[2],
				obb[1],
				playerHalfWidth,
				hh,
				playerHalfWidth,
				s,
				ax,
				ay,
				az,
				dx,
				dy,
				dz,
				satState,
			)
		)
			return;
		// (0,1,0) × obb = (obb.z, 0, −obb.x)
		if (
			!satTestAxis(
				obb[2],
				0,
				-obb[0],
				playerHalfWidth,
				hh,
				playerHalfWidth,
				s,
				ax,
				ay,
				az,
				dx,
				dy,
				dz,
				satState,
			)
		)
			return;
		// (0,0,1) × obb = (−obb.y, obb.x, 0)
		if (
			!satTestAxis(
				-obb[1],
				obb[0],
				0,
				playerHalfWidth,
				hh,
				playerHalfWidth,
				s,
				ax,
				ay,
				az,
				dx,
				dy,
				dz,
				satState,
			)
		)
			return;
	}

	// All 15 axes overlap → translate AABB along MTV by minOverlap.
	playerPos[0] = px + satState.mtvX * satState.minOverlap;
	playerPos[1] = py + satState.mtvY * satState.minOverlap;
	playerPos[2] = pz + satState.mtvZ * satState.minOverlap;

	// Fling — same shape as sphere fling. Tipping cubes drag the player
	// along their horizontal arc direction; static cubes leave velocity alone.
	const tip = cube.tip;
	if (tip !== null) {
		let flingSpeed = (FLING_BOOST * (2 * cube.scale)) / cube.tipDuration;
		flingSpeed = Math.max(flingSpeed, MIN_FLING_SPEED); // floor
		flingSpeed = Math.min(flingSpeed, MAX_FLING_SPEED); // ceiling
		const along = playerVel.velX * tip.dx + playerVel.velZ * tip.dz;
		if (along < flingSpeed) {
			const delta = flingSpeed - along;
			playerVel.velX += delta * tip.dx;
			playerVel.velZ += delta * tip.dz;
		}
	}
}
