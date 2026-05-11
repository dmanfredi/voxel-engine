/**
 * Flow field — 3D BFS distance grid centered on the player, used by sphere
 * AI to pursue around obstacles instead of bonking straight at the target.
 *
 * Granularity: cell-based (one distance value per voxel). For sticky-aware
 * navigation, this is enough — the field tells the sphere "this cell is N
 * steps from the player"; the sphere's surface-mode physics handles the
 * actual climb. A face-graph would multiply data by ~6× for no behavioral
 * gain at this scope.
 *
 * BFS source: the player's voxel cell. Distance = step count along
 * 6-connected air cells. Solid cells are obstacles. Unreachable cells stay
 * at UNREACHABLE; AI sees that as "no path, fall back to direct rush."
 *
 * Sampling: at a sphere's world position, take central-difference gradients
 * of the distance grid; downhill (-∇D) points toward the player along the
 * cheapest path. Spheres at different positions get genuinely different
 * directions through complex terrain, which is what produces the swarm
 * fan-out we want without per-entity pathfinding cost.
 *
 * Wrap-aware throughout: BFS neighbor lookups go through `world.isSolid`
 * (which wraps X/Z internally), and `sampleDirection` wrap-corrects the
 * sphere-to-center delta before computing local cell coords. The field's
 * extent (49 blocks) is much smaller than world width (320 blocks) so the
 * field itself never spans a wrap boundary — only the sphere↔center
 * relationship can.
 */

import type { World } from './world';

export const FLOW_RADIUS = 24; // blocks in each axis from the field center
const SIZE = FLOW_RADIUS * 2 + 1; // 49
const CELL_COUNT = SIZE * SIZE * SIZE; // ≈ 117K
const STRIDE_Y = SIZE;
const STRIDE_Z = SIZE * SIZE;

// Sentinel: max u16. Any cell that BFS doesn't reach (encased, beyond
// solids, or simply outside the field) holds this. Real distances are
// bounded by 3·FLOW_RADIUS = 72 in 6-connected BFS, well below 65535.
const UNREACHABLE = 0xffff;

const NEIGHBOR_DX = [-1, 1, 0, 0, 0, 0];
const NEIGHBOR_DY = [0, 0, -1, 1, 0, 0];
const NEIGHBOR_DZ = [0, 0, 0, 0, -1, 1];

export class FlowField {
	// Grid indexed as `lx + ly*SIZE + lz*SIZE²`. Pre-allocated, refilled in
	// place each update.
	private grid: Uint16Array = new Uint16Array(CELL_COUNT);
	// BFS queue. Same capacity as the grid since worst case is "every cell
	// gets enqueued exactly once."
	private queue: Int32Array = new Int32Array(CELL_COUNT);
	// Local solidity cache. Populated up-front each update so the BFS can
	// avoid hammering `world.isSolid` (each call walks the chunk map).
	// 1 = solid block, 0 = air.
	private solid: Uint8Array = new Uint8Array(CELL_COUNT);

	private centerBX = 0;
	private centerBY = 0;
	private centerBZ = 0;
	private valid = false;

	/** True if the field needs an update for this player cell. */
	needsUpdate(bx: number, by: number, bz: number): boolean {
		return (
			!this.valid ||
			bx !== this.centerBX ||
			by !== this.centerBY ||
			bz !== this.centerBZ
		);
	}

	/**
	 * Recompute the distance field with `(playerBX, playerBY, playerBZ)` as
	 * the BFS source. The player cell becomes local (RADIUS, RADIUS, RADIUS).
	 *
	 * If the player happens to be standing in a solid cell (shouldn't normally
	 * happen — would mean intersecting terrain), BFS still flood-fills from
	 * there; it just won't reach anything since neighbors are gated on
	 * `!isSolid`. AI fallback handles that.
	 */
	update(
		world: World,
		playerBX: number,
		playerBY: number,
		playerBZ: number,
	): void {
		this.centerBX = playerBX;
		this.centerBY = playerBY;
		this.centerBZ = playerBZ;

		// Phase 1 — cache world solidity locally. ~117K isSolid calls; the BFS
		// then reads from `this.solid` instead of going back to the world map
		// for every neighbor check (and every neighbor-of-neighbor check in the
		// sphere-traversable filter below). Without this cache, the filter
		// below would be ~5M isSolid calls per update.
		this.solid.fill(0);
		for (let lz = 0; lz < SIZE; lz++) {
			for (let ly = 0; ly < SIZE; ly++) {
				for (let lx = 0; lx < SIZE; lx++) {
					const bx = this.centerBX + (lx - FLOW_RADIUS);
					const by = this.centerBY + (ly - FLOW_RADIUS);
					const bz = this.centerBZ + (lz - FLOW_RADIUS);
					if (world.isSolid(bx, by, bz)) {
						this.solid[lx + ly * STRIDE_Y + lz * STRIDE_Z] = 1;
					}
				}
			}
		}

		// Phase 2 — BFS with sphere-traversable filter. A cell is "sphere
		// pathable" iff it's air AND has at least one solid 6-neighbor (a
		// surface a sticky sphere could stick to). Cells in the middle of
		// open shafts fail this check, so BFS doesn't flood through them
		// and doesn't produce gradients pointing into open air — which
		// sticky spheres can't follow because their motion is constrained
		// to surfaces. The source cell (player) is exempt: it gets enqueued
		// regardless so distance=0 always seeds correctly even if the player
		// is mid-air.
		this.grid.fill(UNREACHABLE);
		const startIdx =
			FLOW_RADIUS + FLOW_RADIUS * STRIDE_Y + FLOW_RADIUS * STRIDE_Z;
		this.grid[startIdx] = 0;

		let head = 0;
		let tail = 0;
		this.queue[tail++] = startIdx;

		while (head < tail) {
			const idx = this.queue[head++];
			const lx = idx % SIZE;
			const ly = Math.floor(idx / STRIDE_Y) % SIZE;
			const lz = Math.floor(idx / STRIDE_Z);
			const nextDist = this.grid[idx] + 1;

			for (let k = 0; k < 6; k++) {
				const nlx = lx + NEIGHBOR_DX[k];
				const nly = ly + NEIGHBOR_DY[k];
				const nlz = lz + NEIGHBOR_DZ[k];
				if (nlx < 0 || nlx >= SIZE) continue;
				if (nly < 0 || nly >= SIZE) continue;
				if (nlz < 0 || nlz >= SIZE) continue;

				const nidx = nlx + nly * STRIDE_Y + nlz * STRIDE_Z;
				if (this.grid[nidx] !== UNREACHABLE) continue;
				if (this.solid[nidx]) continue;

				// Sphere-traversable check: at least one of the candidate's
				// 6 neighbors must be solid. Out-of-field neighbors are
				// treated as "not solid" defensively — costs us a sliver
				// of correctness at the field's outer edge, but those cells
				// fail the sampling margin anyway.
				let pathable = false;
				for (let m = 0; m < 6; m++) {
					const mlx = nlx + NEIGHBOR_DX[m];
					const mly = nly + NEIGHBOR_DY[m];
					const mlz = nlz + NEIGHBOR_DZ[m];
					if (mlx < 0 || mlx >= SIZE) continue;
					if (mly < 0 || mly >= SIZE) continue;
					if (mlz < 0 || mlz >= SIZE) continue;
					if (this.solid[mlx + mly * STRIDE_Y + mlz * STRIDE_Z]) {
						pathable = true;
						break;
					}
				}
				if (!pathable) continue;

				this.grid[nidx] = nextDist;
				this.queue[tail++] = nidx;
			}
		}

		this.valid = true;
	}

	/** Mark the field stale. Next `update()` will recompute regardless of cell. */
	invalidate(): void {
		this.valid = false;
	}

	/**
	 * Sample the gradient direction at world position `(x, y, z)` and write
	 * a unit vector into `out`. Returns true if a valid direction was found,
	 * false if the position is outside the field, in an unreachable cell,
	 * or has degenerate gradient (caller should fall back to direct rush).
	 *
	 * Central differences are used so adjacent cells produce continuously
	 * varying directions instead of the 6 cardinal jumps a "min neighbor"
	 * lookup would give. Unreachable neighbors are substituted with the
	 * current cell's value so the sentinel doesn't dominate the gradient —
	 * effectively a one-sided difference at obstacles.
	 *
	 * `ww` and `blockSize` are passed in (rather than read from World) so
	 * AI hot path doesn't need a World reference.
	 */
	sampleDirection(
		x: number,
		y: number,
		z: number,
		ww: number,
		blockSize: number,
		out: Float32Array,
	): boolean {
		if (!this.valid) return false;

		const centerWorldX = (this.centerBX + 0.5) * blockSize;
		const centerWorldY = (this.centerBY + 0.5) * blockSize;
		const centerWorldZ = (this.centerBZ + 0.5) * blockSize;

		// Wrap-correct horizontal delta from field center
		let dx = x - centerWorldX;
		const dy = y - centerWorldY;
		let dz = z - centerWorldZ;
		const hw = ww / 2;
		if (dx > hw) dx -= ww;
		else if (dx < -hw) dx += ww;
		if (dz > hw) dz -= ww;
		else if (dz < -hw) dz += ww;

		const lx = Math.floor(dx / blockSize) + FLOW_RADIUS;
		const ly = Math.floor(dy / blockSize) + FLOW_RADIUS;
		const lz = Math.floor(dz / blockSize) + FLOW_RADIUS;

		// 1-cell margin needed for central differences
		if (lx <= 0 || lx >= SIZE - 1) return false;
		if (ly <= 0 || ly >= SIZE - 1) return false;
		if (lz <= 0 || lz >= SIZE - 1) return false;

		const idx = lx + ly * STRIDE_Y + lz * STRIDE_Z;
		const here = this.grid[idx];
		if (here === UNREACHABLE) return false;

		const xNeg = this.grid[idx - 1];
		const xPos = this.grid[idx + 1];
		const yNeg = this.grid[idx - STRIDE_Y];
		const yPos = this.grid[idx + STRIDE_Y];
		const zNeg = this.grid[idx - STRIDE_Z];
		const zPos = this.grid[idx + STRIDE_Z];

		// Substitute self for unreachable neighbors so the sentinel value
		// (~65K) doesn't blow out the gradient. This makes obstacles act
		// like "this direction has no slope," letting the open direction
		// dominate.
		const gxNeg = xNeg === UNREACHABLE ? here : xNeg;
		const gxPos = xPos === UNREACHABLE ? here : xPos;
		const gyNeg = yNeg === UNREACHABLE ? here : yNeg;
		const gyPos = yPos === UNREACHABLE ? here : yPos;
		const gzNeg = zNeg === UNREACHABLE ? here : zNeg;
		const gzPos = zPos === UNREACHABLE ? here : zPos;

		// Direction = -∇D = points toward decreasing distance (toward player).
		// Skipping the /2 — only direction matters, magnitude is normalized.
		const gx = gxNeg - gxPos;
		const gy = gyNeg - gyPos;
		const gz = gzNeg - gzPos;

		const len = Math.hypot(gx, gy, gz);
		if (len < 1e-6) return false;

		out[0] = gx / len;
		out[1] = gy / len;
		out[2] = gz / len;
		return true;
	}
}
