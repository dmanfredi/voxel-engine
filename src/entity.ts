/**
 * Entity system — types, lifecycle management, and world integration.
 *
 * Enemies are defined by 5 composable axes:
 *   Shape    → mesh geometry, movement physics, behavior palette
 *   Role     → specific AI strategy from the shape's palette
 *   Material → texture, physical stats (density, speed, hardness)
 *   Size     → stat scaling (passed as `size` at spawn)
 *   Traits   → bolt-on behavioral modifiers (future)
 */

import { mat4 } from 'wgpu-matrix';
import { MARBLE, BRICK, DARK_MARBLE } from './block';
import { createIcosphere } from './icosphere';
import {
	createEntityRenderData,
	updateEntityTransform,
	drawEntities,
	destroyEntityRenderData,
} from './entity-renderer';
import type { EntityRenderer, EntityRenderData } from './entity-renderer';

// ── Axes ────────────────────────────────────────────────────────────

export const Shape = { Sphere: 0, Cube: 1 } as const;
export type Shape = (typeof Shape)[keyof typeof Shape];

export const Role = { Rush: 0, Zone: 1, Crush: 2 } as const;
export type Role = (typeof Role)[keyof typeof Role];

export const Material = { Marble: 0, Brick: 1, DarkMarble: 2 } as const;
export type Material = (typeof Material)[keyof typeof Material];

export type Trait = number;

// ── Material properties ─────────────────────────────────────────────

interface MaterialProperties {
	name: string;
	texLayer: number; // index into block texture array
	textureScale: number; // UV tiling density (matches block registry values)
	density: number; // drives mass = density * size³
	baseSpeed: number; // movement speed multiplier
	hardness: number; // durability multiplier
}

const materials: Record<Material, MaterialProperties> = {
	[Material.Marble]: {
		name: 'marble',
		texLayer: MARBLE,
		textureScale: 1,
		density: 2.7,
		baseSpeed: 1.0,
		hardness: 0.8,
	},
	[Material.Brick]: {
		name: 'brick',
		texLayer: BRICK,
		textureScale: 1,
		density: 1.8,
		baseSpeed: 0.7,
		hardness: 1.0,
	},
	[Material.DarkMarble]: {
		name: 'darkMarble',
		texLayer: DARK_MARBLE,
		textureScale: 1,
		density: 4,
		baseSpeed: 2.0,
		hardness: 1.2,
	},
};

// ── Entity ──────────────────────────────────────────────────────────

interface Entity {
	id: number;
	x: number;
	y: number;
	z: number;
	rotX: number;
	rotY: number;
	rotZ: number;
	scale: number;
	shape: Shape;
	material: Material;
	role: Role;
	traits: Trait[];
	renderData: EntityRenderData;
}

export interface SpawnConfig {
	shape: Shape;
	material: Material;
	role: Role;
	x: number;
	y: number;
	z: number;
	size: number;
	traits?: Trait[];
}

// ── Mesh cache ──────────────────────────────────────────────────────

interface CachedMesh {
	vertices: Float32Array<ArrayBuffer>;
	vertexCount: number;
}

// ── EntityManager ───────────────────────────────────────────────────

export class EntityManager {
	private entities: Entity[] = [];
	private nextId = 0;
	private renderer: EntityRenderer;
	private device: GPUDevice;
	private meshCache = new Map<Shape, CachedMesh>();

	constructor(renderer: EntityRenderer, device: GPUDevice) {
		this.renderer = renderer;
		this.device = device;
	}

	spawn(config: SpawnConfig): number {
		let mesh = this.meshCache.get(config.shape);
		if (!mesh) {
			mesh = this.generateMesh(config.shape);
			this.meshCache.set(config.shape, mesh);
		}

		const mat = materials[config.material];
		const texScale = config.size / (mat.textureScale * 10);
		const renderData = createEntityRenderData(
			this.device,
			this.renderer,
			mesh.vertices,
			mesh.vertexCount,
			mat.texLayer,
			texScale,
		);

		const id = this.nextId++;
		this.entities.push({
			id,
			x: config.x,
			y: config.y,
			z: config.z,
			rotX: 0,
			rotY: 0,
			rotZ: 0,
			scale: config.size,
			shape: config.shape,
			material: config.material,
			role: config.role,
			traits: config.traits ?? [],
			renderData,
		});

		this.uploadTransform(this.entities[this.entities.length - 1]);
		return id;
	}

	/** Per-frame update. Will run AI/behavior per entity. */
	update(dt: number): void {
		for (const entity of this.entities) {
			entity.rotY += dt * 0.2;
			this.uploadTransform(entity);
		}
	}

	draw(pass: GPURenderPassEncoder): void {
		drawEntities(
			pass,
			this.renderer,
			this.entities.map((e) => e.renderData),
		);
	}

	despawn(id: number): void {
		const idx = this.entities.findIndex((e) => e.id === id);
		if (idx === -1) return;
		destroyEntityRenderData(this.entities[idx].renderData);
		this.entities.splice(idx, 1);
	}

	private uploadTransform(entity: Entity): void {
		const model = mat4.translation([entity.x, entity.y, entity.z]);
		mat4.rotateY(model, entity.rotY, model);
		mat4.rotateX(model, entity.rotX, model);
		mat4.rotateZ(model, entity.rotZ, model);
		mat4.scale(model, [entity.scale, entity.scale, entity.scale], model);
		updateEntityTransform(
			this.device.queue,
			entity.renderData,
			model as Float32Array<ArrayBuffer>,
		);
	}

	private generateMesh(shape: Shape): CachedMesh {
		switch (shape) {
			case Shape.Sphere:
				return createIcosphere(3);
			default:
				return createIcosphere(0);
		}
	}
}
