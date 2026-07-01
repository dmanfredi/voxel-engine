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

	removeChunk(cx: number, cy: number, cz: number): void {
		this.chunks.delete(chunkKey(cx, cy, cz));
	}

	hasChunk(cx: number, cy: number, cz: number): boolean {
		return this.chunks.has(chunkKey(cx, cy, cz));
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

	/**
	 * Fill `out` with 0/1 solidity for an axis-aligned block-coordinate box.
	 * The destination layout is x + y*strideY + z*strideZ. Missing chunks read
	 * as air. X/Z wrap horizontally just like getBlock().
	 */
	fillSolidMask(
		minX: number,
		minY: number,
		minZ: number,
		sizeX: number,
		sizeY: number,
		sizeZ: number,
		out: Uint8Array,
		strideY: number,
		strideZ: number,
	): void {
		out.fill(0);

		const maxX = minX + sizeX;
		const maxY = minY + sizeY;
		const maxZ = minZ + sizeZ;
		const minCX = Math.floor(minX / CHUNK_SIZE);
		const maxCX = Math.floor((maxX - 1) / CHUNK_SIZE);
		const minCY = Math.floor(minY / CHUNK_SIZE);
		const maxCY = Math.floor((maxY - 1) / CHUNK_SIZE);
		const minCZ = Math.floor(minZ / CHUNK_SIZE);
		const maxCZ = Math.floor((maxZ - 1) / CHUNK_SIZE);
		const CS2 = CHUNK_SIZE * CHUNK_SIZE;
		const solidFlags = blockRegistry.solidFlags;
		const w = this.widthChunks;

		for (let cy = minCY; cy <= maxCY; cy++) {
			const chunkMinY = cy * CHUNK_SIZE;
			const y0 = Math.max(minY, chunkMinY);
			const y1 = Math.min(maxY, chunkMinY + CHUNK_SIZE);

			for (let cz = minCZ; cz <= maxCZ; cz++) {
				const chunkMinZ = cz * CHUNK_SIZE;
				const z0 = Math.max(minZ, chunkMinZ);
				const z1 = Math.min(maxZ, chunkMinZ + CHUNK_SIZE);
				const wrappedCZ = ((cz % w) + w) % w;

				for (let cx = minCX; cx <= maxCX; cx++) {
					const wrappedCX = ((cx % w) + w) % w;
					const chunk = this.chunks.get(
						chunkKey(wrappedCX, cy, wrappedCZ),
					);
					if (!chunk) continue;

					const chunkMinX = cx * CHUNK_SIZE;
					const x0 = Math.max(minX, chunkMinX);
					const x1 = Math.min(maxX, chunkMinX + CHUNK_SIZE);
					const localX0 = x0 - chunkMinX;
					const runLength = x1 - x0;
					const blocks = chunk.blocks;

					for (let y = y0; y < y1; y++) {
						const localY = y - chunkMinY;
						const dstY = (y - minY) * strideY;
						const srcY = localY * CS2;

						for (let z = z0; z < z1; z++) {
							const localZ = z - chunkMinZ;
							let dst = dstY + (z - minZ) * strideZ + (x0 - minX);
							let src = srcY + localZ * CHUNK_SIZE + localX0;
							const srcEnd = src + runLength;
							while (src < srcEnd) {
								out[dst++] = solidFlags[blocks[src++]];
							}
						}
					}
				}
			}
		}
	}

	/**
	 * Build a padded (CHUNK_SIZE+2)³ block array for the mesher.
	 * Contains the target chunk's blocks in the interior, plus a 1-block
	 * border read directly from neighbor chunk arrays.
	 *
	 * Pre-fetches the 26 neighbor chunks (6 face + 12 edge + 8 corner) with
	 * only 26 Map lookups total, then copies border cells via direct array
	 * access — no per-cell getBlock/chunkKey/string allocation overhead.
	 */
	buildPaddedBlocks(cx: number, cy: number, cz: number): Uint8Array {
		const PAD = CHUNK_SIZE + 2;
		const PAD2 = PAD * PAD;
		const MASK = CHUNK_SIZE - 1; // 31 — works because CHUNK_SIZE is a power of 2
		const CS2 = CHUNK_SIZE * CHUNK_SIZE;
		const padded = new Uint8Array(PAD * PAD2);

		const chunk = this.getChunk(cx, cy, cz);
		if (!chunk) return padded;

		// Fast interior copy: row-by-row from the chunk's flat block array
		for (let ly = 0; ly < CHUNK_SIZE; ly++) {
			for (let lz = 0; lz < CHUNK_SIZE; lz++) {
				const srcOff = ly * CS2 + lz * CHUNK_SIZE;
				const dstOff = (ly + 1) * PAD2 + (lz + 1) * PAD + 1;
				padded.set(
					chunk.blocks.subarray(srcOff, srcOff + CHUNK_SIZE),
					dstOff,
				);
			}
		}

		// Border: iterate the 26 neighbor directions, fetch each chunk once,
		// then copy the relevant border cells directly from its block array.
		const w = this.widthChunks;
		for (let dy = -1; dy <= 1; dy++) {
			for (let dz = -1; dz <= 1; dz++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (dx === 0 && dy === 0 && dz === 0) continue;

					const ncx = (((cx + dx) % w) + w) % w;
					const ncy = cy + dy;
					const ncz = (((cz + dz) % w) + w) % w;
					const neighbor = this.getChunk(ncx, ncy, ncz);
					if (!neighbor) continue;
					const nb = neighbor.blocks;

					// Determine which padded cells this neighbor fills.
					// For the offset axis: just the single border slice (-1 or CHUNK_SIZE).
					// For non-offset axes: the full interior range [0, CHUNK_SIZE-1].
					const lxMin = dx === -1 ? -1 : dx === 1 ? CHUNK_SIZE : 0;
					const lxMax = dx === -1 ? -1 : dx === 1 ? CHUNK_SIZE : MASK;
					const lyMin = dy === -1 ? -1 : dy === 1 ? CHUNK_SIZE : 0;
					const lyMax = dy === -1 ? -1 : dy === 1 ? CHUNK_SIZE : MASK;
					const lzMin = dz === -1 ? -1 : dz === 1 ? CHUNK_SIZE : 0;
					const lzMax = dz === -1 ? -1 : dz === 1 ? CHUNK_SIZE : MASK;

					for (let ly = lyMin; ly <= lyMax; ly++) {
						for (let lz = lzMin; lz <= lzMax; lz++) {
							for (let lx = lxMin; lx <= lxMax; lx++) {
								padded[
									(ly + 1) * PAD2 + (lz + 1) * PAD + (lx + 1)
								] =
									nb[
										(ly & MASK) * CS2 +
											(lz & MASK) * CHUNK_SIZE +
											(lx & MASK)
									];
							}
						}
					}
				}
			}
		}

		return padded;
	}
}
