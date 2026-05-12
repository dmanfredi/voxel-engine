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

const MC_TICK = 0.05;
const RUSH_GROUND_ACCEL = 1.0;
const RUSH_AIR_ACCEL = 0.5;
const GROUND_DRAG = 0.9;
const AIR_DRAG = 0.91;
const MAX_H_SPEED = 8;

export function entityAITick(
	entity: Entity,
	playerPos: Float32Array,
	baseSpeed: number,
	mass: number,
	ww: number,
	dt: number,
): void {
	switch (entity.role) {
		case Role.Rush:
			rush(entity, playerPos, baseSpeed, mass, ww, dt);
			break;
		case Role.Zone:
		case Role.Crush:
			// future behaviors
			break;
	}
}

/**
 * Straight-line pursuit. Applies horizontal thrust toward the player with
 * exponential drag — same pattern as the player's own physics. Ground accel
 * is stronger than air accel, but thrust applies in both states (mid-air
 * steering allowed, matching the player).
 *
 * Mass scales both sides of the velocity curve: accel = F/m (heavy ramps up
 * slowly) and drag_per_tick = baseDrag^(1/mass) (heavy decelerates slowly).
 * Terminal speed stays roughly mass-invariant; the time constant is what
 * changes. A size-15 marble sphere takes multiple seconds to change direction;
 * a size-5 one turns on a dime.
 */
function rush(
	entity: Entity,
	playerPos: Float32Array,
	baseSpeed: number,
	mass: number,
	ww: number,
	dt: number,
): void {
	const t = dt / MC_TICK;
	const hw = ww / 2;

	// Wrap-aware direction to player. Y doesn't wrap.
	let dx = (playerPos[0] ?? 0) - entity.x;
	const dy = (playerPos[1] ?? 0) - entity.y;
	let dz = (playerPos[2] ?? 0) - entity.z;
	if (dx > hw) dx -= ww;
	else if (dx < -hw) dx += ww;
	if (dz > hw) dz -= ww;
	else if (dz < -hw) dz += ww;

	// Attached → 3D climb on tangent plane. Airborne → horizontal-only
	// chase (mostly the spawn drop or post-bonk recovery).
	if (entity.attached) {
		rushAttached(entity, dx, dy, dz, baseSpeed, mass, t);
		return;
	}

	const distSq = dx * dx + dz * dz;
	if (distSq > 1e-4) {
		const dist = Math.sqrt(distSq);
		const baseAccel = entity.grounded ? RUSH_GROUND_ACCEL : RUSH_AIR_ACCEL;
		const accel = (baseAccel * baseSpeed) / mass;
		entity.vx += (dx / dist) * accel * t;
		entity.vz += (dz / dist) * accel * t;
	}

	// Drag — mass-scaled. Applied whether or not we thrusted.
	const drag = entity.grounded ? GROUND_DRAG : AIR_DRAG;
	const dragT = drag ** (t / mass);
	entity.vx *= dragT;
	entity.vz *= dragT;

	// Safety cap — well above natural terminal, just prevents runaways
	const hSpeedSq = entity.vx * entity.vx + entity.vz * entity.vz;
	if (hSpeedSq > MAX_H_SPEED * MAX_H_SPEED) {
		const scale = MAX_H_SPEED / Math.sqrt(hSpeedSq);
		entity.vx *= scale;
		entity.vz *= scale;
	}
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
	dx: number,
	dy: number,
	dz: number,
	baseSpeed: number,
	mass: number,
	t: number,
): void {
	const distSq = dx * dx + dy * dy + dz * dz;
	if (distSq > 1e-4) {
		const dist = Math.sqrt(distSq);
		let dirX = dx / dist;
		let dirY = dy / dist;
		let dirZ = dz / dist;

		// Project onto tangent plane: dir -= (dir · n) n
		const dotN =
			dirX * entity.contactNx +
			dirY * entity.contactNy +
			dirZ * entity.contactNz;
		dirX -= dotN * entity.contactNx;
		dirY -= dotN * entity.contactNy;
		dirZ -= dotN * entity.contactNz;

		const tangentLen = Math.hypot(dirX, dirY, dirZ);
		// Player directly along the contact normal (e.g. exactly on the
		// other side of a thin ceiling) → tangent direction collapses to
		// zero. Skip thrust this frame; drag still runs.
		if (tangentLen > 1e-4) {
			const accel = (RUSH_GROUND_ACCEL * baseSpeed) / mass;
			entity.vx += (dirX / tangentLen) * accel * t;
			entity.vy += (dirY / tangentLen) * accel * t;
			entity.vz += (dirZ / tangentLen) * accel * t;
		}
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
