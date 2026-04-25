/**
 * Cross-shape entity-vs-entity collision. Runs in Pass 2 of
 * `EntityManager.update` so pair resolution sees finalized post-integration
 * positions.
 *
 *   - sphere ↔ sphere: mass-weighted depenetration + classical impulse.
 *   - sphere ↔ cube: cube treated as infinite mass; only sphere moves.
 *   - cube ↔ cube: deferred.
 *
 * Pattern for new pairs: wrap-aware narrowphase (use the world-wrapped copy
 * of `b` closest to `a`), inverse-mass depenetration, combined-max
 * restitution with sub-RESTING_THRESHOLD treatment for resting contact.
 */

import { resolveSphereVsAABB } from './sphere-physics';
import { RESTING_THRESHOLD } from './entity-physics-shared';
import type { Entity } from './entity';

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
 * Wrap-aware sphere-vs-cube. Cube = infinite mass; only the sphere moves.
 * Cube restitution forced to 0 so bounce comes from the sphere alone
 * (cubes are inelastic platforms by design).
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
