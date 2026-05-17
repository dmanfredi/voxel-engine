/**
 * Entity AI — per-tick behavior dispatch based on entity.role.
 *
 * AI writes to entity velocity; physics (run after AI) integrates velocity
 * into position and resolves collisions. Mirrors the player's thrust+drag
 * model from movement.ts so rusher speed/feel lands near the player's own.
 *
 * Currently only Role.Rush is implemented. Zone and Crush dispatch to no-ops.
 */

import type { Entity } from './entity';
import { Role } from './entity';
import type { FlowField } from './flow-field';

const MC_TICK = 0.05;
const RUSH_GROUND_ACCEL = 1.0;
const RUSH_AIR_ACCEL = 0.5;
const GROUND_DRAG = 0.9;
const AIR_DRAG = 0.91;
const MAX_H_SPEED = 8;

// Scratch buffer for FlowField.sampleDirection — reused across all entities
// within a tick. Safe because AI ticks are single-threaded.
const dirOut = new Float32Array(3);

export function entityAITick(
	entity: Entity,
	playerPos: Float32Array,
	baseSpeed: number,
	mass: number,
	ww: number,
	blockSize: number,
	flowField: FlowField,
	dt: number,
): void {
	switch (entity.role) {
		case Role.Rush:
			rush(
				entity,
				playerPos,
				baseSpeed,
				mass,
				ww,
				blockSize,
				flowField,
				dt,
			);
			break;
		case Role.Zone:
		case Role.Crush:
			// future behaviors
			break;
	}
}

/**
 * Pursuit direction comes from the flow field when sampleable — the
 * gradient routes around terrain, solving pillar-vs-pillar stalemates and
 * concave-corner stuck cases that pure pursuit can't. Falls back to
 * wrap-aware direct delta when the entity is outside the field, in an
 * unreachable cell, or the gradient is degenerate.
 *
 * Attached spheres take the 3D tangent-climb branch (rushAttached);
 * airborne spheres take the horizontal-only branch (mostly spawn drop or
 * post-bonk recovery). The direction source is the same either way.
 *
 * Mass scales both sides of the velocity curve: accel = F/m (heavy ramps up
 * slowly) and drag_per_tick = baseDrag^(1/mass) (heavy decelerates slowly).
 * Terminal speed stays roughly mass-invariant; the time constant is what
 * changes.
 */
function rush(
	entity: Entity,
	playerPos: Float32Array,
	baseSpeed: number,
	mass: number,
	ww: number,
	blockSize: number,
	flowField: FlowField,
	dt: number,
): void {
	const t = dt / MC_TICK;

	// Offset the sample point toward the contact surface when attached.
	// Sphere center cells can sit 2 Chebyshev cells from the contacted
	// solid (e.g. sphere on flat ground: center is `r` above top face,
	// floor-cell is 2 cells below). Stepping back by blockSize/2 along
	// the inward normal lands the sample in a cell ≤ 1 Chebyshev from a
	// solid, so the K=1 near-surface dilation always covers it.
	// Airborne spheres sample at center.
	let sx = entity.x;
	let sy = entity.y;
	let sz = entity.z;
	if (entity.attached) {
		const half = blockSize * 0.5;
		sx -= entity.contactNx * half;
		sy -= entity.contactNy * half;
		sz -= entity.contactNz * half;
	}

	let dirX: number;
	let dirY: number;
	let dirZ: number;
	const fieldOk = flowField.sampleDirection(
		sx,
		sy,
		sz,
		ww,
		blockSize,
		dirOut,
	);
	if (fieldOk) {
		dirX = dirOut[0];
		dirY = dirOut[1];
		dirZ = dirOut[2];
	} else {
		const hw = ww / 2;
		let dx = (playerPos[0] ?? 0) - entity.x;
		const dy = (playerPos[1] ?? 0) - entity.y;
		let dz = (playerPos[2] ?? 0) - entity.z;
		if (dx > hw) dx -= ww;
		else if (dx < -hw) dx += ww;
		if (dz > hw) dz -= ww;
		else if (dz < -hw) dz += ww;
		const len = Math.hypot(dx, dy, dz);
		if (len < 1e-3) {
			// Player essentially on us — drag only this frame.
			applyHorizontalDrag(entity, t, mass);
			return;
		}
		dirX = dx / len;
		dirY = dy / len;
		dirZ = dz / len;
	}

	if (entity.attached) {
		rushAttached(entity, dirX, dirY, dirZ, baseSpeed, mass, t);
		return;
	}

	// Airborne: drop the vertical component, normalize the horizontal,
	// thrust XZ. A flow-field direction with a strong dy (player above on
	// a platform) collapses to its horizontal projection — fine, because
	// the gradient already routed around the obstacle.
	const horizSq = dirX * dirX + dirZ * dirZ;
	if (horizSq > 1e-6) {
		const horizLen = Math.sqrt(horizSq);
		const baseAccel = entity.grounded ? RUSH_GROUND_ACCEL : RUSH_AIR_ACCEL;
		const accel = (baseAccel * baseSpeed) / mass;
		entity.vx += (dirX / horizLen) * accel * t;
		entity.vz += (dirZ / horizLen) * accel * t;
	}

	applyHorizontalDrag(entity, t, mass);

	// Safety cap — well above natural terminal, just prevents runaways.
	const hSpeedSq = entity.vx * entity.vx + entity.vz * entity.vz;
	if (hSpeedSq > MAX_H_SPEED * MAX_H_SPEED) {
		const scale = MAX_H_SPEED / Math.sqrt(hSpeedSq);
		entity.vx *= scale;
		entity.vz *= scale;
	}
}

function applyHorizontalDrag(entity: Entity, t: number, mass: number): void {
	const drag = entity.grounded ? GROUND_DRAG : AIR_DRAG;
	const dragT = drag ** (t / mass);
	entity.vx *= dragT;
	entity.vz *= dragT;
}

/**
 * 3D rush along the contact tangent plane. Drag applies to all three
 * axes — without vy drag, climbing with no gravity would let vy grow
 * unbounded. Speed cap reuses MAX_H_SPEED on the 3D magnitude.
 *
 * Uses RUSH_GROUND_ACCEL / GROUND_DRAG unconditionally — by definition
 * the sphere is in contact with a surface, so ground feel is right
 * whether that surface is a floor, wall, or ceiling.
 */
function rushAttached(
	entity: Entity,
	dirX: number,
	dirY: number,
	dirZ: number,
	baseSpeed: number,
	mass: number,
	t: number,
): void {
	// Project onto tangent plane: dir -= (dir · n) n
	const dotN =
		dirX * entity.contactNx +
		dirY * entity.contactNy +
		dirZ * entity.contactNz;
	const tx = dirX - dotN * entity.contactNx;
	const ty = dirY - dotN * entity.contactNy;
	const tz = dirZ - dotN * entity.contactNz;

	const tangentLen = Math.hypot(tx, ty, tz);
	// Direction collapses to zero when it's exactly along the contact normal
	// (e.g. player directly on the other side of a thin ceiling). Skip
	// thrust; drag still runs.
	if (tangentLen > 1e-4) {
		const accel = (RUSH_GROUND_ACCEL * baseSpeed) / mass;
		entity.vx += (tx / tangentLen) * accel * t;
		entity.vy += (ty / tangentLen) * accel * t;
		entity.vz += (tz / tangentLen) * accel * t;
	}

	const dragT = GROUND_DRAG ** (t / mass);
	entity.vx *= dragT;
	entity.vy *= dragT;
	entity.vz *= dragT;

	const speedSq =
		entity.vx * entity.vx + entity.vy * entity.vy + entity.vz * entity.vz;
	if (speedSq > MAX_H_SPEED * MAX_H_SPEED) {
		const scale = MAX_H_SPEED / Math.sqrt(speedSq);
		entity.vx *= scale;
		entity.vy *= scale;
		entity.vz *= scale;
	}
}
