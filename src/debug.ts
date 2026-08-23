import Stats from 'stats.js';
import { Pane } from 'tweakpane';
import { Shape, Material, Trait } from './entity';

export const stats = new Stats();
stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
document.body.appendChild(stats.dom);

export const debuggerParams = {
	wireframe: false,
	freecam: false,
	vertices: 0,
	targetBlock: 'none',
	playerPos: '0, 0, 0',
	// Additive boost on top of per-material values from BlockRegistry
	shininess: 0,
	specularStrength: 0,
	fogStart: 1300,
	fogEnd: 1400,
	// Void floor readouts
	voidBand: 'safe',
	voidHits: 0,
	voidGap: '0', // blocks from player feet to the void surface (+ = above)
	// Enemy readouts / toggles (the Enemies pane)
	enemyCount: 0,
	growthCount: 0,
	enemyXray: false, // paint enemies over terrain (see-through debug view)
	spawnerEnabled: false, // automatic terrain-born spawner (manual spawn still works)
};

/** Hooks the enemy pane calls back into — implemented in main.ts. */
export interface DebugHooks {
	/** Spawn an enemy on the first surface under the camera crosshair. */
	onSpawnEnemy: (
		shape: Shape,
		material: Material,
		size: number,
		traits: readonly Trait[],
	) => void;
}

let pane: Pane | null = null;
let enemyPane: Pane | null = null;

export function refreshDebug(): void {
	pane?.refresh();
	enemyPane?.refresh();
}

export function BuildDebug(render: () => void, hooks: DebugHooks): void {
	// Shared container so the two debug panes stack vertically. Without it,
	// each Pane floats at the same top-right anchor and they overlap.
	const paneContainer = document.createElement('div');
	paneContainer.style.cssText =
		'position: fixed; top: 8px; right: 8px; width: 256px; display: flex; flex-direction: column; gap: 8px; z-index: 100;';
	document.body.appendChild(paneContainer);

	pane = new Pane({ title: 'General', container: paneContainer });
	const wireframeBinding = pane.addBinding(debuggerParams, 'wireframe', {
		label: 'Wireframe',
	});
	pane.addBinding(debuggerParams, 'freecam', {
		label: 'Freecam (f)',
	});
	pane.addBinding(debuggerParams, 'vertices', {
		readonly: true,
		label: 'Vertices',
		format: (v) => v.toFixed(0),
	});
	pane.addBinding(debuggerParams, 'targetBlock', {
		readonly: true,
		label: 'Target',
	});
	pane.addBinding(debuggerParams, 'playerPos', {
		readonly: true,
		label: 'Location',
	});

	wireframeBinding.on('change', () => {
		requestAnimationFrame(() => {
			render();
		});
	});

	const reflFolder = pane.addFolder({ title: 'Specular' });
	reflFolder.addBinding(debuggerParams, 'shininess', {
		label: 'Shininess',
		min: -100,
		max: 100,
		step: 1,
	});
	reflFolder.addBinding(debuggerParams, 'specularStrength', {
		label: 'Spec Strength',
		min: -1,
		max: 1,
		step: 0.05,
	});

	const hideStyle = document.createElement('style');
	hideStyle.textContent =
		'body.hide-ui > :not(canvas) { display: none !important; }';
	document.head.appendChild(hideStyle);

	const toggleUI = () => {
		document.body.classList.toggle('hide-ui');
	};
	window.addEventListener('keydown', (e) => {
		if (e.code === 'F1') {
			e.preventDefault();
			toggleUI();
		}
	});

	const fogFolder = pane.addFolder({ title: 'Fog' });
	fogFolder.addBinding(debuggerParams, 'fogStart', {
		label: 'Fog Start',
		min: 0,
		max: 2000,
		step: 10,
	});
	fogFolder.addBinding(debuggerParams, 'fogEnd', {
		label: 'Fog End',
		min: 0,
		max: 2000,
		step: 10,
	});

	const voidFolder = pane.addFolder({ title: 'Void' });
	voidFolder.addBinding(debuggerParams, 'voidBand', {
		readonly: true,
		label: 'Band',
	});
	voidFolder.addBinding(debuggerParams, 'voidGap', {
		readonly: true,
		label: 'Gap (blocks)',
	});
	voidFolder.addBinding(debuggerParams, 'voidHits', {
		readonly: true,
		label: 'Cracks',
		format: (v) => v.toFixed(0),
	});

	// Standalone pane for enemy debugging — count, x-ray, and a raycast spawner.
	enemyPane = new Pane({ title: 'Enemies', container: paneContainer });
	enemyPane.addBinding(debuggerParams, 'enemyCount', {
		readonly: true,
		label: 'Count',
		format: (v) => v.toFixed(0),
	});
	enemyPane.addBinding(debuggerParams, 'growthCount', {
		readonly: true,
		label: 'Growths',
		format: (v) => v.toFixed(0),
	});
	enemyPane.addBinding(debuggerParams, 'spawnerEnabled', {
		label: 'Enemy Spawning',
	});
	enemyPane.addBinding(debuggerParams, 'enemyXray', { label: 'X-Ray' });
	// Spawn controls — selections live here; the button raycasts + spawns.
	const spawnParams: {
		shape: Shape;
		material: Material;
		size: number;
	} = {
		shape: Shape.Sphere,
		material: Material.Marble,
		size: 10,
	};
	const spawnFolder = enemyPane.addFolder({ title: 'Spawn' });
	spawnFolder.addBinding(spawnParams, 'shape', {
		label: 'Type',
		options: { Sphere: Shape.Sphere, Cube: Shape.Cube },
	});
	spawnFolder.addBinding(spawnParams, 'material', {
		label: 'Material',
		options: {
			Marble: Material.Marble,
			Brick: Material.Brick,
			'Dark Marble': Material.DarkMarble,
		},
	});
	// Stepping size by blockSize/2 keeps cube edges whole-voxel (2·size a
	// multiple of blockSize), so cube spawns never trip EntityManager.spawn's
	// alignment check.
	spawnFolder.addBinding(spawnParams, 'size', {
		label: 'Size',
		min: 5,
		max: 30,
		step: 5,
	});
	const traitToggles: { label: string; trait: Trait; selected: boolean }[] = [
		{ label: 'Breacher', trait: Trait.Breacher, selected: false },
	];
	const traitsFolder = spawnFolder.addFolder({
		title: 'Traits',
		expanded: true,
	});
	for (const toggle of traitToggles) {
		traitsFolder.addBinding(toggle, 'selected', { label: toggle.label });
	}
	spawnFolder.addButton({ title: 'Spawn at crosshair' }).on('click', () => {
		const traits = traitToggles
			.filter((toggle) => toggle.selected)
			.map((toggle) => toggle.trait);

		hooks.onSpawnEnemy(
			spawnParams.shape,
			spawnParams.material,
			spawnParams.size,
			traits,
		);
	});
}

// class Debugger {
// 	constructor() {
// 		bar: 1;
// 	}

// 	foo = (): number => {
// 		return this.bar;
// 	};
// }
