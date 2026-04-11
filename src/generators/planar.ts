import { CHUNK_SIZE } from '../chunk';
import { MARBLE } from '../block';
const MAX_CUBE_SIZE = 10;

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

function cubeFieldPlain(
	cx: number,
	cy: number,
	cz: number,
	blocks: Uint8Array<ArrayBuffer>,
) {
	// Flat floor plane at world y = 0
	const chunkWorldY = cy * CHUNK_SIZE;
	const localY = -chunkWorldY + 150;
	if (localY >= 0 && localY < CHUNK_SIZE) {
		for (let z = 0; z < CHUNK_SIZE; z++) {
			for (let x = 0; x < CHUNK_SIZE; x++) {
				blocks[localY * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + x] =
					MARBLE;
			}
		}
	}

	for (let y = 0; y < CHUNK_SIZE; y++) {
		for (let z = 0; z < CHUNK_SIZE; z++) {
			for (let x = 0; x < CHUNK_SIZE; x++) {
				if (
					y === 1 &&
					x > MAX_CUBE_SIZE &&
					x < CHUNK_SIZE - MAX_CUBE_SIZE &&
					z > MAX_CUBE_SIZE &&
					z < CHUNK_SIZE - MAX_CUBE_SIZE &&
					Math.random() > 0.997
				) {
					createBoulder(blocks, x, y, z);
				}
			}
		}
	}
}

export default cubeFieldPlain;
