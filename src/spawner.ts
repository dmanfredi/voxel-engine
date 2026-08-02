/**
 * Enemy spawning — the game's pacing layer. Two cooperating halves live here:
 *
 *   Director — decides PACE: how often to attempt a spawn and the active-enemy
 *     cap. Constant for now (see `desiredPressure`), but the inputs that will
 *     drive a dynamic curve — altitude, section — are already in `update`'s
 *     scope, so growing it needs no signature change. Split into its own module
 *     when that curve lands.
 *
 *   Spawner — given "spawn one," finds a uniform solid block cluster near the
 *     player, consumes it to air, and emerges an enemy centered in the cavity.
 *     Enemies are born from terrain and inherit its material.
 *
 * Unlike the terrain generators, the spawner holds a World reference — it
 * queries live terrain for spawn sites. See notes/systems/spawning-and-despawning.md
 * for the full design, the spawn-radius ↔ flow-field coupling, and deferred
 * work (telegraph visuals, dynamic pace, path-aware exposure).
 */

import { AIR, blockRegistry } from './block';
import {
	EntityManager,
	Shape,
	Role,
	Trait,
	materialFromBlockId,
	materialSupportsShape,
} from './entity';
import type { Material } from './entity';
import type { World } from './world';

// ── Tuning ──────────────────────────────────────────────────────────

// Spawn shell around the player, in blocks. The inner wall keeps enemies from
// popping in your lap; the outer wall extends past the flow field's reach on
// purpose (enemies born in the outer ring dumb-pursue until they cross in —
// the high despawn no-path timer absorbs that transit). See the design doc.
const SPAWN_RADIUS_MIN_BLOCKS = 16;
const SPAWN_RADIUS_MAX_BLOCKS = 48;

// Vertical spread of candidate sites, in blocks. Biased by shape: rushers
// emerge below/level (threat rises at you), crushers above (drop onto you).
const SPAWN_VERTICAL_SPAN_BLOCKS = 24;

// Constant-pace knobs (the Director's whole tuning surface for now).
const SPAWN_CADENCE_SECONDS = 0.5; // min seconds between spawn attempts
const SPAWN_MAX_ACTIVE = 32; // population cap
// Breachers are an occasional anti-tunneling pressure tool, not the default cube.
const BREACHER_CUBE_CHANCE = 0.1;

// Candidate sites sampled per attempt before giving up for this cadence.
// Barren terrain yielding nothing is a feature — sparse worlds stay calm.
const SPAWN_ATTEMPTS_PER_TICK = 16;

// ── Spawn table ─────────────────────────────────────────────────────
//
// What can spawn. Material is intentionally absent — it's inherited from the
// consumed terrain. Cube sizes must yield a whole-voxel edge (2·size a
// multiple of blockSize) or EntityManager.spawn throws.

interface SpawnEntry {
	shape: Shape;
	role: Role;
	size: number;
}

const SPAWN_TABLE: SpawnEntry[] = [
	{ shape: Shape.Sphere, role: Role.Rush, size: 5 },
	{ shape: Shape.Sphere, role: Role.Rush, size: 5 },
	{ shape: Shape.Sphere, role: Role.Rush, size: 9 },
	{ shape: Shape.Sphere, role: Role.Rush, size: 19 },
	{ shape: Shape.Cube, role: Role.Crush, size: 10 },
	{ shape: Shape.Cube, role: Role.Crush, size: 5 },
	{ shape: Shape.Cube, role: Role.Crush, size: 5 },
];

// ── Types ───────────────────────────────────────────────────────────

type RegionChangedFn = (
	minBX: number,
	minBY: number,
	minBZ: number,
	maxBX: number,
	maxBY: number,
	maxBZ: number,
) => void;

interface Site {
	bx0: number; // cluster min-corner, block coords
	by0: number;
	bz0: number;
	n: number; // cluster edge, blocks
	material: Material;
	centerX: number; // consumed-volume center, world coords
	centerY: number;
	centerZ: number;
}

// ── Spawner ─────────────────────────────────────────────────────────

export class Spawner {
	private world: World;
	private entityManager: EntityManager;
	private onRegionChanged: RegionChangedFn;
	private sinceLastAttempt = 0;

	constructor(
		world: World,
		entityManager: EntityManager,
		onRegionChanged: RegionChangedFn,
	) {
		this.world = world;
		this.entityManager = entityManager;
		this.onRegionChanged = onRegionChanged;
	}

	update(dt: number, playerPos: Float32Array): void {
		const { cadence, maxActive } = this.desiredPressure();
		this.sinceLastAttempt += dt;
		if (this.sinceLastAttempt < cadence) return;
		this.sinceLastAttempt = 0;
		if (this.entityManager.activeCount >= maxActive) return;
		this.trySpawn(playerPos);
	}

	/**
	 * Director stub — constant pressure. Later reads altitude (playerPos.y) and
	 * the active section to scale pace; both are reachable from `update` without
	 * a signature change. See the Director note up top.
	 */
	private desiredPressure(): { cadence: number; maxActive: number } {
		return { cadence: SPAWN_CADENCE_SECONDS, maxActive: SPAWN_MAX_ACTIVE };
	}

	private trySpawn(playerPos: Float32Array): void {
		const entry =
			SPAWN_TABLE[Math.floor(Math.random() * SPAWN_TABLE.length)];
		const site = this.findSite(playerPos, entry);
		if (!site) return; // no valid cluster this attempt — terrain-driven calm
		this.emerge(site, entry);
	}

	/**
	 * Sample candidate clusters in the spawn shell until one is valid: all
	 * cells solid + same material, that material hosts the shape, and the
	 * cluster touches air on at least one face (so the enemy isn't entombed).
	 * Returns the first hit, or null after the attempt budget.
	 */
	private findSite(playerPos: Float32Array, entry: SpawnEntry): Site | null {
		const blockSize = this.world.blockSize;
		const n = Math.max(1, Math.ceil((2 * entry.size) / blockSize));
		const playerBX = Math.floor((playerPos[0] ?? 0) / blockSize);
		const playerBY = Math.floor((playerPos[1] ?? 0) / blockSize);
		const playerBZ = Math.floor((playerPos[2] ?? 0) / blockSize);

		for (let attempt = 0; attempt < SPAWN_ATTEMPTS_PER_TICK; attempt++) {
			const angle = Math.random() * Math.PI * 2;
			const radius =
				SPAWN_RADIUS_MIN_BLOCKS +
				Math.random() *
					(SPAWN_RADIUS_MAX_BLOCKS - SPAWN_RADIUS_MIN_BLOCKS);
			const bx0 = playerBX + Math.round(Math.cos(angle) * radius);
			const bz0 = playerBZ + Math.round(Math.sin(angle) * radius);
			const by0 = playerBY + verticalOffset(entry.shape);

			const material = this.clusterMaterial(
				bx0,
				by0,
				bz0,
				n,
				entry.shape,
			);
			if (material === null) continue;
			if (!this.isExposed(bx0, by0, bz0, n)) continue;

			return {
				bx0,
				by0,
				bz0,
				n,
				material,
				centerX: (bx0 + n / 2) * blockSize,
				centerY: (by0 + n / 2) * blockSize,
				centerZ: (bz0 + n / 2) * blockSize,
			};
		}
		return null;
	}

	/**
	 * Material of the N³ cluster at `(bx0, by0, bz0)` if every cell is solid,
	 * shares one block id, and that block maps to a material hosting `shape`;
	 * else null. The uniform-id test (`!== firstId`) rejects air and mixed
	 * clusters in one comparison. Unloaded chunks read as AIR, so off-terrain
	 * sites are rejected for free.
	 */
	private clusterMaterial(
		bx0: number,
		by0: number,
		bz0: number,
		n: number,
		shape: Shape,
	): Material | null {
		const firstId = this.world.getBlock(bx0, by0, bz0);
		if (!blockRegistry.isSolid(firstId)) return null;
		const material = materialFromBlockId(firstId);
		if (material === null) return null;
		if (!materialSupportsShape(material, shape)) return null;

		for (let ix = 0; ix < n; ix++) {
			for (let iy = 0; iy < n; iy++) {
				for (let iz = 0; iz < n; iz++) {
					if (
						this.world.getBlock(bx0 + ix, by0 + iy, bz0 + iz) !==
						firstId
					) {
						return null;
					}
				}
			}
		}
		return material;
	}

	/** True if any of the cluster's 6 outer faces touches a non-solid cell. */
	private isExposed(
		bx0: number,
		by0: number,
		bz0: number,
		n: number,
	): boolean {
		for (let a = 0; a < n; a++) {
			for (let b = 0; b < n; b++) {
				if (!this.world.isSolid(bx0 - 1, by0 + a, bz0 + b)) return true;
				if (!this.world.isSolid(bx0 + n, by0 + a, bz0 + b)) return true;
				if (!this.world.isSolid(bx0 + a, by0 - 1, bz0 + b)) return true;
				if (!this.world.isSolid(bx0 + a, by0 + n, bz0 + b)) return true;
				if (!this.world.isSolid(bx0 + a, by0 + b, bz0 - 1)) return true;
				if (!this.world.isSolid(bx0 + a, by0 + b, bz0 + n)) return true;
			}
		}
		return false;
	}

	/**
	 * Consume the cluster to air and emerge an enemy centered in the cavity.
	 * One region-remesh + one flow-field invalidation cover the whole cluster.
	 *
	 * Telegraph (claim-at-start / consume-at-hatch + glow visual) is deferred —
	 * it currently consumes and emerges in the same frame. Seam: insert a
	 * claimed-site timer here, hatching on expiry. No gameplay depends on it
	 * (no counterplay).
	 */
	private emerge(site: Site, entry: SpawnEntry): void {
		const { bx0, by0, bz0, n, material } = site;
		for (let ix = 0; ix < n; ix++) {
			for (let iy = 0; iy < n; iy++) {
				for (let iz = 0; iz < n; iz++) {
					this.world.setBlock(bx0 + ix, by0 + iy, bz0 + iz, AIR);
				}
			}
		}
		this.onRegionChanged(
			bx0,
			by0,
			bz0,
			bx0 + n - 1,
			by0 + n - 1,
			bz0 + n - 1,
		);
		this.entityManager.invalidateFlowField();

		const traits =
			entry.shape === Shape.Cube && Math.random() < BREACHER_CUBE_CHANCE
				? [Trait.Breacher]
				: [];

		this.entityManager.spawn({
			shape: entry.shape,
			role: entry.role,
			traits,
			material,
			size: entry.size,
			x: site.centerX,
			y: site.centerY,
			z: site.centerZ,
		});
	}
}

/**
 * Vertical candidate offset (blocks) keyed to shape. Rushers skew below/level
 * so the threat climbs toward you; crushers skew above so they drop onto you.
 */
function verticalOffset(shape: Shape): number {
	if (shape === Shape.Cube) {
		return Math.round(Math.random() * SPAWN_VERTICAL_SPAN_BLOCKS);
	}
	// Spheres: mostly below, a little above level.
	return Math.round((Math.random() - 0.8) * SPAWN_VERTICAL_SPAN_BLOCKS);
}
