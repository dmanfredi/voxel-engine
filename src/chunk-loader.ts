import { Chunk } from './chunk';
import { type World } from './world';
import buildChunkBlocks from './block-builder';

interface ChunkLoaderOptions {
	world: World;
	verticalRadius: number;
	loadsPerFrame: number;
	scheduleMeshChunk: (cx: number, cy: number, cz: number) => void;
	unmeshChunk: (cx: number, cy: number, cz: number) => void;
}

interface QueueEntry {
	cx: number;
	cy: number;
	cz: number;
}

export class ChunkLoader {
	private world: World;
	private verticalRadius: number;
	private loadsPerFrame: number;
	private scheduleMeshChunk: (cx: number, cy: number, cz: number) => void;
	private unmeshChunk: (cx: number, cy: number, cz: number) => void;

	private lastPlayerCY: number | null = null;
	private lastVoidFloorCY: number | null = null;
	private loadQueue: QueueEntry[] = [];

	constructor(opts: ChunkLoaderOptions) {
		this.world = opts.world;
		this.verticalRadius = opts.verticalRadius;
		this.loadsPerFrame = opts.loadsPerFrame;
		this.scheduleMeshChunk = opts.scheduleMeshChunk;
		this.unmeshChunk = opts.unmeshChunk;
	}

	/** Synchronously load all chunks in the initial vertical window. */
	loadInitial(playerCY: number): void {
		const w = this.world.widthChunks;
		const minCY = playerCY - this.verticalRadius;
		const maxCY = playerCY + this.verticalRadius;

		for (let cy = minCY; cy <= maxCY; cy++) {
			for (let cz = 0; cz < w; cz++) {
				for (let cx = 0; cx < w; cx++) {
					if (!this.world.hasChunk(cx, cy, cz)) {
						const blocks = buildChunkBlocks(cx, cy, cz);
						this.world.addChunk(new Chunk(cx, cy, cz, blocks));
					}
				}
			}
		}

		this.lastPlayerCY = playerCY;
	}

	/**
	 * Call every tick. Streams chunks vertically around the player.
	 *
	 * `voidFloorCY` is the chunk-Y below which the void has consumed the world
	 * — those chunks are never loaded and any still resident are deleted.
	 */
	update(playerCY: number, voidFloorCY: number): void {
		if (
			playerCY !== this.lastPlayerCY ||
			voidFloorCY !== this.lastVoidFloorCY
		) {
			this.lastPlayerCY = playerCY;
			this.lastVoidFloorCY = voidFloorCY;

			const minCY = Math.max(playerCY - this.verticalRadius, voidFloorCY);
			const maxCY = playerCY + this.verticalRadius;
			const w = this.world.widthChunks;

			// Queue new chunks that need loading
			this.loadQueue = [];
			for (let cy = minCY; cy <= maxCY; cy++) {
				for (let cz = 0; cz < w; cz++) {
					for (let cx = 0; cx < w; cx++) {
						if (!this.world.hasChunk(cx, cy, cz)) {
							this.loadQueue.push({ cx, cy, cz });
						}
					}
				}
			}

			// Sort by distance to player Y (closest first)
			this.loadQueue.sort(
				(a, b) => Math.abs(a.cy - playerCY) - Math.abs(b.cy - playerCY),
			);

			// Unload chunks outside the range (hysteresis of 1 on the radius
			// side; none below the void floor — consumed is consumed).
			const unloadMinCY = minCY - 1;
			const unloadMaxCY = maxCY + 1;
			const toRemove: QueueEntry[] = [];
			this.world.forEachChunk((chunk) => {
				if (
					chunk.cy < unloadMinCY ||
					chunk.cy > unloadMaxCY ||
					chunk.cy < voidFloorCY
				) {
					toRemove.push({
						cx: chunk.cx,
						cy: chunk.cy,
						cz: chunk.cz,
					});
				}
			});
			for (const { cx, cy, cz } of toRemove) {
				this.unmeshChunk(cx, cy, cz);
				this.world.removeChunk(cx, cy, cz);
			}
		}

		// Process the load queue
		let loaded = 0;
		while (this.loadQueue.length > 0 && loaded < this.loadsPerFrame) {
			const entry = this.loadQueue.shift();
			if (!entry) break;
			const { cx, cy, cz } = entry;

			// Skip if already loaded, or now consumed by the void.
			if (this.world.hasChunk(cx, cy, cz)) continue;
			if (cy < voidFloorCY) continue;

			const blocks = buildChunkBlocks(cx, cy, cz);
			this.world.addChunk(new Chunk(cx, cy, cz, blocks));
			this.scheduleMeshChunk(cx, cy, cz);

			// Remesh vertical neighbors for correct boundary AO
			if (this.world.hasChunk(cx, cy - 1, cz)) {
				this.scheduleMeshChunk(cx, cy - 1, cz);
			}
			if (this.world.hasChunk(cx, cy + 1, cz)) {
				this.scheduleMeshChunk(cx, cy + 1, cz);
			}

			loaded++;
		}
	}
}
