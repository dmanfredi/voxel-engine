export const CHUNK_SIZE = 32;

export function chunkKey(cx: number, cy: number, cz: number): string {
	return `${String(cx)},${String(cy)},${String(cz)}`;
}

export class Chunk {
	readonly cx: number;
	readonly cy: number;
	readonly cz: number;
	readonly blocks: Uint8Array;

	constructor(cx: number, cy: number, cz: number, blocks: Uint8Array) {
		this.cx = cx;
		this.cy = cy;
		this.cz = cz;
		this.blocks = blocks;
	}

	/** Flat index from chunk-local coordinates. */
	index(lx: number, ly: number, lz: number): number {
		return ly * CHUNK_SIZE * CHUNK_SIZE + lz * CHUNK_SIZE + lx;
	}
}
