import { CHUNK_SIZE } from '../chunk';
import { MARBLE } from '../block';
const MAX_CUBE_SIZE = 8;

export const CHUNK_SIZE_X = 2048;
export const CHUNK_SIZE_Y = MAX_CUBE_SIZE;
export const CHUNK_SIZE_Z = 2048;

function createBoulder(
	blocks: Uint8Array<ArrayBuffer>,
	x: number,
	y: number,
	z: number,
) {
	const size = Math.floor(Math.random() * MAX_CUBE_SIZE);

	for (let by = 0; by < size; by++) {
		for (let bz = 0; bz < size; bz++) {
			for (let bx = 0; bx < size; bx++) {
				const index =
					(y + by) * CHUNK_SIZE * CHUNK_SIZE +
					(z + bz) * CHUNK_SIZE +
					(x + bx);

				blocks[index] = MARBLE;
			}
		}
	}
}

function cubeField(blocks: Uint8Array<ArrayBuffer>) {
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
}

export default cubeField;
