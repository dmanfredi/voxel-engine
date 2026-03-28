import { type BlockId, AIR, blockRegistry } from './block';
import { Chunk, CHUNK_SIZE, chunkKey } from './chunk';

export class World {
	readonly blockSize: number;
	readonly widthChunks: number;
	private readonly widthBlocks: number;
	private chunks = new Map<string, Chunk>();

	constructor(blockSize: number, widthChunks: number) {
		this.blockSize = blockSize;
		this.widthChunks = widthChunks;
		this.widthBlocks = widthChunks * CHUNK_SIZE;
	}

	private wrapX(x: number): number {
		return ((x % this.widthBlocks) + this.widthBlocks) % this.widthBlocks;
	}

	private wrapZ(z: number): number {
		return ((z % this.widthBlocks) + this.widthBlocks) % this.widthBlocks;
	}

	addChunk(chunk: Chunk): void {
		this.chunks.set(chunkKey(chunk.cx, chunk.cy, chunk.cz), chunk);
	}

	getChunk(cx: number, cy: number, cz: number): Chunk | undefined {
		return this.chunks.get(chunkKey(cx, cy, cz));
	}

	forEachChunk(cb: (chunk: Chunk) => void): void {
		for (const chunk of this.chunks.values()) {
			cb(chunk);
		}
	}

	getBlock(x: number, y: number, z: number): BlockId {
		const wx = this.wrapX(x);
		const wz = this.wrapZ(z);
		const cx = Math.floor(wx / CHUNK_SIZE);
		const cy = Math.floor(y / CHUNK_SIZE);
		const cz = Math.floor(wz / CHUNK_SIZE);
		const chunk = this.chunks.get(chunkKey(cx, cy, cz));
		if (!chunk) return AIR;

		const lx = wx % CHUNK_SIZE;
		const ly = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
		const lz = wz % CHUNK_SIZE;
		return chunk.blocks[chunk.index(lx, ly, lz)] ?? AIR;
	}

	setBlock(x: number, y: number, z: number, id: BlockId): boolean {
		const wx = this.wrapX(x);
		const wz = this.wrapZ(z);
		const cx = Math.floor(wx / CHUNK_SIZE);
		const cy = Math.floor(y / CHUNK_SIZE);
		const cz = Math.floor(wz / CHUNK_SIZE);
		const chunk = this.chunks.get(chunkKey(cx, cy, cz));
		if (!chunk) return false;

		const lx = wx % CHUNK_SIZE;
		const ly = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
		const lz = wz % CHUNK_SIZE;
		chunk.blocks[chunk.index(lx, ly, lz)] = id;
		return true;
	}

	isSolid(x: number, y: number, z: number): boolean {
		return blockRegistry.isSolid(this.getBlock(x, y, z));
	}
}
