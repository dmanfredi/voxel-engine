/**
 * Procedural variable-thickness pillars on three axes — sphere-climbing
 * playground. Each cell on each of three "seed planes" gets a deterministic
 * hash-based dice roll. If the roll lands below SEED_PROB the cell becomes
 * a seed with a hashed thickness N ∈ [N_MIN, N_MAX]; the pillar covers an
 * N×N footprint on its seed plane and extends infinitely along the
 * perpendicular axis.
 *
 *   Vertical pillars       — seed plane XZ, run along Y
 *   Horizontal-X pillars   — seed plane YZ, run along X
 *   Horizontal-Z pillars   — seed plane XY, run along Z
 *
 * A block is solid iff it lies inside any pillar of any axis. Pillars from
 * different axes can overlap freely (just stays solid).
 *
 * Per-chunk acceleration: build three 32×32 coverage caches (one per seed
 * plane) before the main triple loop. Each cache cell scans an N_MAX² window
 * of candidate seeds; the main loop is just three Uint8Array reads per
 * block. Per-chunk cost ≈ 3 × 1024 × N_MAX² hash lookups + 32³ cell tests,
 * sub-millisecond in JS.
 *
 * Wrap-aware: hash inputs for seeds on the X and Z axes are wrapped to
 * `WORLD_WIDTH_BLOCKS` so the pattern stitches at the world wrap boundary.
 * Y is unbounded — pillars run forever vertically.
 *
 * Determinism: pure hash-of-position, no PRNG state. Same world block →
 * same answer every time, so chunks regenerated after unloading match.
 */

import { CHUNK_SIZE } from '../chunk';
import { DARK_MARBLE, MARBLE } from '../block';

// Must match `WORLD_WIDTH * CHUNK_SIZE` from main.ts. Hardcoded because
// generators don't get a World reference; if world width changes there,
// update this too or pillars won't seam at the wrap boundary.
const WORLD_WIDTH_BLOCKS = 320;

// Pillar footprint thickness range (NxN on the seed plane).
const N_MIN = 4;
const N_MAX = 8;

// Per-cell probability of being a seed. With N_MAX=8 the candidate window
// per query is 64 cells, so per-axis solid coverage ≈ SEED_PROB × N² × ~30.
// 0.005 lands around 15-20% per axis → ~45% combined density (1 - 0.83³).
// Bump for denser swarming terrain, drop for airier.
const SEED_PROB = 0.00133;

// Axis tags — distinguish identical (a, b) coords across the three seed
// planes so e.g. position (5, 7) on XZ generates a different roll than
// (5, 7) on YZ. Values are arbitrary; just need to be distinct.
const AXIS_VERTICAL = 0;
const AXIS_HORIZ_X = 1;
const AXIS_HORIZ_Z = 2;

/**
 * 32-bit FNV-1a + MurmurHash3-style finalizer. Combines three integers,
 * outputs a uniformly distributed unsigned 32-bit value. `Math.imul` is
 * required — plain `*` overflows past 2³² and loses bits.
 */
function hash3(a: number, b: number, c: number): number {
	let h = 2166136261; // FNV offset basis
	h = Math.imul(h ^ a, 16777619); // FNV prime
	h = Math.imul(h ^ b, 16777619);
	h = Math.imul(h ^ c, 16777619);
	h ^= h >>> 16;
	h = Math.imul(h, 2246822507);
	h ^= h >>> 13;
	return h >>> 0;
}

/** Wrap a coord to `[0, WORLD_WIDTH_BLOCKS)`. Negative-safe. */
function wrapH(coord: number): number {
	return (
		((coord % WORLD_WIDTH_BLOCKS) + WORLD_WIDTH_BLOCKS) % WORLD_WIDTH_BLOCKS
	);
}

/**
 * For seed plane coord `(a, b)` and axis tag, return 0 if not a seed,
 * else the seed's thickness N ∈ [N_MIN, N_MAX]. Top hash bits drive the
 * seed roll; bottom bits drive thickness — both come from one hash so
 * we don't pay for two.
 */
function seedThickness(a: number, b: number, axisTag: number): number {
	const h = hash3(a, b, axisTag);
	const roll = (h >>> 8) / 0x1000000; // top 24 bits → [0, 1)
	if (roll >= SEED_PROB) return 0;
	return N_MIN + ((h & 0xff) % (N_MAX - N_MIN + 1));
}

/**
 * Is seed-plane point `(a, b)` covered by any pillar? Scans the candidate
 * window of seeds whose footprints could reach this point.
 *
 * `wrapA` / `wrapB` control whether each axis wraps before hashing — true
 * for X and Z, false for Y. The geometric coverage check (`sa + N > a`)
 * uses the unwrapped seed coord so a pillar straddling the wrap boundary
 * still produces the right footprint at the seed's "virtual" extension.
 */
function isCovered(
	a: number,
	b: number,
	axisTag: number,
	wrapA: boolean,
	wrapB: boolean,
): boolean {
	for (let sa = a - N_MAX + 1; sa <= a; sa++) {
		for (let sb = b - N_MAX + 1; sb <= b; sb++) {
			const hashA = wrapA ? wrapH(sa) : sa;
			const hashB = wrapB ? wrapH(sb) : sb;
			const N = seedThickness(hashA, hashB, axisTag);
			if (N === 0) continue;
			if (sa + N > a && sb + N > b) return true;
		}
	}
	return false;
}

export default function pillars(
	cx: number,
	cy: number,
	cz: number,
	blocks: Uint8Array<ArrayBuffer>,
): void {
	const baseX = cx * CHUNK_SIZE;
	const baseY = cy * CHUNK_SIZE;
	const baseZ = cz * CHUNK_SIZE;

	// 2D coverage caches per seed plane. Indices match each plane's natural
	// stride: xz[lx + lz*S], yz[ly + lz*S], xy[lx + ly*S].
	const xzCov = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
	const yzCov = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
	const xyCov = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);

	// Vertical pillars — seed plane XZ; both axes wrap.
	for (let lz = 0; lz < CHUNK_SIZE; lz++) {
		const wz = baseZ + lz;
		for (let lx = 0; lx < CHUNK_SIZE; lx++) {
			const wx = baseX + lx;
			xzCov[lx + lz * CHUNK_SIZE] = isCovered(
				wx,
				wz,
				AXIS_VERTICAL,
				true,
				true,
			)
				? 1
				: 0;
		}
	}

	// Horizontal-X pillars — seed plane YZ; only Z wraps.
	for (let lz = 0; lz < CHUNK_SIZE; lz++) {
		const wz = baseZ + lz;
		for (let ly = 0; ly < CHUNK_SIZE; ly++) {
			const wy = baseY + ly;
			yzCov[ly + lz * CHUNK_SIZE] = isCovered(
				wy,
				wz,
				AXIS_HORIZ_X,
				false,
				true,
			)
				? 1
				: 0;
		}
	}

	// Horizontal-Z pillars — seed plane XY; only X wraps.
	for (let ly = 0; ly < CHUNK_SIZE; ly++) {
		const wy = baseY + ly;
		for (let lx = 0; lx < CHUNK_SIZE; lx++) {
			const wx = baseX + lx;
			xyCov[lx + ly * CHUNK_SIZE] = isCovered(
				wx,
				wy,
				AXIS_HORIZ_Z,
				true,
				false,
			)
				? 1
				: 0;
		}
	}

	// Compose: solid if any axis covers this cell. Hoist the YZ check out of
	// the X loop since it's constant for fixed (ly, lz) — when set, the
	// whole row is solid via the horizontal-X pillar passing through.
	for (let ly = 0; ly < CHUNK_SIZE; ly++) {
		for (let lz = 0; lz < CHUNK_SIZE; lz++) {
			const yz = yzCov[ly + lz * CHUNK_SIZE];
			const rowBase = ly * CHUNK_SIZE * CHUNK_SIZE + lz * CHUNK_SIZE;
			if (yz) {
				for (let lx = 0; lx < CHUNK_SIZE; lx++) {
					blocks[rowBase + lx] = DARK_MARBLE;
				}
				continue;
			}
			for (let lx = 0; lx < CHUNK_SIZE; lx++) {
				if (
					xzCov[lx + lz * CHUNK_SIZE] ||
					xyCov[lx + ly * CHUNK_SIZE]
				) {
					blocks[rowBase + lx] = MARBLE;
				}
			}
		}
	}
}
