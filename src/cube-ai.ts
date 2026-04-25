/**
 * Cube AI — per-frame tip-attempt cadence and targeting. Each frame
 * decides whether to start a tip, and in which direction.
 *
 * Role-agnostic for now; Zone/Crush will branch inside `tipCubeTowardPlayer`.
 * See notes/cube-enemy.md.
 */

import type { Entity } from './entity';

/**
 * Gameplay-level tip primitive, injected by EntityManager — needs world
 * mutation and entity overlap queries that AI shouldn't reach into directly.
 */
export type TryTipFn = (
	entity: Entity,
	direction: [number, number, number],
) => boolean;

/**
 * Tick cooldown; on expiry, attempt a tip if grounded. Cooldown ticks
 * regardless of grounded so airborne cubes fire on the next grounded
 * frame rather than waiting a full interval. Mid-tip cubes skip entirely.
 */
export function cubeAITick(
	entity: Entity,
	playerPos: Float32Array,
	ww: number,
	dt: number,
	tryTip: TryTipFn,
): void {
	if (entity.tip !== null) return;
	entity.tipCooldown -= dt;
	if (entity.tipCooldown <= 0 && entity.grounded) {
		tipCubeTowardPlayer(entity, playerPos, ww, tryTip);
		entity.tipCooldown = entity.tipInterval;
	}
}

/**
 * Beeline toward the player via `tryTip` (so scaffolding runs).
 *
 *   - dy > edge (vertical intent): climb by alternating sign of
 *     `lastClimbDx/Dz` — two climbs net +2·edge vertical, zero horizontal.
 *     First climb seeds from dominant horizontal axis.
 *   - else: horizontal walk toward dominant axis; if blocked, climb in
 *     the same direction (scaffolding fills walls).
 *
 * `tryTip` updates `lastClimbDx/Dz` on success, so both branches feed the
 * zigzag.
 */
function tipCubeTowardPlayer(
	entity: Entity,
	playerPos: Float32Array,
	ww: number,
	tryTip: TryTipFn,
): void {
	const px = playerPos[0] ?? 0;
	const py = playerPos[1] ?? 0;
	const pz = playerPos[2] ?? 0;
	const hw = ww / 2;

	// Wrap-aware player-relative direction (Y doesn't wrap)
	let dx = px - entity.x;
	const dy = py - entity.y;
	let dz = pz - entity.z;
	if (dx > hw) dx -= ww;
	else if (dx < -hw) dx += ww;
	if (dz > hw) dz -= ww;
	else if (dz < -hw) dz += ww;

	const edge = 2 * entity.scale;

	// Vertical intent — alternate, or seed from dominant axis on first climb.
	if (dy > edge) {
		let climbDx: number;
		let climbDz: number;
		if (entity.lastClimbDx !== 0 || entity.lastClimbDz !== 0) {
			climbDx = -entity.lastClimbDx;
			climbDz = -entity.lastClimbDz;
		} else if (Math.abs(dx) >= Math.abs(dz)) {
			climbDx = dx >= 0 ? 1 : -1;
			climbDz = 0;
		} else {
			climbDx = 0;
			climbDz = dz >= 0 ? 1 : -1;
		}
		if (tryTip(entity, [climbDx, 1, climbDz])) {
			return;
		}
		// Climb blocked — fall through; horizontal fallback may still climb
		// and re-seed the zigzag.
	}

	// Horizontal walk toward dominant player axis; ties break to X.
	let dirX = 0;
	let dirZ = 0;
	if (Math.abs(dx) >= Math.abs(dz)) {
		dirX = dx >= 0 ? 1 : -1;
	} else {
		dirZ = dz >= 0 ? 1 : -1;
	}
	if (tryTip(entity, [dirX, 0, dirZ])) return;
	tryTip(entity, [dirX, 1, dirZ]);
}
