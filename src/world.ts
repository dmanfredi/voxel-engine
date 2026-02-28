import { type BlockId, AIR, blockRegistry } from './block';

export class World {
	readonly sizeX: number;
	readonly sizeY: number;
	readonly sizeZ: number;
	readonly blockSize: number;
	private blocks: Uint8Array;

	constructor(
		blocks: Uint8Array,
		sizeX: number,
		sizeY: number,
		sizeZ: number,
		blockSize: number,
	) {
		this.blocks = blocks;
		this.sizeX = sizeX;
		this.sizeY = sizeY;
		this.sizeZ = sizeZ;
		this.blockSize = blockSize;
	}

	private index(x: number, y: number, z: number): number {
		return y * this.sizeZ * this.sizeX + z * this.sizeX + x;
	}

	getBlock(x: number, y: number, z: number): BlockId {
		if (
			x < 0 ||
			x >= this.sizeX ||
			y < 0 ||
			y >= this.sizeY ||
			z < 0 ||
			z >= this.sizeZ
		) {
			return AIR;
		}
		return this.blocks[this.index(x, y, z)] ?? AIR;
	}

	setBlock(x: number, y: number, z: number, id: BlockId): boolean {
		if (
			x < 0 ||
			x >= this.sizeX ||
			y < 0 ||
			y >= this.sizeY ||
			z < 0 ||
			z >= this.sizeZ
		) {
			return false;
		}
		this.blocks[this.index(x, y, z)] = id;
		return true;
	}

	isSolid(x: number, y: number, z: number): boolean {
		return blockRegistry.isSolid(this.getBlock(x, y, z));
	}
}
