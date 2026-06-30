/**
 * Cube AI — per-frame tip-attempt cadence and greedy move selection.
 *
 * Each idle frame ticks a cooldown; on expiry (and grounded) the cube picks
 * the single tip that best closes on its target via a scored argmax over the
 * full candidate set (4 horizontal walks + 4 climbs). Reactive, not planned:
 * no stored path, re-decided every tip — which is exactly why it shrugs off
 * the moving player and ever-changing terrain. A cube builds its own floor
 * (scaffold) and climbs any wall, so walls/pits stop being obstacles and the
 * navigable space stays near-convex, the regime where greedy is near-optimal.
 * See notes/cube-enemy.md.
 *
 * Locomotion is role-agnostic — only `cubeTarget` varies per role (Phase 5).
 * Deferred by design (future pass): depth-N lookahead (this scorer is its
 * depth-1 case) and a proactive stuck-breaker. For now a cube with no
 * improving move simply takes no tip; the despawn no-path timer recycles a
 * persistent stall.
 */

import type { Entity } from './entity';
import { Role } from './entity';

/**
 * Gameplay-level tip primitive, injected by EntityManager — needs world
 * mutation and entity overlap queries that AI shouldn't reach into directly.
 * Validates feasibility and mutates (scaffold + tip) only on success, so a
 * rejected direction is side-effect-free and the scorer can fall through to
 * the next candidate.
 */
export type TryTipFn = (
	entity: Entity,
	direction: [number, number, number],
) => boolean;

/**
 * Commit the cube to its crush payload, injected by EntityManager — it owns
 * the world-mutating telegraph → carve → plummet sequence the AI shouldn't
 * reach into. Called once on arrival; the cube stops pathing afterward.
 */
export type BeginCrushFn = (entity: Entity) => void;

// Candidate moves in a fixed order (stable tie-break for argmax). Four
// axis-aligned walks (dy=0) and four climbs (dy=1). No descent candidate:
// dropping isn't navigation — a falling cube smashes through to the void and
// despawns — so it never enters move selection. See notes/cube-enemy.md.
const CANDIDATES: readonly (readonly [number, number, number])[] = [
	[1, 0, 0],
	[-1, 0, 0],
	[0, 0, 1],
	[0, 0, -1],
	[1, 1, 0],
	[-1, 1, 0],
	[0, 1, 1],
	[0, 1, -1],
];

// Crush role tuning. The cube climbs to perch this high above the player.
// Arrival carries slack on both axes because the discrete tip stride rarely lands the cube dead-center over the target.
const CRUSH_PERCH_BLOCKS = 32;
const CRUSH_ARRIVE_RADIUS_BLOCKS = 1;

/**
 * Tick cooldown; on expiry, attempt a tip if grounded. Cooldown ticks
 * regardless of grounded so airborne cubes fire on the next grounded
 * frame rather than waiting a full interval. Mid-tip cubes skip entirely.
 *
 * Crush cubes first test whether they've perched above the player; on arrival
 * they commit to the crush payload (via `beginCrush`) and stop pathing.
 */
export function cubeAITick(
	entity: Entity,
	playerPos: Float32Array,
	ww: number,
	blockSize: number,
	dt: number,
	tryTip: TryTipFn,
	beginCrush: BeginCrushFn,
): void {
	if (entity.tip !== null) return;

	// Perched above the player → commit. EntityManager takes over from here
	// (telegraph → carve → plummet). See notes/cube-enemy.md.
	if (
		entity.role === Role.Crush &&
		entity.grounded &&
		crushReachedPerch(entity, playerPos, ww, blockSize)
	) {
		beginCrush(entity);
		return;
	}

	entity.tipCooldown -= dt;
	if (entity.tipCooldown <= 0 && entity.grounded) {
		tipCubeTowardTarget(entity, playerPos, ww, blockSize, tryTip);
		entity.tipCooldown = entity.tipInterval;
	}
}

/**
 * The world-space point this cube wants to reach — the role-dispatch seam.
 * Crush perches a fixed height above the player; other roles beeline the
 * player. Zone will branch here too when it lands.
 */
function cubeTarget(
	entity: Entity,
	playerPos: Float32Array,
	blockSize: number,
): [number, number, number] {
	const px = playerPos[0] ?? 0;
	const py = playerPos[1] ?? 0;
	const pz = playerPos[2] ?? 0;
	if (entity.role === Role.Crush) {
		return [px, py + CRUSH_PERCH_BLOCKS * blockSize, pz];
	}
	return [px, py, pz];
}

/**
 * True when a Crush cube is perched above the player: horizontally within the
 * slack radius of the player's column (wrap-aware) and climbed to within that
 * same slack of the perch height.
 */
function crushReachedPerch(
	entity: Entity,
	playerPos: Float32Array,
	ww: number,
	blockSize: number,
): boolean {
	const hw = ww / 2;
	const py = playerPos[1] ?? 0;
	let dx = (playerPos[0] ?? 0) - entity.x;
	let dz = (playerPos[2] ?? 0) - entity.z;
	if (dx > hw) dx -= ww;
	else if (dx < -hw) dx += ww;
	if (dz > hw) dz -= ww;
	else if (dz < -hw) dz += ww;
	const slack = CRUSH_ARRIVE_RADIUS_BLOCKS * blockSize;
	const horizSq = dx * dx + dz * dz;
	const aboveBy = entity.y - py;
	return (
		horizSq <= slack * slack &&
		aboveBy >= CRUSH_PERCH_BLOCKS * blockSize - slack
	);
}

/**
 * Scored argmax over the candidate tips: pick the feasible one whose
 * destination cell lands closest to the target, committing only if it
 * strictly improves over standing pat. Candidates are tried best-first;
 * `tryTip` mutates only on success, so a blocked candidate is a no-op and we
 * fall through. No improving feasible move → no tip (the cube waits; a
 * persistent stall recycles via the despawn no-path timer).
 *
 * The vertical zigzag toward a target straight overhead is emergent, not
 * coded: from directly below, a climb that lands offset-and-up beats standing
 * pat, and the next climb back over the top improves further — greedy
 * alternates sides on its own, netting vertical progress with no stored state.
 */
function tipCubeTowardTarget(
	entity: Entity,
	playerPos: Float32Array,
	ww: number,
	blockSize: number,
	tryTip: TryTipFn,
): void {
	const [tx, ty, tz] = cubeTarget(entity, playerPos, blockSize);
	const hw = ww / 2;
	const edge = 2 * entity.scale;

	const currentDistSq = wrapDistSq(
		entity.x,
		entity.y,
		entity.z,
		tx,
		ty,
		tz,
		ww,
		hw,
	);

	// Score each candidate by its destination's distance to target, then sort
	// ascending so the most-improving move is attempted first.
	const scored = CANDIDATES.map((dir) => ({
		dir,
		distSq: wrapDistSq(
			entity.x + dir[0] * edge,
			entity.y + dir[1] * edge,
			entity.z + dir[2] * edge,
			tx,
			ty,
			tz,
			ww,
			hw,
		),
	})).sort((a, b) => a.distSq - b.distSq);

	for (const { dir, distSq } of scored) {
		if (distSq >= currentDistSq) break; // best remaining can't improve → stuck
		if (tryTip(entity, [dir[0], dir[1], dir[2]])) return;
	}
}

/**
 * Squared distance from (x,y,z) to (tx,ty,tz), wrap-aware on the horizontal
 * axes (Y doesn't wrap). Squared is sufficient — the scorer only compares.
 */
function wrapDistSq(
	x: number,
	y: number,
	z: number,
	tx: number,
	ty: number,
	tz: number,
	ww: number,
	hw: number,
): number {
	let dx = tx - x;
	const dy = ty - y;
	let dz = tz - z;
	if (dx > hw) dx -= ww;
	else if (dx < -hw) dx += ww;
	if (dz > hw) dz -= ww;
	else if (dz < -hw) dz += ww;
	return dx * dx + dy * dy + dz * dz;
}
