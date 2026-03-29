import { CHUNK_SIZE } from './chunk';
import cubeSky from './generators/cube-sky';
// import mengerSky from './generators/menger-sky';
// import mengerSponges from './generators/menger';
// import perlinTerrain from './generators/perlin';

export default function buildChunkBlocks(
	cx: number,
	cy: number,
	cz: number,
): Uint8Array {
	const blocks = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);

	// perlinTerrain(cx, cy, cz, blocks);

	cubeSky(blocks);

	// mengerSky(cx, cy, cz, blocks);

	// mengerSponges(cx, cy, cz, blocks);

	return blocks;
}
