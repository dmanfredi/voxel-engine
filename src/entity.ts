/**
 * Entity system — types, lifecycle management, and world integration.
 *
 * Entities are game objects that aren't part of the voxel grid: enemies,
 * projectiles, etc. Each entity has a position/rotation/scale in world space
 * and GPU resources for rendering.
 */

import { mat4 } from 'wgpu-matrix';
import { MARBLE } from './block';
import { createIcosphere } from './icosphere';
import {
	createEntityRenderData,
	updateEntityTransform,
	drawEntities,
	destroyEntityRenderData,
} from './entity-renderer';
import type { EntityRenderer, EntityRenderData } from './entity-renderer';

export const EntityType = {
	Sphere: 0,
} as const;
export type EntityType = (typeof EntityType)[keyof typeof EntityType];

interface Entity {
	id: number;
	x: number;
	y: number;
	z: number;
	rotX: number;
	rotY: number;
	rotZ: number;
	scale: number;
	entityType: EntityType;
	renderData: EntityRenderData;
}

// Cached mesh data per entity type (CPU-side, used to create GPU buffers)
interface CachedMesh {
	vertices: Float32Array<ArrayBuffer>;
	vertexCount: number;
}

export class EntityManager {
	private entities: Entity[] = [];
	private nextId = 0;
	private renderer: EntityRenderer;
	private device: GPUDevice;
	private meshCache = new Map<EntityType, CachedMesh>();

	constructor(renderer: EntityRenderer, device: GPUDevice) {
		this.renderer = renderer;
		this.device = device;
	}

	spawn(
		type: EntityType,
		x: number,
		y: number,
		z: number,
		scale: number,
	): number {
		let mesh = this.meshCache.get(type);
		if (!mesh) {
			mesh = this.generateMesh(type);
			this.meshCache.set(type, mesh);
		}

		const texLayer = this.getTexLayer(type);
		const renderData = createEntityRenderData(
			this.device,
			this.renderer,
			mesh.vertices,
			mesh.vertexCount,
			texLayer,
		);

		const id = this.nextId++;
		this.entities.push({
			id,
			x,
			y,
			z,
			rotX: 0,
			rotY: 0,
			rotZ: 0,
			scale,
			entityType: type,
			renderData,
		});

		// Upload initial transform
		this.uploadTransform(this.entities[this.entities.length - 1]);

		return id;
	}

	/** Per-frame update. Will run AI/physics per entity. */
	update(dt: number): void {
		for (const entity of this.entities) {
			// Future: run entity AI/behavior here using dt
			entity.rotY += dt * 0.5;
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

	private generateMesh(type: EntityType): CachedMesh {
		switch (type) {
			case EntityType.Sphere:
				return createIcosphere(3);
			default:
				return createIcosphere(0);
		}
	}

	private getTexLayer(type: EntityType): number {
		switch (type) {
			case EntityType.Sphere:
				return MARBLE;
			default:
				return MARBLE;
		}
	}
}
