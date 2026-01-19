import Block, { DIRT, NOTHING } from './Block';
import Noise from 'noisejs';

const layers = 16;
const rows = 16;
const columns = 16;
const noise = new (Noise as unknown as { Noise: typeof Noise }).Noise(
	Math.random(),
);

const NOISE_FREQUENCY = 0.1;

function create3DArray(layers: number, rows: number, cols: number) {
	return Array.from({ length: layers }, (_, y) =>
		Array.from({ length: rows }, (_, z) =>
			Array.from({ length: cols }, (_, x) => {
				const value = noise.perlin3(
					x * NOISE_FREQUENCY,
					y * NOISE_FREQUENCY,
					z * NOISE_FREQUENCY,
				);
				console.log(value);
				return new Block(value > 0 ? DIRT : NOTHING);
			}),
		),
	);
}

function buildBlocks() {
	const blocks = create3DArray(layers, rows, columns);
	return blocks;
}

export const NUM_BLOCKS = layers * rows * columns;

export default buildBlocks;
