import { CHUNK_SIZE } from '../chunk';
import { MARBLE } from '../block';

const LEVELS = [3, 9, 27] as const;
const GRID_SPACING = 48;
const SPAWN_CHANCE = 2;
const MAX_SPONGE_SIZE = 27;

function seededRng(gx: number, gy: number, gz: number): () => number {
	let seed = Math.sin(gx * 12.9898 + gy * 78.233 + gz * 45.164) * 43758.5453;
	return () => {
		seed = Math.sin(seed * 43758.5453 + 0.1) * 43758.5453;
		return seed - Math.floor(seed);
	};
}

function isMenger(x: number, y: number, z: number, level: number): boolean {
	for (let i = 0; i < level; i++) {
		const cx = x % 3;
		const cy = y % 3;
		const cz = z % 3;
		if ((cx === 1 ? 1 : 0) + (cy === 1 ? 1 : 0) + (cz === 1 ? 1 : 0) >= 2) {
			return false;
		}
		x = Math.floor(x / 3);
		y = Math.floor(y / 3);
		z = Math.floor(z / 3);
	}
	return true;
}

export default function mengerSky(
	cx: number,
	cy: number,
	cz: number,
	blocks: Uint8Array<ArrayBuffer>,
): void {
	const chunkWorldX = cx * CHUNK_SIZE;
	const chunkWorldY = cy * CHUNK_SIZE;
	const chunkWorldZ = cz * CHUNK_SIZE;

	// Find all grid cells whose sponges could overlap this chunk
	const gxMin = Math.floor((chunkWorldX - MAX_SPONGE_SIZE) / GRID_SPACING);
	const gxMax = Math.floor((chunkWorldX + CHUNK_SIZE) / GRID_SPACING);
	const gyMin = Math.floor((chunkWorldY - MAX_SPONGE_SIZE) / GRID_SPACING);
	const gyMax = Math.floor((chunkWorldY + CHUNK_SIZE) / GRID_SPACING);
	const gzMin = Math.floor((chunkWorldZ - MAX_SPONGE_SIZE) / GRID_SPACING);
	const gzMax = Math.floor((chunkWorldZ + CHUNK_SIZE) / GRID_SPACING);

	for (let gy = gyMin; gy <= gyMax; gy++) {
		for (let gz = gzMin; gz <= gzMax; gz++) {
			for (let gx = gxMin; gx <= gxMax; gx++) {
				const rng = seededRng(gx, gy, gz);

				if (rng() > SPAWN_CHANCE) continue;

				// Weight toward smaller sponges: level 1 = 9/13, level 2 = 3/13, level 3 = 1/13
				const roll = rng() * 13;
				const level = roll < 9 ? 1 : roll < 12 ? 2 : 3;
				const size = LEVELS[level - 1];
				if (size === undefined) continue;

				// Sponge origin in world space, offset within its grid cell
				const sox =
					gx * GRID_SPACING +
					Math.floor(rng() * (GRID_SPACING - size));
				const soy =
					gy * GRID_SPACING +
					Math.floor(rng() * (GRID_SPACING - size));
				const soz =
					gz * GRID_SPACING +
					Math.floor(rng() * (GRID_SPACING - size));

				// Skip if sponge AABB doesn't intersect this chunk
				if (
					sox + size <= chunkWorldX ||
					sox >= chunkWorldX + CHUNK_SIZE
				)
					continue;
				if (
					soy + size <= chunkWorldY ||
					soy >= chunkWorldY + CHUNK_SIZE
				)
					continue;
				if (
					soz + size <= chunkWorldZ ||
					soz >= chunkWorldZ + CHUNK_SIZE
				)
					continue;

				// Only iterate the overlap region
				const xStart = Math.max(0, sox - chunkWorldX);
				const xEnd = Math.min(CHUNK_SIZE, sox + size - chunkWorldX);
				const yStart = Math.max(0, soy - chunkWorldY);
				const yEnd = Math.min(CHUNK_SIZE, soy + size - chunkWorldY);
				const zStart = Math.max(0, soz - chunkWorldZ);
				const zEnd = Math.min(CHUNK_SIZE, soz + size - chunkWorldZ);

				for (let y = yStart; y < yEnd; y++) {
					for (let z = zStart; z < zEnd; z++) {
						for (let x = xStart; x < xEnd; x++) {
							const lx = chunkWorldX + x - sox;
							const ly = chunkWorldY + y - soy;
							const lz = chunkWorldZ + z - soz;

							if (isMenger(lx, ly, lz, level)) {
								const index =
									y * CHUNK_SIZE * CHUNK_SIZE +
									z * CHUNK_SIZE +
									x;
								blocks[index] = MARBLE;
							}
						}
					}
				}
			}
		}
	}
}
