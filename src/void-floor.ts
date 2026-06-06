/**
 * The void floor — a rising hazard plane that climbs the world from below and
 * defines the lose condition. See `notes/GAME-DESIGN.md` ("The Fire Floor").
 *
 * It is a single world-Y scalar (`surfaceY`), not voxel data. Everything else
 * is a band measured downward from that surface:
 *
 *   Safe   : feet at or above surfaceY            — nothing happens
 *   Grace  : [surfaceY - 1 chunk, surfaceY)       — damage ticks; escape recovers
 *   Lethal : below surfaceY - 1 chunk             — rapid death AND blocks deleted
 *
 * The Lethal line doubles as the chunk-delete floor: there are no blocks below
 * it (the void "consumed" them). Because `world.setBlock` already fails on
 * absent chunks, deleting those chunks also makes placement there impossible —
 * no separate placement guard is needed; the deletion *is* the rule.
 *
 * This module is pure logic (no GPU). Effects (orb crack/shake, death overlay)
 * are routed through the callbacks so this file stays presentation-agnostic.
 */

import { CHUNK_SIZE } from './chunk';

// Rise is constant — the void climbs even when the player stands still, so
// there is no truly safe height. Expressed in blocks/sec; scaled by blockSize.
export const VOID_RISE_RATE_BLOCKS = 0.75;
// Clamp floor: the void never lags more than this far below the player's feet.
// If the player out-climbs the constant rise, the void is yanked up to here so
// it can never be left behind.
export const VOID_MAX_GAP_BLOCKS = 200;
// Thickness of the survivable damage band, in chunks below the surface.
export const VOID_GRACE_DEPTH_CHUNKS = 1;
// Seconds between damage ticks while in the Grace band.
export const VOID_HIT_INTERVAL = 5;
// Cracks before the player shatters. Reaching this in Grace = death.
export const VOID_MAX_HITS = 4;

export type VoidBand = 'safe' | 'grace' | 'lethal';
export type VoidDeathCause = 'shatter' | 'lethal';

export interface VoidFloorCallbacks {
	/** A damage tick landed while in the Grace band. `hits` is the new total. */
	onCrack?: (hits: number) => void;
	/** A crack healed back while Safe. `hits` is the new (lower) total. */
	onHeal?: (hits: number) => void;
	/** The player died — `shatter` (cracks maxed) or `lethal` (fell past Grace). */
	onDeath?: (cause: VoidDeathCause) => void;
}

export interface VoidFloorState {
	/** World-Y of the void surface (the rising line). */
	surfaceY: number;
	/** Accumulated cracks. Earned in Grace, healed one per interval in Safe. */
	hits: number;
	/** Seconds until the next Grace damage tick. */
	hitTimer: number;
	band: VoidBand;
	dead: boolean;
}

export function createVoidFloorState(startSurfaceY: number): VoidFloorState {
	return {
		surfaceY: startSurfaceY,
		hits: 0,
		// Full interval of grace before the first crack on entering the band.
		hitTimer: VOID_HIT_INTERVAL,
		band: 'safe',
		dead: false,
	};
}

/** World-Y of the Grace/Lethal boundary — also the chunk-delete floor. */
export function voidLethalY(state: VoidFloorState, blockSize: number): number {
	return state.surfaceY - VOID_GRACE_DEPTH_CHUNKS * CHUNK_SIZE * blockSize;
}

/**
 * Chunk-Y below which chunks are deleted ("consumed"). Uses floor of the
 * Lethal line so the chunk straddling that line stays loaded — the player can
 * still be standing on its top within the Grace band.
 */
export function voidDeleteFloorCY(
	state: VoidFloorState,
	blockSize: number,
): number {
	return Math.floor(voidLethalY(state, blockSize) / (CHUNK_SIZE * blockSize));
}

/**
 * Advance the void: rise + clamp, classify the player's band, and run the
 * Grace damage state machine. Once `dead`, this is a no-op — the caller owns
 * restart (clearing `dead` / resetting state).
 */
export function updateVoidFloor(
	state: VoidFloorState,
	dt: number,
	playerFeetY: number,
	blockSize: number,
	cb: VoidFloorCallbacks,
): void {
	if (state.dead) return;

	const rise = VOID_RISE_RATE_BLOCKS * blockSize * dt;
	const maxGap = VOID_MAX_GAP_BLOCKS * blockSize;
	state.surfaceY = Math.max(state.surfaceY + rise, playerFeetY - maxGap);

	const lethalY = voidLethalY(state, blockSize);

	if (playerFeetY >= state.surfaceY) {
		state.band = 'safe';
		// Heal one crack per interval — same cadence as taking them. The shared
		// hitTimer carries over from Grace, so a near-due damage tick becomes a
		// near-due heal rather than restarting the clock.
		if (state.hits > 0) {
			state.hitTimer -= dt;
			if (state.hitTimer <= 0) {
				state.hits--;
				state.hitTimer = VOID_HIT_INTERVAL;
				cb.onHeal?.(state.hits);
			}
		} else {
			state.hitTimer = VOID_HIT_INTERVAL;
		}
		return;
	}

	if (playerFeetY >= lethalY) {
		state.band = 'grace';
		state.hitTimer -= dt;
		if (state.hitTimer <= 0) {
			state.hits++;
			state.hitTimer = VOID_HIT_INTERVAL;
			cb.onCrack?.(state.hits);
			if (state.hits >= VOID_MAX_HITS) {
				state.dead = true;
				cb.onDeath?.('shatter');
			}
		}
		return;
	}

	state.band = 'lethal';
	state.dead = true;
	cb.onDeath?.('lethal');
}
