import { CHUNK_SIZE } from '../chunk';
import { MARBLE } from '../block';

const PLANE_Y = 150;
const CUBE_SIZE = 30;
const WORLD_WIDTH_BLOCKS = 10 * CHUNK_SIZE;
const WORLD_CENTER = WORLD_WIDTH_BLOCKS / 2;
const EXTRA_CUBE_COUNT = 12;
const MIN_SPACING = CUBE_SIZE + 4;

interface Cube {
	x: number;
	z: number;
}

function makeCubes(): Cube[] {
	const cubes: Cube[] = [
		{ x: WORLD_CENTER - CUBE_SIZE / 2, z: WORLD_CENTER - CUBE_SIZE / 2 },
	];

	let attempts = 0;
	while (cubes.length < EXTRA_CUBE_COUNT + 1 && attempts < 500) {
		attempts++;
		const x = Math.floor(Math.random() * (WORLD_WIDTH_BLOCKS - CUBE_SIZE));
		const z = Math.floor(Math.random() * (WORLD_WIDTH_BLOCKS - CUBE_SIZE));
		const overlaps = cubes.some(
			(c) =>
				Math.abs(c.x - x) < MIN_SPACING &&
				Math.abs(c.z - z) < MIN_SPACING,
		);
		if (!overlaps) cubes.push({ x, z });
	}
	return cubes;
}

const CUBES = makeCubes();

function fillCube(
	blocks: Uint8Array<ArrayBuffer>,
	cx: number,
	cy: number,
	cz: number,
	cube: Cube,
) {
	const chunkWorldX = cx * CHUNK_SIZE;
	const chunkWorldY = cy * CHUNK_SIZE;
	const chunkWorldZ = cz * CHUNK_SIZE;

	const cubeY0 = PLANE_Y - CUBE_SIZE + 1;
	const cubeY1 = PLANE_Y;
	const cubeX0 = cube.x;
	const cubeX1 = cube.x + CUBE_SIZE - 1;
	const cubeZ0 = cube.z;
	const cubeZ1 = cube.z + CUBE_SIZE - 1;

	const x0 = Math.max(cubeX0, chunkWorldX);
	const x1 = Math.min(cubeX1, chunkWorldX + CHUNK_SIZE - 1);
	const y0 = Math.max(cubeY0, chunkWorldY);
	const y1 = Math.min(cubeY1, chunkWorldY + CHUNK_SIZE - 1);
	const z0 = Math.max(cubeZ0, chunkWorldZ);
	const z1 = Math.min(cubeZ1, chunkWorldZ + CHUNK_SIZE - 1);

	if (x0 > x1 || y0 > y1 || z0 > z1) return;

	for (let wy = y0; wy <= y1; wy++) {
		const ly = wy - chunkWorldY;
		for (let wz = z0; wz <= z1; wz++) {
			const lz = wz - chunkWorldZ;
			for (let wx = x0; wx <= x1; wx++) {
				const lx = wx - chunkWorldX;
				blocks[ly * CHUNK_SIZE * CHUNK_SIZE + lz * CHUNK_SIZE + lx] =
					MARBLE;
			}
		}
	}
}

function cubePlaza(
	cx: number,
	cy: number,
	cz: number,
	blocks: Uint8Array<ArrayBuffer>,
) {
	for (const cube of CUBES) {
		fillCube(blocks, cx, cy, cz, cube);
	}
}

export default cubePlaza;
