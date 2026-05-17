/**
 * Flow field — 3D BFS distance grid centered on the player. Spheres pursue
 * around obstacles instead of bonking straight at the target by sampling the
 * gradient. Solves pillar-vs-pillar stalemates and concave-corner stuck cases
 * that pure-pursuit can't.
 *
 * Granularity: one distance value per voxel. For sticky-aware navigation that's
 * enough — the field tells the sphere "this cell is N steps from the player,"
 * the sphere's surface-mode physics handles the actual climb. A face-graph
 * would multiply data by ~6× for no behavioral gain at this scope.
 *
 * Sphere-traversable filter (in BFS): only flood air cells that are
 * "near-surface" — within `maxReachCells` Chebyshev distance of a solid
 * block. Two reasons it's Chebyshev (3³-cube dilation) rather than the
 * obvious 6-cardinal check:
 *   1. Convex-edge wrap. A cell diagonally adjacent to a pillar's top
 *      corner has no cardinal solid neighbor, so a 6-cardinal filter
 *      strands BFS on top of the pillar. Cubic dilation captures
 *      that cell and lets BFS descend.
 *   2. Big spheres. A sphere of radius r attached to a wall sits
 *      r/blockSize cells off the surface; its center cell has no
 *      cardinal solid neighbor for r > blockSize. K = max sphere
 *      radius in cells captures that case too.
 * Gradients in deep open air would tell a non-flying sphere to "go up"
 * across a shaft it can't cross, so the filter is still load-bearing —
 * just at the right radius.
 *
 * Sampling uses central differences for smooth direction across cell
 * boundaries (a "min neighbor" lookup would produce 6 discrete cardinal
 * jumps). Unreachable neighbors are substituted with the cell's own value
 * so the sentinel doesn't dominate the gradient — effectively a one-sided
 * difference at obstacles.
 *
 * Wrap-aware: BFS neighbor solidity goes through `world.isSolid` (which
 * wraps X/Z internally), and `sampleDirection` wrap-corrects the sphere-to-
 * center delta before computing local cell coords. The field's extent
 * (49 blocks) is much smaller than world width so the field itself never
 * spans a wrap boundary — only the sphere↔center relationship can.
 *
 * See notes/sticky-spheres.md for the broader pursuit/locomotion model
 * this layer plugs into.
 */

import type { World } from './world';

export const FLOW_RADIUS = 24; // blocks in each axis from the field center
const SIZE = FLOW_RADIUS * 2 + 1; // 49
const CELL_COUNT = SIZE * SIZE * SIZE; // ≈ 117K
const STRIDE_Y = SIZE;
const STRIDE_Z = SIZE * SIZE;

// Sentinel: max u16. Any cell BFS doesn't reach holds this. Real distances
// are bounded by 3·FLOW_RADIUS = 72 in 6-connected BFS, well below 65535.
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
	// Local solidity cache. Populated up-front each update so downstream
	// passes read from `this.solid` instead of going back to the world map.
	private solid: Uint8Array = new Uint8Array(CELL_COUNT);
	// "Near-surface" mask — 1 if a solid cell exists within `maxReachCells`
	// of this cell (Chebyshev distance). BFS uses this in place of an
	// inline neighborhood check so the per-cell loop body stays cheap.
	private nearSurface: Uint8Array = new Uint8Array(CELL_COUNT);

	private centerBX = 0;
	private centerBY = 0;
	private centerBZ = 0;
	private lastReach = 0;
	private valid = false;

	/** True if the field needs an update for this player cell / sphere reach. */
	needsUpdate(
		bx: number,
		by: number,
		bz: number,
		maxReachCells: number,
	): boolean {
		return (
			!this.valid ||
			bx !== this.centerBX ||
			by !== this.centerBY ||
			bz !== this.centerBZ ||
			maxReachCells !== this.lastReach
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
		maxReachCells: number,
	): void {
		this.centerBX = playerBX;
		this.centerBY = playerBY;
		this.centerBZ = playerBZ;
		this.lastReach = maxReachCells;

		// Phase 1 — cache world solidity locally. ~117K isSolid calls; the
		// dilation pass below would otherwise hit the world map ~(2K+1)³
		// times more.
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

		// Phase 2 — dilate solid mask into `nearSurface` by K cells. For
		// each solid cell, mark the (2K+1)³ Chebyshev cube around it.
		// Cost bounded by solidCount · (2K+1)³ writes — ~27× at K=1,
		// ~125× at K=2. Revisit with a separable filter if it shows up
		// in profiling.
		this.nearSurface.fill(0);
		const K = Math.max(1, maxReachCells);
		for (let lz = 0; lz < SIZE; lz++) {
			for (let ly = 0; ly < SIZE; ly++) {
				for (let lx = 0; lx < SIZE; lx++) {
					if (!this.solid[lx + ly * STRIDE_Y + lz * STRIDE_Z]) {
						continue;
					}
					const lx0 = Math.max(0, lx - K);
					const lx1 = Math.min(SIZE - 1, lx + K);
					const ly0 = Math.max(0, ly - K);
					const ly1 = Math.min(SIZE - 1, ly + K);
					const lz0 = Math.max(0, lz - K);
					const lz1 = Math.min(SIZE - 1, lz + K);
					for (let mz = lz0; mz <= lz1; mz++) {
						for (let my = ly0; my <= ly1; my++) {
							const rowBase = my * STRIDE_Y + mz * STRIDE_Z;
							for (let mx = lx0; mx <= lx1; mx++) {
								this.nearSurface[mx + rowBase] = 1;
							}
						}
					}
				}
			}
		}

		// Phase 3 — BFS through air cells inside the near-surface band.
		// The player cell is exempt: it gets enqueued regardless so
		// distance=0 seeds correctly even if the player is mid-air.
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
				if (!this.nearSurface[nidx]) continue;

				this.grid[nidx] = nextDist;
				this.queue[tail++] = nidx;
			}
		}

		this.valid = true;
	}

	/** Mark the field stale. Next `update()` recomputes regardless of cell. */
	invalidate(): void {
		this.valid = false;
	}

	// ── Debug-only accessors (read-only; visualizer touches these per
	// frame). Live in the class to avoid widening the public surface to
	// general callers. Callers must not mutate the returned arrays.

	get isReady(): boolean {
		return this.valid;
	}

	getCenter(): { bx: number; by: number; bz: number } {
		return {
			bx: this.centerBX,
			by: this.centerBY,
			bz: this.centerBZ,
		};
	}

	getSolidMask(): Uint8Array {
		return this.solid;
	}

	getDistanceGrid(): Uint16Array {
		return this.grid;
	}

	getNearSurfaceMask(): Uint8Array {
		return this.nearSurface;
	}

	/**
	 * Diagnostic dump for the cell containing `(x, y, z)` plus its 6
	 * cardinal neighbors. Lets the AI log distinguish "filter rejected
	 * this cell" (here.near === 0) from "filter passed but BFS couldn't
	 * reach" (here.near === 1 && here.dist === UNREACHABLE).
	 *
	 * `inField` is false if the cell lies outside the field bounds —
	 * masks/grid values for out-of-field cells are returned as 0 / UNREACHABLE.
	 */
	diagnoseCell(
		x: number,
		y: number,
		z: number,
		ww: number,
		blockSize: number,
	): {
		inField: boolean;
		worldCell: [number, number, number];
		here: { solid: number; near: number; dist: number };
		neighbors: {
			axis: string;
			worldCell: [number, number, number];
			inField: boolean;
			solid: number;
			near: number;
			dist: number;
		}[];
	} {
		const centerWorldX = this.centerBX * blockSize;
		const centerWorldY = this.centerBY * blockSize;
		const centerWorldZ = this.centerBZ * blockSize;

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

		const sampleAt = (
			llx: number,
			lly: number,
			llz: number,
		): { inField: boolean; solid: number; near: number; dist: number } => {
			if (
				llx < 0 ||
				llx >= SIZE ||
				lly < 0 ||
				lly >= SIZE ||
				llz < 0 ||
				llz >= SIZE
			) {
				return {
					inField: false,
					solid: 0,
					near: 0,
					dist: UNREACHABLE,
				};
			}
			const idx = llx + lly * STRIDE_Y + llz * STRIDE_Z;
			return {
				inField: true,
				solid: this.solid[idx],
				near: this.nearSurface[idx],
				dist: this.grid[idx],
			};
		};

		const here = sampleAt(lx, ly, lz);
		const inField = here.inField;
		const worldBX = this.centerBX + (lx - FLOW_RADIUS);
		const worldBY = this.centerBY + (ly - FLOW_RADIUS);
		const worldBZ = this.centerBZ + (lz - FLOW_RADIUS);

		const axes = [
			['-x', -1, 0, 0],
			['+x', 1, 0, 0],
			['-y', 0, -1, 0],
			['+y', 0, 1, 0],
			['-z', 0, 0, -1],
			['+z', 0, 0, 1],
		] as const;
		const neighbors = axes.map(([axis, ax, ay, az]) => {
			const sample = sampleAt(lx + ax, ly + ay, lz + az);
			return {
				axis,
				worldCell: [worldBX + ax, worldBY + ay, worldBZ + az] as [
					number,
					number,
					number,
				],
				inField: sample.inField,
				solid: sample.solid,
				near: sample.near,
				dist: sample.dist,
			};
		});

		return {
			inField,
			worldCell: [worldBX, worldBY, worldBZ],
			here: { solid: here.solid, near: here.near, dist: here.dist },
			neighbors,
		};
	}

	/**
	 * Diagnostic helper — returns *why* sampleDirection would fail (or 'ok'
	 * if it would succeed) at the given world position. Temporary debug seam
	 * for the AI logging; safe to remove once the flow field is dialed in.
	 */
	debugCellStatus(
		x: number,
		y: number,
		z: number,
		ww: number,
		blockSize: number,
	): 'invalid' | 'out-of-bounds' | 'unreachable' | 'ok' {
		if (!this.valid) return 'invalid';

		const centerWorldX = this.centerBX * blockSize;
		const centerWorldY = this.centerBY * blockSize;
		const centerWorldZ = this.centerBZ * blockSize;

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
		if (lx <= 0 || lx >= SIZE - 1) return 'out-of-bounds';
		if (ly <= 0 || ly >= SIZE - 1) return 'out-of-bounds';
		if (lz <= 0 || lz >= SIZE - 1) return 'out-of-bounds';

		const idx = lx + ly * STRIDE_Y + lz * STRIDE_Z;
		if (this.grid[idx] === UNREACHABLE) return 'unreachable';
		return 'ok';
	}

	/**
	 * Sample the gradient direction at world position `(x, y, z)` and write
	 * a unit vector into `out`. Returns true if a valid direction was found,
	 * false if the position is outside the field, in an unreachable cell,
	 * or the gradient is degenerate (caller should fall back to direct rush).
	 *
	 * `ww` and `blockSize` are passed in (rather than read from World) so
	 * the AI hot path doesn't need a World reference.
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

		// Reference cell LEFT EDGE, not center. Using (centerBX + 0.5) *
		// blockSize here would shift the floor() by half a cell — sphere
		// positions in the lower half of their cell would round to the
		// wrong cell, off-by-one in -X/-Y/-Z.
		const centerWorldX = this.centerBX * blockSize;
		const centerWorldY = this.centerBY * blockSize;
		const centerWorldZ = this.centerBZ * blockSize;

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

		// 1-cell margin for central differences
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

		// Substitute self for unreachable neighbors so the sentinel doesn't
		// blow out the gradient. Obstacles then act like "no slope this way,"
		// letting the open direction dominate.
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
