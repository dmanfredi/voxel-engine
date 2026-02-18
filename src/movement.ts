import { vec3, type Vec3 } from 'wgpu-matrix';
import type Block from './Block';
import { moveAndCollide } from './collision';

const MC_TICK = 0.05;
const JUMP_VELOCITY = 4.2;
const GRAVITY = 0.8;
const VERTICAL_DRAG = 0.98;
const TERMINAL_VELOCITY = -39.2;
const GROUND_ACCEL = 3;
const AIR_ACCEL = 0.26;
const GROUND_DRAG = 0.546;
const AIR_DRAG = 0.91;
const SPRINT_JUMP_BOOST = 2.8;
const NEGLIGIBLE_THRESHOLD = 0.05;
const JUMP_COOLDOWN = 0.5;

export interface PlayerState {
	velX: number;
	velY: number;
	velZ: number;
	onGround: boolean;
	jumpCooldown: number; // seconds remaining
}

export function createPlayerState(): PlayerState {
	return { velX: 0, velY: 0, velZ: 0, onGround: false, jumpCooldown: 0 };
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

export function physicsTick(
	state: PlayerState,
	keysDown: Set<string>,
	cameraFront: Vec3,
	cameraUp: Vec3,
	pos: Float32Array,
	blocks: Block[][][],
	dims: [number, number, number],
	blockSize: number,
	halfWidth: number,
	height: number,
	dt: number,
): void {
	const t = dt / MC_TICK;

	// Jump cooldown
	if (state.jumpCooldown > 0) state.jumpCooldown -= dt;

	// Negligible vertical threshold
	if (Math.abs(state.velY) < NEGLIGIBLE_THRESHOLD * t) state.velY = 0;

	// Jump check
	let justJumped = false;
	if (keysDown.has('Space')) {
		if (state.onGround && state.jumpCooldown <= 0) {
			state.velY = JUMP_VELOCITY;
			state.jumpCooldown = JUMP_COOLDOWN;
			justJumped = true;

			// Jump boost toward facing (only when moving)
			if (
				keysDown.has('KeyW') ||
				keysDown.has('KeyA') ||
				keysDown.has('KeyS') ||
				keysDown.has('KeyD')
			) {
				const facingX = cameraFront[0] ?? 0;
				const facingZ = cameraFront[2] ?? 0;
				const facingLen = Math.sqrt(
					facingX * facingX + facingZ * facingZ,
				);
				if (facingLen > 0) {
					state.velX += (facingX / facingLen) * SPRINT_JUMP_BOOST;
					state.velZ += (facingZ / facingLen) * SPRINT_JUMP_BOOST;
				}
			}
		}
	} else {
		state.jumpCooldown = 0;
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
		blocks,
		dims,
		blockSize,
		halfWidth,
		height,
	);

	// Zero velocity on collided axes
	if (result.collidedX) state.velX = 0;
	if (result.collidedZ) state.velZ = 0;
	if (result.onGround) state.velY = 0;
	if (result.collidedCeiling) state.velY = 0;

	// Vertical physics (after move)
	state.velY -= GRAVITY * t;
	state.velY *= VERTICAL_DRAG ** t;
	if (state.velY < TERMINAL_VELOCITY) state.velY = TERMINAL_VELOCITY;

	// Update ground state
	state.onGround = result.onGround;
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
