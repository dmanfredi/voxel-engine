/**
 * Jungle gym — hardcoded test obstacles for sphere physics and AI. A flat
 * marble floor near spawn supports a row of 8 distinct obstacles laid out
 * along the X axis, south of the player's spawn cell (the default camera
 * faces -Z, so obstacles end up directly in front of you). Each obstacle
 * occupies an 8×8 footprint cell so it's easy to read at a glance which
 * one a sphere is interacting with.
 *
 * Layout (south of spawn, sweeping west-to-east):
 *   Cell 0 — Tall pillar           (vertical climb)
 *   Cell 1 — Single step           (one convex edge + concave base)
 *   Cell 2 — Staircase             (continuous concave-corner traversal)
 *   Cell 3 — L shape               (platform + wall, inside corner)
 *   Cell 4 — Overhang              (vertical → ceiling transition)
 *   Cell 5 — Bridge                (two pillars + horizontal span)
 *   Cell 6 — Isolated cube         (rolling around finite convex object)
 *   Cell 7 — Two parallel walls    (detachment / cross-gap behavior)
 *
 * Floor is a single block-thick layer at world Y=156 (top surface at
 * world Y=1570). Default spawn at world Y=1600 lands a few units above
 * the floor — brief drop, no penetration. Outside the 100×100 floor
 * footprint there's no terrain at all; you can walk off into open sky.
 *
 * Determinism: pure hardcoded coords. No RNG.
 */

import { CHUNK_SIZE } from '../chunk';
import { MARBLE, DARK_MARBLE } from '../block';

// World-block layout constants. SPAWN_BX/BZ must match the player's
// spawn position in main.ts (worldCenter / BLOCK_SIZE = 160).
const SPAWN_BX = 160;
const SPAWN_BZ = 160;
const FLOOR_Y = 156;

// Floor extent — 100×100 square centered on spawn. Big enough for spheres
// to roll around between obstacles without immediately falling off.
const FLOOR_HALF_WIDTH = 50;

// Obstacle row layout. 8 cells × 12 blocks each = 96 blocks of total width,
// centered on spawn so the row extends symmetrically east/west. Each
// obstacle's 8×8 footprint sits with a 2-block buffer on every X side
// (4 blocks of clearance between adjacent obstacles), giving the player
// and AI room to maneuver around any one shape in isolation. ROW_Z
// places the row 24 blocks south of spawn so the player can see all 8
// obstacles in a single forward-facing glance.
const CELL_W = 12;
const NUM_CELLS = 8;
const ROW_START_X = SPAWN_BX - (NUM_CELLS * CELL_W) / 2; // 112
const ROW_Z = SPAWN_BZ - 24; // 136

// Obstacles sit atop the floor — first block above the floor surface.
const OBSTACLE_Y = FLOOR_Y + 1;

/**
 * Place a solid axis-aligned box of `blockId` in `blocks`, clipped to
 * this chunk's spatial extent. Inputs are world-space block coords; this
 * handles the conversion to chunk-local indices and the clipping. No-op
 * if the box doesn't overlap this chunk.
 */
function placeBox(
	blocks: Uint8Array<ArrayBuffer>,
	cx: number,
	cy: number,
	cz: number,
	x0: number,
	y0: number,
	z0: number,
	dx: number,
	dy: number,
	dz: number,
	blockId: number,
): void {
	const baseX = cx * CHUNK_SIZE;
	const baseY = cy * CHUNK_SIZE;
	const baseZ = cz * CHUNK_SIZE;

	const lxStart = Math.max(0, x0 - baseX);
	const lyStart = Math.max(0, y0 - baseY);
	const lzStart = Math.max(0, z0 - baseZ);
	const lxEnd = Math.min(CHUNK_SIZE, x0 + dx - baseX);
	const lyEnd = Math.min(CHUNK_SIZE, y0 + dy - baseY);
	const lzEnd = Math.min(CHUNK_SIZE, z0 + dz - baseZ);

	if (lxStart >= lxEnd || lyStart >= lyEnd || lzStart >= lzEnd) return;

	for (let ly = lyStart; ly < lyEnd; ly++) {
		for (let lz = lzStart; lz < lzEnd; lz++) {
			const rowBase = ly * CHUNK_SIZE * CHUNK_SIZE + lz * CHUNK_SIZE;
			for (let lx = lxStart; lx < lxEnd; lx++) {
				blocks[rowBase + lx] = blockId;
			}
		}
	}
}

export default function jungleGym(
	cx: number,
	cy: number,
	cz: number,
	blocks: Uint8Array<ArrayBuffer>,
): void {
	// Marble floor plane — single layer
	placeBox(
		blocks,
		cx,
		cy,
		cz,
		SPAWN_BX - FLOOR_HALF_WIDTH,
		FLOOR_Y,
		SPAWN_BZ - FLOOR_HALF_WIDTH,
		FLOOR_HALF_WIDTH * 2,
		1,
		FLOOR_HALF_WIDTH * 2,
		MARBLE,
	);

	// Obstacles use DARK_MARBLE for visual contrast against the floor.

	// Cell 0: Tall pillar — 3×18×3, centered in cell. Plain vertical climb.
	{
		const x0 = ROW_START_X + 0 * CELL_W;
		placeBox(
			blocks,
			cx,
			cy,
			cz,
			x0 + 5,
			OBSTACLE_Y,
			ROW_Z + 3,
			3,
			18,
			3,
			DARK_MARBLE,
		);
	}

	// Cell 1: Single step — 5×3×5 raised platform. One concave corner at
	// each base edge, one convex edge at each top edge.
	{
		const x0 = ROW_START_X + 1 * CELL_W;
		placeBox(
			blocks,
			cx,
			cy,
			cz,
			x0 + 4,
			OBSTACLE_Y,
			ROW_Z + 2,
			5,
			3,
			5,
			DARK_MARBLE,
		);
	}

	// Cell 2: Staircase — 4 steps, ascending in +Z (away from player). Each
	// step is a 5-wide box starting at the floor, with progressively taller
	// heights. The shortest step (1 tall) faces the player so a sphere
	// approaching from spawn climbs from the low end.
	{
		const x0 = ROW_START_X + 2 * CELL_W;
		for (let i = 0; i < 4; i++) {
			placeBox(
				blocks,
				cx,
				cy,
				cz,
				x0 + 4,
				OBSTACLE_Y,
				ROW_Z + i * 2,
				5,
				i + 1,
				2,
				DARK_MARBLE,
			);
		}
	}

	// Cell 3: L shape — 6×2×2 horizontal platform with a 1×6×2 wall rising
	// at the +X end. Inside corner where wall meets platform-top.
	{
		const x0 = ROW_START_X + 3 * CELL_W;
		placeBox(
			blocks,
			cx,
			cy,
			cz,
			x0 + 3,
			OBSTACLE_Y,
			ROW_Z + 3,
			6,
			2,
			2,
			DARK_MARBLE,
		);
		placeBox(
			blocks,
			cx,
			cy,
			cz,
			x0 + 8,
			OBSTACLE_Y + 2,
			ROW_Z + 3,
			1,
			6,
			2,
			DARK_MARBLE,
		);
	}

	// Cell 4: Overhang — 2×8×2 vertical column with a 6×2×2 horizontal arm
	// at the top, extending in +X. The arm overhangs open air; underneath
	// the arm is the test region. Convex edge at the top-front of the
	// column transitions a climbing sphere from wall → ceiling.
	{
		const x0 = ROW_START_X + 4 * CELL_W;
		placeBox(
			blocks,
			cx,
			cy,
			cz,
			x0 + 3,
			OBSTACLE_Y,
			ROW_Z + 3,
			2,
			8,
			2,
			DARK_MARBLE,
		);
		placeBox(
			blocks,
			cx,
			cy,
			cz,
			x0 + 3,
			OBSTACLE_Y + 6,
			ROW_Z + 3,
			6,
			2,
			2,
			DARK_MARBLE,
		);
	}

	// Cell 5: Bridge — two 2×6×2 pillars separated by 2 blocks in X, with
	// a 6×2×2 span across the top. Sphere climbs one pillar, traverses
	// the bridge top, descends the other.
	{
		const x0 = ROW_START_X + 5 * CELL_W;
		placeBox(
			blocks,
			cx,
			cy,
			cz,
			x0 + 3,
			OBSTACLE_Y,
			ROW_Z + 3,
			2,
			6,
			2,
			DARK_MARBLE,
		);
		placeBox(
			blocks,
			cx,
			cy,
			cz,
			x0 + 7,
			OBSTACLE_Y,
			ROW_Z + 3,
			2,
			6,
			2,
			DARK_MARBLE,
		);
		placeBox(
			blocks,
			cx,
			cy,
			cz,
			x0 + 3,
			OBSTACLE_Y + 6,
			ROW_Z + 3,
			6,
			2,
			2,
			DARK_MARBLE,
		);
	}

	// Cell 6: Isolated cube — 5×5×5 standalone. Convex on all faces; tests
	// rolling around all four side edges and the top-rim convex transitions.
	{
		const x0 = ROW_START_X + 6 * CELL_W;
		placeBox(
			blocks,
			cx,
			cy,
			cz,
			x0 + 4,
			OBSTACLE_Y,
			ROW_Z + 2,
			5,
			5,
			5,
			DARK_MARBLE,
		);
	}

	// Cell 7: Two parallel walls — 1×6×6 each, separated by 2 blocks in X
	// (gap from x0+5 to x0+7). Sphere stuck on one wall: stays attached
	// (correct) vs. drifts to the neighbor (detachment bug).
	{
		const x0 = ROW_START_X + 7 * CELL_W;
		placeBox(
			blocks,
			cx,
			cy,
			cz,
			x0 + 4,
			OBSTACLE_Y,
			ROW_Z + 1,
			1,
			6,
			6,
			DARK_MARBLE,
		);
		placeBox(
			blocks,
			cx,
			cy,
			cz,
			x0 + 7,
			OBSTACLE_Y,
			ROW_Z + 1,
			1,
			6,
			6,
			DARK_MARBLE,
		);
	}
}
