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
import type { BlockId } from './block';

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
	return world.setBlock(bx, by, bz, blockId);
}
