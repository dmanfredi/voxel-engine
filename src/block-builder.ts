import { AIR, MARBLE } from './block';
import Noise from 'noisejs';

export const CHUNK_SIZE_X = 128;
export const CHUNK_SIZE_Y = 128;
export const CHUNK_SIZE_Z = 128;
const noise = new (Noise as unknown as { Noise: typeof Noise }).Noise(
	Math.random(),
);

const NOISE_FREQUENCY = 0.051;

function buildBlocks(): Uint8Array {
	const blocks = new Uint8Array(CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z);

	for (let y = 0; y < CHUNK_SIZE_Y; y++) {
		for (let z = 0; z < CHUNK_SIZE_Z; z++) {
			for (let x = 0; x < CHUNK_SIZE_X; x++) {
				const value = noise.perlin3(
					x * NOISE_FREQUENCY,
					y * NOISE_FREQUENCY,
					z * NOISE_FREQUENCY,
				);
				const index =
					y * CHUNK_SIZE_Z * CHUNK_SIZE_X + z * CHUNK_SIZE_X + x;
				blocks[index] = value > 0 ? MARBLE : AIR;
			}
		}
	}

	return blocks;
}

export const NUM_BLOCKS = CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z;

export default buildBlocks;
