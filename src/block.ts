export type BlockId = number;

export const AIR: BlockId = 0;
export const MARBLE: BlockId = 1;
export const BRICK: BlockId = 2;
export const DARK_MARBLE: BlockId = 3;

export interface BlockProperties {
	name: string;
	solid: boolean;
	textureScale: number;
	restitution: number;
}

export class BlockRegistry {
	private blocks: (BlockProperties | undefined)[] = [];

	register(id: BlockId, properties: BlockProperties): void {
		this.blocks[id] = properties;
	}

	get(id: BlockId): BlockProperties | undefined {
		return this.blocks[id];
	}

	isSolid(id: BlockId): boolean {
		return this.blocks[id]?.solid ?? false;
	}

	get count(): number {
		return this.blocks.length;
	}
}

/** Flat arrays of block properties for use in the mesher (and workers). */
export interface BlockProps {
	isSolid: boolean[];
	textureScale: number[];
}

/** Extract block properties into flat arrays suitable for transfer to a worker. */
export function extractBlockProps(): BlockProps {
	const isSolid: boolean[] = [];
	const textureScale: number[] = [];
	for (let id = 0; id < blockRegistry.count; id++) {
		const props = blockRegistry.get(id);
		isSolid[id] = props?.solid ?? false;
		textureScale[id] = props?.textureScale ?? 1;
	}
	return { isSolid, textureScale };
}

export const blockRegistry = new BlockRegistry();
blockRegistry.register(AIR, {
	name: 'air',
	solid: false,
	textureScale: 1,
	restitution: 0,
});
blockRegistry.register(MARBLE, {
	name: 'marble',
	solid: true,
	textureScale: 6,
	restitution: 0.4,
});
blockRegistry.register(BRICK, {
	name: 'brick',
	solid: true,
	textureScale: 3,
	restitution: 0.2,
});
blockRegistry.register(DARK_MARBLE, {
	name: 'darkMarble',
	solid: true,
	textureScale: 6,
	restitution: 0.4,
});
