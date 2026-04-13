import type { Vec3 } from 'wgpu-matrix';
import { AIR, BRICK } from './block';
import type { GameState } from './game-state';
import type { World } from './world';
import type { EntityManager } from './entity';
import { tryPlaceBlock } from './placement';

/**
 * Places a BRICK block directly beneath the player's feet if that space is air
 * and the player has BP. This is always active — jumping creates the gap that
 * lets it fire. Returns the block coords placed, or null if nothing happened.
 */
export function autoClimb(
	cameraPos: Vec3,
	playerHeight: number,
	blockSize: number,
	world: World,
	entityManager: EntityManager,
	gameState: GameState,
): { x: number; y: number; z: number } | null {
	if (gameState.bp <= 0) return null;

	const feetY = (cameraPos[1] ?? 0) - playerHeight;
	const bx = Math.floor((cameraPos[0] ?? 0) / blockSize);
	const by = Math.floor(feetY / blockSize) - 1;
	const bz = Math.floor((cameraPos[2] ?? 0) / blockSize);

	if (world.getBlock(bx, by, bz) !== AIR) return null;

	if (!tryPlaceBlock(world, entityManager, bx, by, bz, BRICK)) return null;

	gameState.bp--;
	return { x: bx, y: by, z: bz };
}
