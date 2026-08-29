import type { World } from './world';

/**
 * Auto-step ceiling, in blocks. Slightly over one block so an exact one-block
 * ledge still clears after the epsilon fudge in the cell math.
 *
 * A deliberate departure from the Minecraft reference (0.6, so slabs step and
 * full blocks need a jump): traversal here is vertical and under time
 * pressure, so a one-block lip should never cost a jump input.
 */
export const STEP_HEIGHT_BLOCKS = 1.05;

/** Below this squared horizontal delta a step attempt is drag noise, not intent. */
const MIN_STEP_DELTA_SQ = 1e-6;

export interface CollisionResult {
	onGround: boolean;
	collidedX: boolean;
	collidedZ: boolean;
	collidedCeiling: boolean;
	/** Vertical gain from auto-step; 0 when no step happened. Drives view smoothing. */
	steppedUp: number;
}

interface CellBounds {
	bxMin: number;
	bxMax: number;
	byMin: number;
	byMax: number;
	bzMin: number;
	bzMax: number;
}

interface SweepResult {
	px: number;
	py: number;
	pz: number;
	onGround: boolean;
	collidedX: boolean;
	collidedZ: boolean;
	collidedCeiling: boolean;
}

/**
 * Moves the player position by delta, resolving collisions against the block
 * grid axis-by-axis (X, then Z, then Y). Mutates pos in place.
 *
 * The player AABB is defined relative to pos (the eye/camera position):
 *   X: [pos.x - halfWidth, pos.x + halfWidth]
 *   Y: [pos.y - height,    pos.y]
 *   Z: [pos.z - halfWidth, pos.z + halfWidth]
 *
 * When the flat move is blocked horizontally, a second attempt runs from a
 * raised start and settles back down (Quake `PM_StepSlideMove` shape). The
 * step is a swept move, not a teleport: `grounded` is the caller's *pre-move*
 * ground state, so a player brushing a wall mid-fall or mid-jump cannot climb
 * it. X and Z are stepped as one attempt — stepping per-axis would let a
 * player rise on X and land inside geometry on Z.
 */
export function moveAndCollide(
	pos: Float32Array,
	delta: [number, number, number],
	world: World,
	halfWidth: number,
	height: number,
	grounded: boolean,
): CollisionResult {
	const blockSize = world.blockSize;
	const startX = pos[0] ?? 0;
	const startY = pos[1] ?? 0;
	const startZ = pos[2] ?? 0;

	const flat = sweep(
		startX,
		startY,
		startZ,
		delta,
		world,
		blockSize,
		halfWidth,
		height,
	);
	const stepped = tryStepUp(
		startX,
		startY,
		startZ,
		delta,
		flat,
		world,
		blockSize,
		halfWidth,
		height,
		grounded,
	);
	const chosen = stepped ?? flat;

	pos[0] = chosen.px;
	pos[1] = chosen.py;
	pos[2] = chosen.pz;

	// Flags come from whichever attempt won, so a successful step reports the
	// wall it cleared as uncollided and the caller keeps its horizontal speed.
	return {
		onGround: chosen.onGround,
		collidedX: chosen.collidedX,
		collidedZ: chosen.collidedZ,
		collidedCeiling: chosen.collidedCeiling,
		steppedUp: stepped ? stepped.py - flat.py : 0,
	};
}

/**
 * Second-chance move over a low obstruction. Returns the accepted stepped
 * result, or null to keep the flat one.
 *
 * Every early return is a precondition that keeps the step honest. The final
 * overlap test is the backstop: axis-separated resolution is not a clearance
 * proof, so the landing AABB is verified outright rather than inferred.
 */
function tryStepUp(
	startX: number,
	startY: number,
	startZ: number,
	delta: [number, number, number],
	flat: SweepResult,
	world: World,
	blockSize: number,
	halfWidth: number,
	height: number,
	grounded: boolean,
): SweepResult | null {
	if (!grounded) return null;
	// Upward motion is the player's own (a jump). Stepping would discard it.
	if (delta[1] > 0) return null;
	// Only step into something actually resisting, or the player rises onto
	// blocks they are merely walking alongside.
	if (!flat.collidedX && !flat.collidedZ) return null;

	const dx = delta[0];
	const dz = delta[2];
	if (dx * dx + dz * dz < MIN_STEP_DELTA_SQ) return null;

	const stepHeight = STEP_HEIGHT_BLOCKS * blockSize;
	const raisedY = startY + stepHeight;

	// The lift itself has to fit, or a low ceiling gets clipped through on the
	// way up.
	if (
		aabbOverlapsSolid(
			startX,
			raisedY,
			startZ,
			world,
			blockSize,
			halfWidth,
			height,
		)
	)
		return null;

	// Replay the *original* delta, not the wall-clamped one — resuming from the
	// wall face travels nowhere. The descent subsumes this frame's vertical
	// delta and cannot tunnel: the AABB is taller than one step.
	const raised = sweep(
		startX,
		raisedY,
		startZ,
		[dx, -stepHeight, dz],
		world,
		blockSize,
		halfWidth,
		height,
	);

	// Nothing to stand on within reach — the ledge was too tall, or absent.
	if (!raised.onGround) return null;

	// Measure the gain rather than assume it. Zero means the obstruction was
	// cleared outright in one frame (a step *over*, not up); past the ceiling
	// means the settle sweep seated higher than the lift ever verified.
	const gain = raised.py - startY;
	if (gain <= blockSize * 1e-4 || gain > stepHeight) return null;

	// Take the step only if it bought horizontal ground the flat move did not.
	const flatDX = flat.px - startX;
	const flatDZ = flat.pz - startZ;
	const stepDX = raised.px - startX;
	const stepDZ = raised.pz - startZ;
	if (stepDX * stepDX + stepDZ * stepDZ <= flatDX * flatDX + flatDZ * flatDZ)
		return null;

	if (
		aabbOverlapsSolid(
			raised.px,
			raised.py,
			raised.pz,
			world,
			blockSize,
			halfWidth,
			height,
		)
	)
		return null;

	return raised;
}

function sweep(
	px: number,
	py: number,
	pz: number,
	delta: [number, number, number],
	world: World,
	blockSize: number,
	halfWidth: number,
	height: number,
): SweepResult {
	px += delta[0];
	const xResult = resolveX(
		px,
		py,
		pz,
		world,
		blockSize,
		halfWidth,
		height,
		delta[0],
	);
	px = xResult.px;

	pz += delta[2];
	const zResult = resolveZ(
		px,
		py,
		pz,
		world,
		blockSize,
		halfWidth,
		height,
		delta[2],
	);
	pz = zResult.pz;

	py += delta[1];
	const yResult = resolveY(
		px,
		py,
		pz,
		world,
		blockSize,
		halfWidth,
		height,
		delta[1],
	);
	py = yResult.py;

	return {
		px,
		py,
		pz,
		onGround: yResult.onGround,
		collidedX: xResult.collided,
		collidedZ: zResult.collided,
		collidedCeiling: yResult.collidedCeiling,
	};
}

/** Block cells the AABB at this position touches. */
function cellBounds(
	px: number,
	py: number,
	pz: number,
	blockSize: number,
	halfWidth: number,
	height: number,
): CellBounds {
	return {
		bxMin: Math.floor((px - halfWidth) / blockSize),
		bxMax: Math.floor((px + halfWidth - 1e-6) / blockSize),
		byMin: Math.floor((py - height) / blockSize),
		byMax: Math.floor((py - 1e-6) / blockSize),
		bzMin: Math.floor((pz - halfWidth) / blockSize),
		bzMax: Math.floor((pz + halfWidth - 1e-6) / blockSize),
	};
}

function aabbOverlapsSolid(
	px: number,
	py: number,
	pz: number,
	world: World,
	blockSize: number,
	halfWidth: number,
	height: number,
): boolean {
	const b = cellBounds(px, py, pz, blockSize, halfWidth, height);

	for (let by = b.byMin; by <= b.byMax; by++) {
		for (let bz = b.bzMin; bz <= b.bzMax; bz++) {
			for (let bx = b.bxMin; bx <= b.bxMax; bx++) {
				if (world.isSolid(bx, by, bz)) return true;
			}
		}
	}

	return false;
}

function resolveX(
	px: number,
	py: number,
	pz: number,
	world: World,
	blockSize: number,
	halfWidth: number,
	height: number,
	direction: number,
): { px: number; collided: boolean } {
	const b = cellBounds(px, py, pz, blockSize, halfWidth, height);

	let collided = false;

	for (let by = b.byMin; by <= b.byMax; by++) {
		for (let bz = b.bzMin; bz <= b.bzMax; bz++) {
			for (let bx = b.bxMin; bx <= b.bxMax; bx++) {
				if (!world.isSolid(bx, by, bz)) continue;

				collided = true;
				if (direction > 0) {
					px = bx * blockSize - halfWidth;
				} else if (direction < 0) {
					px = (bx + 1) * blockSize + halfWidth;
				}
			}
		}
	}

	return { px, collided };
}

function resolveZ(
	px: number,
	py: number,
	pz: number,
	world: World,
	blockSize: number,
	halfWidth: number,
	height: number,
	direction: number,
): { pz: number; collided: boolean } {
	const b = cellBounds(px, py, pz, blockSize, halfWidth, height);

	let collided = false;

	for (let by = b.byMin; by <= b.byMax; by++) {
		for (let bz = b.bzMin; bz <= b.bzMax; bz++) {
			for (let bx = b.bxMin; bx <= b.bxMax; bx++) {
				if (!world.isSolid(bx, by, bz)) continue;

				collided = true;
				if (direction > 0) {
					pz = bz * blockSize - halfWidth;
				} else if (direction < 0) {
					pz = (bz + 1) * blockSize + halfWidth;
				}
			}
		}
	}

	return { pz, collided };
}

function resolveY(
	px: number,
	py: number,
	pz: number,
	world: World,
	blockSize: number,
	halfWidth: number,
	height: number,
	direction: number,
): { py: number; onGround: boolean; collidedCeiling: boolean } {
	const b = cellBounds(px, py, pz, blockSize, halfWidth, height);

	let onGround = false;
	let collidedCeiling = false;

	for (let by = b.byMin; by <= b.byMax; by++) {
		for (let bz = b.bzMin; bz <= b.bzMax; bz++) {
			for (let bx = b.bxMin; bx <= b.bxMax; bx++) {
				if (!world.isSolid(bx, by, bz)) continue;

				if (direction < 0) {
					py = (by + 1) * blockSize + height;
					onGround = true;
				} else if (direction > 0) {
					py = by * blockSize;
					collidedCeiling = true;
				}
			}
		}
	}

	return { py, onGround, collidedCeiling };
}
