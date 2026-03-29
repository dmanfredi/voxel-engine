import { Chunk } from './chunk';
import { type World } from './world';
import buildChunkBlocks from './block-builder';

interface ChunkLoaderOptions {
	world: World;
	verticalRadius: number;
	loadsPerFrame: number;
	meshChunk: (cx: number, cy: number, cz: number) => void;
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
	private meshChunk: (cx: number, cy: number, cz: number) => void;
	private unmeshChunk: (cx: number, cy: number, cz: number) => void;

	private lastPlayerCY: number | null = null;
	private loadQueue: QueueEntry[] = [];

	constructor(opts: ChunkLoaderOptions) {
		this.world = opts.world;
		this.verticalRadius = opts.verticalRadius;
		this.loadsPerFrame = opts.loadsPerFrame;
		this.meshChunk = opts.meshChunk;
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

	/** Call every tick. Streams chunks vertically around the player. */
	update(playerCY: number): void {
		// If player chunk Y changed, rebuild the queue and schedule unloads
		if (playerCY !== this.lastPlayerCY) {
			this.lastPlayerCY = playerCY;

			const minCY = playerCY - this.verticalRadius;
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

			// Unload chunks outside the range (with hysteresis buffer of 1)
			const unloadMinCY = minCY - 1;
			const unloadMaxCY = maxCY + 1;
			const toRemove: QueueEntry[] = [];
			this.world.forEachChunk((chunk) => {
				if (chunk.cy < unloadMinCY || chunk.cy > unloadMaxCY) {
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

			// Skip if already loaded (could happen if queue is stale)
			if (this.world.hasChunk(cx, cy, cz)) continue;

			const blocks = buildChunkBlocks(cx, cy, cz);
			this.world.addChunk(new Chunk(cx, cy, cz, blocks));
			this.meshChunk(cx, cy, cz);

			// Remesh vertical neighbors for correct boundary AO
			if (this.world.hasChunk(cx, cy - 1, cz)) {
				this.meshChunk(cx, cy - 1, cz);
			}
			if (this.world.hasChunk(cx, cy + 1, cz)) {
				this.meshChunk(cx, cy + 1, cz);
			}

			loaded++;
		}
	}
}
