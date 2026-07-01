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
	/** Phong exponent for this material (higher = tighter highlight). */
	shininess: number;
	/** Specular highlight intensity multiplier. */
	specularStrength: number;
	/**
	 * Mining resistance. Projectiles subtract this from their strength on
	 * each break; the first block a projectile hits always breaks (even if
	 * strength < hardness), but subsequent blocks require strength > hardness.
	 * AIR is 0 — projectiles skip air entirely, no break attempt.
	 */
	hardness: number;
}

export class BlockRegistry {
	private blocks: (BlockProperties | undefined)[] = [];
	private readonly solidById = new Uint8Array(256);

	register(id: BlockId, properties: BlockProperties): void {
		this.blocks[id] = properties;
		this.solidById[id] = properties.solid ? 1 : 0;
	}

	get(id: BlockId): BlockProperties | undefined {
		return this.blocks[id];
	}

	isSolid(id: BlockId): boolean {
		return this.solidById[id] === 1;
	}

	get count(): number {
		return this.blocks.length;
	}

	get solidFlags(): Uint8Array {
		return this.solidById;
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
	shininess: 0,
	specularStrength: 0,
	hardness: 0,
});
blockRegistry.register(MARBLE, {
	name: 'marble',
	solid: true,
	textureScale: 6,
	restitution: 0.4,
	shininess: 8,
	specularStrength: 0.17,
	hardness: 1,
});
blockRegistry.register(BRICK, {
	name: 'brick',
	solid: true,
	textureScale: 3,
	restitution: 0.2,
	shininess: 20,
	specularStrength: 0.105,
	hardness: 4,
});
blockRegistry.register(DARK_MARBLE, {
	name: 'darkMarble',
	solid: true,
	textureScale: 6,
	restitution: 0.4,
	shininess: 5,
	specularStrength: 0.5,
	hardness: 10,
});
