/**
 * Tool definitions — the player's interface to the world.
 *
 * A Tool bundles a left-mouse (fire-projectile) action and a right-mouse
 * (place-via-BuildProfile) action, plus the gates that govern them
 * (cooldowns, costs). Tools are singletons: the hotbar holds references,
 * cooldown state lives mutably on the tool itself so it survives slot
 * switches (you can't skip a cooldown by tabbing away and back).
 *
 * Stubbed for now: icon/model fields, non-null chargeTime, in-flight
 * projectile cap, tool-vs-entity collision (projectiles currently
 * phase through enemies — deferred design call).
 */

import { type BlockId, MARBLE } from './block';
import type { GameState } from './game-state';
import {
	obbHitbox,
	type ProjectileProfile,
	type VoxelCoord,
} from './projectile';
import type { RaycastHit } from './raycast';

/**
 * Side-effect-free description of "if RMB fires while looking at this
 * face, which cells would I fill?". The (future) ghost previewer and
 * the committer both call this — single source of truth for placement
 * targets. Returned cells are in commit order; the committer may stop
 * early if BP runs out.
 */
export interface BuildProfile {
	blockId: BlockId;
	costPerBlock: number;
	targetSelector: (hit: RaycastHit, cameraDir: Float32Array) => VoxelCoord[];
}

/** Place one block on the face the raycast hit. */
export function singleBlockBuild(
	blockId: BlockId,
	costPerBlock: number,
): BuildProfile {
	return {
		blockId,
		costPerBlock,
		targetSelector: (hit) => [
			[
				hit.blockPos[0] + hit.faceNormal[0],
				hit.blockPos[1] + hit.faceNormal[1],
				hit.blockPos[2] + hit.faceNormal[2],
			],
		],
	};
}

export type FireSide = 'lmb' | 'rmb';

/**
 * The player's interface to the world. LMB fires a projectile; RMB
 * places a BuildProfile. Cooldowns are independent — fire and build on
 * their own clocks so you can interleave them.
 *
 * Construct via `defineTool()` — it initializes runtime state and runs
 * invariant checks the type system can't express.
 */
export interface Tool {
	// --- Identity ---
	name: string;
	/** Hotbar sprite path. Null = stub (TODO once art lands). */
	icon: string | null;
	/** First-person model path. Null = stub (TODO once models land). */
	model: string | null;

	// --- LMB (fire projectile) ---
	projectile: ProjectileProfile;
	/** Seconds between LMB shots. Must be > 0. */
	lmbCooldown: number;
	/** BP debited per LMB press. 0 = firing is free. */
	lmbCost: number;
	/** BP awarded each time this tool's projectile breaks a block. */
	bpPerBreak: number;

	// --- RMB (build) ---
	buildProfile: BuildProfile;
	/** Seconds between RMB activations. Must be > 0. */
	rmbCooldown: number;

	// --- Geometry ---
	/**
	 * Spawn point relative to camera, in camera-local axes
	 * [right, up, forward], world units. Hip-fire offset keeps the
	 * projectile out of the camera frustum on emit so it doesn't
	 * briefly occlude the view.
	 */
	spawnOffset: Float32Array;

	// --- Fire mode ---
	/**
	 * null = autofire while LMB held (gated by cooldown). number = hold
	 * for this many seconds to charge, release to fire. Only the null
	 * branch is wired into the tick; non-null is a field-shaped hole.
	 */
	chargeTime: number | null;

	// --- Runtime state ---
	/** Seconds until LMB can fire again. Ticked toward 0 each frame. */
	lmbCooldownRemaining: number;
	/** Seconds until RMB can fire again. Ticked toward 0 each frame. */
	rmbCooldownRemaining: number;
}

/**
 * Factory for Tool. Initializes runtime state to 0 and asserts the
 * invariants the type system can't express (positive cooldowns,
 * non-negative costs). One central place to add new guards.
 */
export function defineTool(
	spec: Omit<Tool, 'lmbCooldownRemaining' | 'rmbCooldownRemaining'>,
): Tool {
	if (spec.lmbCooldown <= 0) {
		throw new Error(
			`Tool "${spec.name}": lmbCooldown must be > 0 (got ${String(spec.lmbCooldown)})`,
		);
	}
	if (spec.rmbCooldown <= 0) {
		throw new Error(
			`Tool "${spec.name}": rmbCooldown must be > 0 (got ${String(spec.rmbCooldown)})`,
		);
	}
	if (spec.lmbCost < 0) {
		throw new Error(
			`Tool "${spec.name}": lmbCost must be >= 0 (got ${String(spec.lmbCost)})`,
		);
	}
	if (spec.bpPerBreak < 0) {
		throw new Error(
			`Tool "${spec.name}": bpPerBreak must be >= 0 (got ${String(spec.bpPerBreak)})`,
		);
	}
	if (spec.buildProfile.costPerBlock < 0) {
		throw new Error(
			`Tool "${spec.name}": buildProfile.costPerBlock must be >= 0 (got ${String(spec.buildProfile.costPerBlock)})`,
		);
	}
	return {
		...spec,
		lmbCooldownRemaining: 0,
		rmbCooldownRemaining: 0,
	};
}

/**
 * Gating predicate consulted before firing. Future gates (target
 * validity, projectile budget, charge state) bolt on here so the call
 * sites stay a single boolean check.
 */
export function canFire(
	tool: Tool,
	side: FireSide,
	gameState: GameState,
): boolean {
	if (side === 'lmb') {
		if (tool.lmbCooldownRemaining > 0) return false;
		if (gameState.bp < tool.lmbCost) return false;
		return true;
	}
	if (tool.rmbCooldownRemaining > 0) return false;
	// RMB needs enough BP for at least one block; per-cell BP is rechecked
	// by the committer as it walks the target list.
	if (gameState.bp < tool.buildProfile.costPerBlock) return false;
	return true;
}

/**
 * Tick cooldowns toward zero. Called once per frame with the frame's
 * dt. Accepts the slot array directly — null slots are skipped.
 */
export function tickToolCooldowns(
	tools: Iterable<Tool | null>,
	dt: number,
): void {
	for (const tool of tools) {
		if (!tool) continue;
		if (tool.lmbCooldownRemaining > 0) {
			tool.lmbCooldownRemaining = Math.max(
				0,
				tool.lmbCooldownRemaining - dt,
			);
		}
		if (tool.rmbCooldownRemaining > 0) {
			tool.rmbCooldownRemaining = Math.max(
				0,
				tool.rmbCooldownRemaining - dt,
			);
		}
	}
}

// ============================================
// Concrete tools
// ============================================

/**
 * Starter pickaxe.
 */
const PICKAXE_VISUAL = 5;
const pickaxeProjectile: ProjectileProfile = {
	strength: 10,
	speed: 200,
	hitbox: obbHitbox(PICKAXE_VISUAL * 0.5),
	maxLifetime: 5,
	visualSize: PICKAXE_VISUAL,
};

export const pickaxeTool: Tool = defineTool({
	name: 'Pickaxe',
	icon: null,
	model: null,
	projectile: pickaxeProjectile,
	lmbCooldown: 0.5,
	lmbCost: 0,
	bpPerBreak: 1,
	buildProfile: singleBlockBuild(MARBLE, 1),
	rmbCooldown: 0.1,
	spawnOffset: new Float32Array([0, -5, 5]),
	chargeTime: null,
});
