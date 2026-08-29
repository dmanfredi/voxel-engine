import { vec3, type Vec3 } from 'wgpu-matrix';
import type { World } from './world';
import { moveAndCollide } from './collision';

const MC_TICK = 0.05;
const JUMP_VELOCITY = 6.4;
const GRAVITY = 0.8;
const VERTICAL_DRAG = 0.98;
const TERMINAL_VELOCITY = -39.2;
const GROUND_ACCEL = 2;
const AIR_ACCEL = 0.5;
const GROUND_DRAG = 0.546;
const AIR_DRAG = 0.895;
const SPRINT_JUMP_BOOST = 0;
const NEGLIGIBLE_THRESHOLD = 0.05;
const JUMP_COOLDOWN = 0.4;
// Air-jump knobs, deliberately parallel to the ground set so the recovery
// jump can be retuned without disturbing the jump taken off the floor.
const AIR_JUMP_VELOCITY = 6.4;
const AIR_SPRINT_JUMP_BOOST = 0;
const AIR_JUMP_COOLDOWN = 0.4;

/** Air jumps available between landings. */
export const MAX_AIR_JUMPS = 1;

export interface PlayerState {
	velX: number;
	velY: number;
	velZ: number;
	onGround: boolean;
	jumpCooldown: number; // seconds remaining
	/** Vertical gain from auto-step on the last move; 0 when none. */
	steppedUp: number;
	/** Air jumps left; landing restores them. */
	airJumpsLeft: number;
}

export function createPlayerState(): PlayerState {
	return {
		velX: 0,
		velY: 0,
		velZ: 0,
		onGround: false,
		jumpCooldown: 0,
		steppedUp: 0,
		airJumpsLeft: MAX_AIR_JUMPS,
	};
}

/** Write the player's tick-scaled physics velocity in world units per second. */
export function writePlayerVelocityPerSecond(
	state: PlayerState,
	out: Float32Array,
): void {
	out[0] = state.velX / MC_TICK;
	// Ground resolution zeroes Y before gravity seeds the next frame's floor
	// probe. That probe is not real source motion for a projectile to inherit.
	out[1] = state.onGround && state.velY < 0 ? 0 : state.velY / MC_TICK;
	out[2] = state.velZ / MC_TICK;
}

function getMovementDirection(
	keysDown: Set<string>,
	cameraFront: Vec3,
	cameraUp: Vec3,
): [number, number, number] {
	let dx = 0;
	let dz = 0;

	const right = vec3.normalize(vec3.cross(cameraFront, cameraUp));
	const forward = vec3.normalize(vec3.cross(cameraUp, right));

	const fx = forward[0] ?? 0;
	const fz = forward[2] ?? 0;
	const rx = right[0] ?? 0;
	const rz = right[2] ?? 0;

	if (keysDown.has('KeyW')) {
		dx += fx;
		dz += fz;
	}
	if (keysDown.has('KeyS')) {
		dx -= fx;
		dz -= fz;
	}
	if (keysDown.has('KeyA')) {
		dx -= rx;
		dz -= rz;
	}
	if (keysDown.has('KeyD')) {
		dx += rx;
		dz += rz;
	}

	const len = Math.sqrt(dx * dx + dz * dz);
	if (len > 0) {
		dx /= len;
		dz /= len;
	}

	return [dx, 0, dz];
}

/**
 * Apply a jump impulse. Downward velocity is clamped away rather than
 * overwritten: a jump taken while falling still yields its full height, and
 * one taken while already rising stacks onto the launch instead of arresting
 * it — the difference matters the moment anything can throw the player.
 */
function launch(
	state: PlayerState,
	keysDown: Set<string>,
	cameraFront: Vec3,
	velocity: number,
	cooldown: number,
	boost: number,
): void {
	state.velY = Math.max(0, state.velY) + velocity;
	state.jumpCooldown = cooldown;

	// Jump boost toward facing (only when moving)
	if (
		keysDown.has('KeyW') ||
		keysDown.has('KeyA') ||
		keysDown.has('KeyS') ||
		keysDown.has('KeyD')
	) {
		const facingX = cameraFront[0] ?? 0;
		const facingZ = cameraFront[2] ?? 0;
		const facingLen = Math.sqrt(facingX * facingX + facingZ * facingZ);
		if (facingLen > 0) {
			state.velX += (facingX / facingLen) * boost;
			state.velZ += (facingZ / facingLen) * boost;
		}
	}
}

export function physicsTick(
	state: PlayerState,
	keysDown: Set<string>,
	cameraFront: Vec3,
	cameraUp: Vec3,
	pos: Float32Array,
	world: World,
	halfWidth: number,
	height: number,
	dt: number,
): boolean {
	const t = dt / MC_TICK;

	// Jump cooldown. Runs purely on time.
	if (state.jumpCooldown > 0) state.jumpCooldown -= dt;

	// Negligible vertical threshold
	if (Math.abs(state.velY) < NEGLIGIBLE_THRESHOLD * t) state.velY = 0;

	// Jump check. The cooldown is the sole rate limiter, so holding the key
	// takes every jump the instant it becomes available — the air jump included,
	// which by the cooldown's length arrives near the apex of the first.
	let justJumped = false;
	if (keysDown.has('Space') && state.jumpCooldown <= 0) {
		if (state.onGround) {
			launch(
				state,
				keysDown,
				cameraFront,
				JUMP_VELOCITY,
				JUMP_COOLDOWN,
				SPRINT_JUMP_BOOST,
			);
			justJumped = true;
		} else if (state.airJumpsLeft > 0) {
			state.airJumpsLeft--;
			launch(
				state,
				keysDown,
				cameraFront,
				AIR_JUMP_VELOCITY,
				AIR_JUMP_COOLDOWN,
				AIR_SPRINT_JUMP_BOOST,
			);
			justJumped = true;
		}
	}

	const dir = getMovementDirection(keysDown, cameraFront, cameraUp);
	const hasInput = dir[0] !== 0 || dir[2] !== 0;

	// Horizontal velocity: drag is exponential, accel is linear
	if (state.onGround && !justJumped) {
		const drag = GROUND_DRAG ** t;
		const accel = GROUND_ACCEL * t;
		let momX = state.velX * drag;
		let momZ = state.velZ * drag;
		if (Math.abs(momX) < NEGLIGIBLE_THRESHOLD * t) momX = 0;
		if (Math.abs(momZ) < NEGLIGIBLE_THRESHOLD * t) momZ = 0;
		state.velX = momX + (hasInput ? accel * dir[0] : 0);
		state.velZ = momZ + (hasInput ? accel * dir[2] : 0);
	} else {
		const drag = AIR_DRAG ** t;
		const accel = AIR_ACCEL * t;
		let momX = state.velX * drag;
		let momZ = state.velZ * drag;
		if (Math.abs(momX) < NEGLIGIBLE_THRESHOLD * t) momX = 0;
		if (Math.abs(momZ) < NEGLIGIBLE_THRESHOLD * t) momZ = 0;
		state.velX = momX + (hasInput ? accel * dir[0] : 0);
		state.velZ = momZ + (hasInput ? accel * dir[2] : 0);
	}

	// Move and collide
	const result = moveAndCollide(
		pos,
		[state.velX * t, state.velY * t, state.velZ * t],
		world,
		halfWidth,
		height,
		state.onGround,
	);

	state.steppedUp = result.steppedUp;

	// Zero velocity on collided axes
	if (result.collidedX) state.velX = 0;
	if (result.collidedZ) state.velZ = 0;
	if (result.onGround) state.velY = 0;
	if (result.collidedCeiling) state.velY = 0;

	// Vertical physics (after move)
	state.velY -= GRAVITY * t;
	state.velY *= VERTICAL_DRAG ** t;
	if (state.velY < TERMINAL_VELOCITY) state.velY = TERMINAL_VELOCITY;

	// Update ground state. Landing restores the air charge whether or not a
	// ground jump preceded it — the case this exists for is walking off an
	// edge you never meant to leave.
	state.onGround = result.onGround;
	if (result.onGround) state.airJumpsLeft = MAX_AIR_JUMPS;

	return justJumped;
}

export function FREECAM(
	keysDown: Set<string>,
	cameraPos: Vec3,
	cameraFront: Vec3,
	cameraUp: Vec3,
	units: number,
) {
	if (keysDown.has('KeyW')) {
		vec3.add(cameraPos, vec3.mulScalar(cameraFront, units), cameraPos);
	}
	if (keysDown.has('KeyS')) {
		vec3.sub(cameraPos, vec3.mulScalar(cameraFront, units), cameraPos);
	}
	if (keysDown.has('KeyA')) {
		const right = vec3.cross(cameraFront, cameraUp);
		const normalRight = vec3.normalize(right);
		const move = vec3.mulScalar(normalRight, units);
		vec3.sub(cameraPos, move, cameraPos);
	}
	if (keysDown.has('KeyD')) {
		const right = vec3.cross(cameraFront, cameraUp);
		const normalRight = vec3.normalize(right);
		const move = vec3.mulScalar(normalRight, units);
		vec3.add(cameraPos, move, cameraPos);
	}
	if (keysDown.has('Space')) {
		vec3.add(cameraPos, vec3.mulScalar(cameraUp, units), cameraPos);
	}
	if (keysDown.has('ShiftLeft')) {
		vec3.sub(cameraPos, vec3.mulScalar(cameraUp, units), cameraPos);
	}
}
