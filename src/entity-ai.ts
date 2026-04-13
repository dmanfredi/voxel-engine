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
const RUSH_GROUND_ACCEL = 1.5;
const RUSH_AIR_ACCEL = 0.5;
const GROUND_DRAG = 0.546;
const AIR_DRAG = 0.91;
const MAX_H_SPEED = 8;

export function entityAITick(
	entity: Entity,
	playerPos: Float32Array,
	baseSpeed: number,
	ww: number,
	dt: number,
): void {
	switch (entity.role) {
		case Role.Rush:
			rush(entity, playerPos, baseSpeed, ww, dt);
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
 */
function rush(
	entity: Entity,
	playerPos: Float32Array,
	baseSpeed: number,
	ww: number,
	dt: number,
): void {
	const t = dt / MC_TICK;
	const hw = ww / 2;

	// Wrap-aware horizontal direction to player
	let dx = (playerPos[0] ?? 0) - entity.x;
	let dz = (playerPos[2] ?? 0) - entity.z;
	if (dx > hw) dx -= ww;
	else if (dx < -hw) dx += ww;
	if (dz > hw) dz -= ww;
	else if (dz < -hw) dz += ww;

	const distSq = dx * dx + dz * dz;
	if (distSq > 1e-4) {
		const dist = Math.sqrt(distSq);
		const accel =
			(entity.grounded ? RUSH_GROUND_ACCEL : RUSH_AIR_ACCEL) * baseSpeed;
		entity.vx += (dx / dist) * accel * t;
		entity.vz += (dz / dist) * accel * t;
	}

	// Drag — matches player model. Applied whether or not we thrusted.
	const drag = entity.grounded ? GROUND_DRAG : AIR_DRAG;
	const dragT = drag ** t;
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
