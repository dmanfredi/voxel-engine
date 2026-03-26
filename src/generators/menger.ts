import { CHUNK_SIZE } from '../chunk';
import { AIR, MARBLE } from '../block';
const MAX_CUBE_SIZE = 10;

const mengTop: number[][] = [
	[-1, 1, -1],
	[-1, 1, 0],
	[-1, 1, 1],
	// [0, 1, 0],
	[0, 1, -1],
	[0, 1, 1],
	[1, 1, -1],
	[1, 1, 0],
	[1, 1, 1],
];

const mengMiddle: number[][] = [
	[-1, 0, -1],
	// [-1, 0, 0],
	[-1, 0, 1],
	// [0, 1, 0],
	// [0, 0, -1],
	//[0, 0, 1],
	[1, 0, -1],
	//[1, 0, 0],
	[1, 0, 1],
];

const mengBottom: number[][] = [
	[-1, -1, -1],
	[-1, -1, 0],
	[-1, -1, 1],
	// [0, 1, 0],
	[0, -1, -1],
	[0, -1, 1],
	[1, -1, -1],
	[1, -1, 0],
	[1, -1, 1],
];

function isMenger(x: number, y: number, z: number, level: number) {
	for (let i = 0; i < level; i++) {
		// which of the 3x3x3 subcells are we in?

		const cx = x % 3;
		x = Math.floor(x / 3);
		const cy = y % 3;
		y = Math.floor(y / 3);
		const cz = z % 3;
		z = Math.floor(z / 3);
		// center cross = 2+ axes are 1 → removed
		if ((cx === 1 ? 1 : 0) + (cy === 1 ? 1 : 0) + (cz === 1 ? 1 : 0) >= 2) {
			return false;
		}
	}
	return true;
}

function mengerSponges(
	cx: number,
	cy: number,
	cz: number,
	blocks: Uint8Array<ArrayBuffer>,
) {
	// const mid = 1;
	for (let y = 0; y < CHUNK_SIZE; y++) {
		for (let z = 0; z < CHUNK_SIZE; z++) {
			for (let x = 0; x < CHUNK_SIZE; x++) {
				const wx = cx * CHUNK_SIZE + x;
				const wy = cy * CHUNK_SIZE + y;
				const wz = cz * CHUNK_SIZE + z;

				const index = y * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + x;

				blocks[index] = isMenger(wx, wy, wz, 5) ? MARBLE : AIR;
			}
		}
	}
}

export default mengerSponges;
