export type BlockId = number;

export const AIR: BlockId = 0;
export const MARBLE: BlockId = 1;
export const BRICK: BlockId = 2;

export interface BlockProperties {
	name: string;
	solid: boolean;
	textureScale: number;
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
}

export const blockRegistry = new BlockRegistry();
blockRegistry.register(AIR, { name: 'air', solid: false, textureScale: 1 });
blockRegistry.register(MARBLE, {
	name: 'marble',
	solid: true,
	textureScale: 6,
});
blockRegistry.register(BRICK, {
	name: 'brick',
	solid: true,
	textureScale: 3,
});
