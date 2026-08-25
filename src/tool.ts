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
	compoundHitbox,
	obbHitbox,
	ProjectileEffect,
	type ProjectileProfile,
	type VoxelCoord,
} from './projectile';
import { bridgePlanner, cubePlanner, type GrowthProfile } from './growth';
import type { RaycastHit } from './raycast';
import { assertMonotonicTiming, timingFunctions } from './timing';

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
 * The player's interface to the world. LMB mines, RMB builds. The two sides
 * share nothing: each carries its own ProjectileProfile, and a profile now
 * describes its own launch (muzzle offset, aim rule), so a tool's build shot
 * is never shaped by how its mining shot flies. Cooldowns are independent too
 * — fire and build on their own clocks so you can interleave them.
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

	// --- LMB (mine) ---
	mineProjectile: ProjectileProfile;
	/** Seconds between LMB shots. Must be > 0. */
	lmbCooldown: number;
	/** BP debited per LMB press. 0 = firing is free. */
	lmbCost: number;
	/** BP awarded each time this tool's projectile breaks a block. */
	bpPerBreak: number;

	// --- RMB (build) ---
	/**
	 * Instant placement — the utility for plugging one specific cell. Consulted
	 * only when the tool has no build projectile.
	 */
	buildProfile: BuildProfile;
	/**
	 * Build projectile fired by RMB, or null to fall back to `buildProfile`'s
	 * instant placement. Always paired with `growth`: the projectile flies and
	 * dies on contact, the growth lays the structure that impact implies.
	 */
	buildProjectile: ProjectileProfile | null;
	/** Structure a build impact grows. Non-null exactly when buildProjectile is. */
	growth: GrowthProfile | null;
	/** Seconds between RMB activations. Must be > 0. */
	rmbCooldown: number;

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

/** Shared invariants for any ProjectileProfile a Tool carries. */
function assertProjectileProfile(
	label: string,
	profile: ProjectileProfile,
): void {
	if (!Number.isFinite(profile.maxLifetime) || profile.maxLifetime <= 0) {
		throw new Error(
			`${label}.maxLifetime must be finite and > 0 (got ${String(profile.maxLifetime)})`,
		);
	}
	if (!Number.isFinite(profile.speed) || profile.speed < 0) {
		throw new Error(
			`${label}.speed must be finite and >= 0 (got ${String(profile.speed)})`,
		);
	}
	if (profile.spawnOffset.length !== 3) {
		throw new Error(
			`${label}.spawnOffset must have 3 components (got ${String(profile.spawnOffset.length)})`,
		);
	}
	assertMonotonicTiming(`${label}.timing`, profile.timing);
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
	assertProjectileProfile(
		`Tool "${spec.name}": mineProjectile`,
		spec.mineProjectile,
	);
	// buildProjectile and growth are two halves of one mechanism — a
	// projectile with nothing to grow lands and does nothing, and a growth
	// with nothing to launch it can never start.
	if ((spec.buildProjectile === null) !== (spec.growth === null)) {
		throw new Error(
			`Tool "${spec.name}": buildProjectile and growth must both be set or both be null`,
		);
	}
	if (spec.buildProjectile && spec.growth) {
		assertProjectileProfile(
			`Tool "${spec.name}": buildProjectile`,
			spec.buildProjectile,
		);
		if (spec.buildProjectile.effect !== ProjectileEffect.Build) {
			throw new Error(
				`Tool "${spec.name}": buildProjectile.effect must be ProjectileEffect.Build`,
			);
		}
		if (spec.growth.cellsPerSecond <= 0) {
			throw new Error(
				`Tool "${spec.name}": growth.cellsPerSecond must be > 0 (got ${String(spec.growth.cellsPerSecond)})`,
			);
		}
		if (spec.growth.costPerCell < 0) {
			throw new Error(
				`Tool "${spec.name}": growth.costPerCell must be >= 0 (got ${String(spec.growth.costPerCell)})`,
			);
		}
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
		// Lockout freezes BP, so a costing fire is blocked; a free fire (the
		// pickaxe) still goes — it carves, the break just earns nothing.
		if (gameState.lockoutRemaining > 0 && tool.lmbCost > 0) return false;
		if (gameState.bp < tool.lmbCost) return false;
		return true;
	}
	if (tool.rmbCooldownRemaining > 0) return false;
	// Placement is a build action — disallowed entirely during lockout.
	if (gameState.lockoutRemaining > 0) return false;
	// RMB needs enough BP for at least one cell; the rest is rechecked as the
	// committer (or the growth) walks its cells, so a build that outruns the
	// player's BP simply stops where it stands.
	const perCell = tool.growth
		? tool.growth.costPerCell
		: tool.buildProfile.costPerBlock;
	if (gameState.bp < perCell) return false;
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

/** Hip-fire muzzle every current profile uses. Per-profile, not per-tool. */
const HIP_FIRE_OFFSET: readonly [number, number, number] = [0, -5, 5];
const hipFire = (): Float32Array => new Float32Array(HIP_FIRE_OFFSET);

/**
 * Starter pickaxe.
 */
const PICKAXE_VISUAL = 6;
const pickaxeProjectile: ProjectileProfile = {
	effect: ProjectileEffect.Mine,
	strength: 10,
	speed: 450,
	timing: timingFunctions.linear,
	hitbox: obbHitbox(PICKAXE_VISUAL * 0.5),
	maxLifetime: 5,
	visualSize: [PICKAXE_VISUAL, PICKAXE_VISUAL, PICKAXE_VISUAL],
	spawnOffset: hipFire(),
	aimConstraint: null,
};

export const pickaxeTool: Tool = defineTool({
	name: 'Pickaxe',
	icon: null,
	model: null,
	mineProjectile: pickaxeProjectile,
	lmbCooldown: 0.4,
	lmbCost: 0,
	bpPerBreak: 1,
	buildProfile: singleBlockBuild(MARBLE, 1),
	buildProjectile: null,
	growth: null,
	rmbCooldown: 0.1,
	chargeTime: null,
});

/**
 * Free-aim tunneller: fires a slab along the resolved crosshair direction —
 * wide across the lane and thin along travel, so each sweep-break clears a
 * broad cross-section.
 *
 * RMB throws a build bolt that grows a cube — seated against whatever it hits,
 * or planted in open air at the end of its flight if it hits nothing. Not
 * needing a surface is what makes it a placement tool rather than a patching
 * one: the pairing is dig a hole, then fill a space that was never there.
 */
// Slab edges in world units: BORE_WIDTH across the lane (right/up),
// BORE_THICKNESS along travel (forward). Thin along travel so each tick
// sweeps a single grid slice.
const BORE_WIDTH = 20;
const BORE_THICKNESS = 10;
const boreProjectile: ProjectileProfile = {
	effect: ProjectileEffect.Mine,
	strength: 90,
	speed: 140,
	timing: timingFunctions.quadOut,
	hitbox: compoundHitbox([
		{
			offset: [0, 0, 0],
			half: [BORE_WIDTH / 2, BORE_WIDTH / 2, BORE_THICKNESS / 2],
		},
	]),
	maxLifetime: 1,
	visualSize: [BORE_WIDTH, BORE_WIDTH, BORE_THICKNESS],
	spawnOffset: hipFire(),
	aimConstraint: null,
};

/**
 * The bore's build bolt. Defined independently of the mining slab rather than
 * derived from it — the two buttons only happen to agree on flight right now,
 * and speed/lifetime here is the cube's throw range, which is its own dial.
 */
const BORE_CUBE_CELLS = 3;
const BORE_BOLT = 8;
const boreBuildProjectile: ProjectileProfile = {
	effect: ProjectileEffect.Build,
	// Unread on a Build projectile — it carries no mining budget.
	strength: 1,
	speed: 400,
	timing: timingFunctions.quadOut,
	hitbox: obbHitbox(BORE_BOLT * 0.5),
	maxLifetime: 0.5,
	visualSize: [BORE_BOLT, BORE_BOLT, BORE_BOLT],
	spawnOffset: hipFire(),
	aimConstraint: null,
};

export const boreTool: Tool = defineTool({
	name: 'Bore',
	icon: null,
	model: null,
	mineProjectile: boreProjectile,
	lmbCooldown: 1.25,
	lmbCost: 0,
	bpPerBreak: 1,
	buildProfile: singleBlockBuild(MARBLE, 1),
	buildProjectile: boreBuildProjectile,
	growth: {
		planner: cubePlanner(BORE_CUBE_CELLS),
		blockId: MARBLE,
		costPerCell: 1,
		cellsPerSecond: 40,
		requiresContact: false,
	},
	rmbCooldown: 0.6,
	chargeTime: null,
});

/**
 * Long-range span builder. LMB is an ordinary mining bolt; RMB launches a
 * build projectile whose impact grows a one-cell walkway back to wherever the
 * shot was fired from.
 *
 * Range is the whole point, and the growth rate is what keeps it honest: a
 * span takes time proportional to its length, so a distant anchor is a
 * commitment rather than a free upgrade over a near one.
 */
const BRIDGE_BOLT = 6;
const bridgeBoltProjectile: ProjectileProfile = {
	effect: ProjectileEffect.Build,
	// Unread on a Build projectile — it carries no mining budget.
	strength: 1,
	speed: 800,
	timing: timingFunctions.linear,
	hitbox: obbHitbox(BRIDGE_BOLT * 0.5),
	maxLifetime: 1.2,
	visualSize: [BRIDGE_BOLT, BRIDGE_BOLT, BRIDGE_BOLT],
	spawnOffset: hipFire(),
	aimConstraint: null,
};

export const bridgeTool: Tool = defineTool({
	name: 'Bridge',
	icon: null,
	model: null,
	mineProjectile: pickaxeProjectile,
	lmbCooldown: 0.4,
	lmbCost: 0,
	bpPerBreak: 1,
	buildProfile: singleBlockBuild(MARBLE, 1),
	buildProjectile: bridgeBoltProjectile,
	growth: {
		planner: bridgePlanner,
		blockId: MARBLE,
		costPerCell: 1,
		cellsPerSecond: 40,
		// A span needs a far endpoint; fired into open air it has nothing to
		// reach back from, so a whiff produces nothing.
		requiresContact: true,
	},
	rmbCooldown: 2,
	chargeTime: null,
});
