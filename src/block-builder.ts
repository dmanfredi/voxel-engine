import Block, { DIRT, NOTHING } from './Block';

export const CHUNK_SIZE_X = 1024;
export const CHUNK_SIZE_Y = 1;
export const CHUNK_SIZE_Z = 1024;

function create3DArray() {
	return Array.from({ length: CHUNK_SIZE_Y }, (_, y) =>
		Array.from({ length: CHUNK_SIZE_Z }, () =>
			Array.from(
				{ length: CHUNK_SIZE_X },
				() => new Block(y === 0 ? DIRT : NOTHING),
			),
		),
	);
}

function buildBlocks() {
	const blocks = create3DArray();
	return blocks;
}

export const NUM_BLOCKS = CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z;

export default buildBlocks;
