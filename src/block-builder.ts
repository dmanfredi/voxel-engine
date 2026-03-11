import { AIR, MARBLE } from './block';
import { CHUNK_SIZE } from './chunk';
import Noise from 'noisejs';

const noise = new (Noise as unknown as { Noise: typeof Noise }).Noise(
	Math.random(),
);

const NOISE_FREQUENCY = 0.02;

export default function buildChunkBlocks(
	cx: number,
	cy: number,
	cz: number,
): Uint8Array {
	const blocks = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);

	for (let y = 0; y < CHUNK_SIZE; y++) {
		for (let z = 0; z < CHUNK_SIZE; z++) {
			for (let x = 0; x < CHUNK_SIZE; x++) {
				const wx = cx * CHUNK_SIZE + x;
				const wy = cy * CHUNK_SIZE + y;
				const wz = cz * CHUNK_SIZE + z;
				const value = noise.perlin3(
					wx * NOISE_FREQUENCY,
					wy * NOISE_FREQUENCY,
					wz * NOISE_FREQUENCY,
				);
				const index = y * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + x;
				blocks[index] = value > 0 ? MARBLE : AIR;
			}
		}
	}

	return blocks;
}
