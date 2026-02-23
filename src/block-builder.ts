import Block, { DIRT, NOTHING } from './Block';
const MAX_CUBE_SIZE = 8;

export const CHUNK_SIZE_X = 2048;
export const CHUNK_SIZE_Y = MAX_CUBE_SIZE;
export const CHUNK_SIZE_Z = 2048;

function create3DArray() {
	return Array.from({ length: CHUNK_SIZE_Y }, (_, y) =>
		Array.from({ length: CHUNK_SIZE_Z }, () =>
			Array.from({ length: CHUNK_SIZE_X }, () => {
				if (y === 0) {
					return new Block(DIRT);
				}

				return new Block(NOTHING);
			}),
		),
	);
}

function createBoulder(blocks: Block[][][], x: number, y: number, z: number) {
	const size = Math.floor(Math.random() * MAX_CUBE_SIZE);

	for (let by = 0; by < size; by++) {
		for (let bz = 0; bz < size; bz++) {
			for (let bx = 0; bx < size; bx++) {
				blocks[y + by][z + bz][x + bx] = new Block(DIRT);
				console.log(y + by, z + bz, x + bx);
			}
		}
	}
}

function buildBlocks() {
	const blocks = create3DArray();

	for (let y = 0; y < CHUNK_SIZE_Y; y++) {
		for (let z = 0; z < CHUNK_SIZE_Z; z++) {
			for (let x = 0; x < CHUNK_SIZE_X; x++) {
				if (
					y === 1 &&
					x > MAX_CUBE_SIZE &&
					x < CHUNK_SIZE_X - MAX_CUBE_SIZE &&
					z > MAX_CUBE_SIZE &&
					z < CHUNK_SIZE_Z - MAX_CUBE_SIZE &&
					Math.random() > 0.999
				) {
					createBoulder(blocks, x, y, z);
				}
			}
		}
	}

	return blocks;
}

export const NUM_BLOCKS = CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z;

export default buildBlocks;
