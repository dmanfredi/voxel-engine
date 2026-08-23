/**
 * Gameplay-level block placement. Composes rules that a gameplay action
 * (player right-click, auto-scaffold, future enemy AI, etc.) should respect
 * when putting a block in the world.
 *
 * `world.setBlock` remains the low-level mutation primitive — engine-level
 * code (terrain gen, chunk streaming) calls that directly. This wrapper is
 * for anything representing a creature *placing* a block as a game action.
 */

import type { World } from './world';
import type { EntityManager } from './entity';
import { AIR, type BlockId } from './block';

/**
 * Attempts to place a block. Returns true if the block was placed, false if
 * a rule blocked it (currently: entity overlap). The caller decides what to
 * do on failure (skip BP cost, play a sound, etc.).
 */
export function tryPlaceBlock(
	world: World,
	entityManager: EntityManager,
	bx: number,
	by: number,
	bz: number,
	blockId: BlockId,
): boolean {
	if (entityManager.blockIntersectsEntity(bx, by, bz)) return false;
	const ok = world.setBlock(bx, by, bz, blockId);
	if (ok) entityManager.invalidateFlowField();
	return ok;
}

/**
 * Non-mutating placement test: true when a block would genuinely land here.
 *
 * Stricter than `tryPlaceBlock`, which overwrites whatever already occupies
 * the cell. A batched placer needs to know a cell is actually free *before*
 * charging for it, and needs the rules to stay in this file rather than
 * being re-derived at the call site.
 */
export function canPlaceBlock(
	world: World,
	entityManager: EntityManager,
	bx: number,
	by: number,
	bz: number,
): boolean {
	if (world.getBlock(bx, by, bz) !== AIR) return false;
	if (entityManager.blockIntersectsEntity(bx, by, bz)) return false;
	return true;
}
