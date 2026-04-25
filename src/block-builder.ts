import { CHUNK_SIZE } from './chunk';
// import cubeSky from './generators/cube-sky';
// import mengerSky from './generators/menger-sky';
// import mengerSponges from './generators/menger';
// import perlinTerrain from './generators/perlin';
import cubeFieldPlain from './generators/planar';
// import cubePlaza from './generators/cube-plaza';

export default function buildChunkBlocks(
	cx: number,
	cy: number,
	cz: number,
): Uint8Array {
	const blocks = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);

	// perlinTerrain(cx, cy, cz, blocks);

	// cubeSky(blocks);

	cubeFieldPlain(cx, cy, cz, blocks);

	// cubePlaza(cx, cy, cz, blocks);

	// mengerSponges(cx, cy, cz, blocks);

	//mengerSky(cx, cy, cz, blocks);

	return blocks;
}
