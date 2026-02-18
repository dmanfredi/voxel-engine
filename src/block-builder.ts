import Block, { DIRT, NOTHING } from './Block';
import Noise from 'noisejs';

export const CHUNK_SIZE_X = 128;
export const CHUNK_SIZE_Y = 64;
export const CHUNK_SIZE_Z = 128;
const noise = new (Noise as unknown as { Noise: typeof Noise }).Noise(
	Math.random(),
);

const NOISE_FREQUENCY = 0.081;

function create3DArray() {
	return Array.from({ length: CHUNK_SIZE_Y }, (_, y) =>
		Array.from({ length: CHUNK_SIZE_Z }, (_, z) =>
			Array.from({ length: CHUNK_SIZE_X }, (_, x) => {
				const value = noise.perlin3(
					x * NOISE_FREQUENCY,
					y * NOISE_FREQUENCY,
					z * NOISE_FREQUENCY,
				);
				// return new Block(DIRT);
				return new Block(value > 0 ? DIRT : NOTHING);
			}),
		),
	);
}

function buildBlocks() {
	const blocks = create3DArray();
	return blocks;
}

export const NUM_BLOCKS = CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z;

export default buildBlocks;
