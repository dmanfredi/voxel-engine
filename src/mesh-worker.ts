import { expose, transfer } from 'comlink';
import { greedyMesh, type GreedyMeshResult } from './greedy-mesh';
import type { BlockProps } from './block';

let blockProps: BlockProps;

const api = {
	init(props: BlockProps): void {
		blockProps = props;
	},

	mesh(
		paddedBlocks: Uint8Array,
		cx: number,
		cy: number,
		cz: number,
		blockSize: number,
	): GreedyMeshResult {
		const result = greedyMesh(
			paddedBlocks,
			cx,
			cy,
			cz,
			blockSize,
			blockProps,
		);
		return transfer(result, [result.vertexData.buffer]);
	},
};

export type MeshWorkerApi = typeof api;

expose(api);
