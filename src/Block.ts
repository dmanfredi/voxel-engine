type BlockType = string;
export const NOTHING: BlockType = 'NOTHING';
export const DIRT: BlockType = 'DIRT';

class Block {
	type: string;
	constructor(type: BlockType) {
		this.type = type;
	}
}

export default Block;
