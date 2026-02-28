import type Block from './Block';
import { NOTHING } from './Block';

export class World {
	readonly sizeX: number;
	readonly sizeY: number;
	readonly sizeZ: number;
	readonly blockSize: number;
	private blocks: Block[][][]; // [y][z][x]

	constructor(
		blocks: Block[][][],
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

	getBlock(x: number, y: number, z: number): Block | null {
		if (
			x < 0 ||
			x >= this.sizeX ||
			y < 0 ||
			y >= this.sizeY ||
			z < 0 ||
			z >= this.sizeZ
		) {
			return null;
		}
		return this.blocks[y]?.[z]?.[x] ?? null;
	}

	setBlock(x: number, y: number, z: number, block: Block): boolean {
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
		const row = this.blocks[y]?.[z];
		if (!row) return false;
		row[x] = block;
		return true;
	}

	isSolid(x: number, y: number, z: number): boolean {
		const block = this.getBlock(x, y, z);
		return block !== null && block.type !== NOTHING;
	}
}
