import Block from './Block';

const layers = 16;
const rows = 16;
const columns = 16;

function create3DArray(
	layers: number,
	rows: number,
	cols: number,
	initialValue: Block
) {
	return Array.from({ length: layers }, () =>
		Array.from({ length: rows }, () =>
			Array<Block>(cols).fill(initialValue)
		)
	);
}
function buildBlocks() {
	const blocks = create3DArray(layers, rows, columns, new Block());
	return blocks;
}

export default buildBlocks;
