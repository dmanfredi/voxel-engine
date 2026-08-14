import Stats from 'stats.js';
import { Pane } from 'tweakpane';
import type { RenderMode, MSAAMode, TonemapMode } from './render-config';

export const stats = new Stats();
stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
document.body.appendChild(stats.dom);

export const debuggerParams = {
	renderMode: 'Final' as RenderMode,
	msaa: '4x' as MSAAMode,
	wireframe: false,
	freecam: false,
	vertices: 0,
	targetBlock: 'none',
	playerPos: '0, 0, 0',
	// Additive boosts on top of per-material values from BlockRegistry
	shininess: 0,
	specularStrength: 0,
	reflectivity: 0,
	roughness: 0,
	// Terrain lighting: flat ambient (color × level) + hand-authored per-face
	// sun table tinted by sun color (FACE_LIGHT_WGSL). All values linear;
	// defaults approximate the old gamma-era face table's displayed
	// brightness (lit top ≈ 1.0, floor ≈ 0.22). East/north get small nonzero
	// sun — bounce light pretending to be sun, so sun-averted corners read.
	ambientColor: { r: 0.53, g: 0.61, b: 0.82 },
	ambientLevel: 0.35,
	sunColor: { r: 1.0, g: 0.96, b: 0.9 },
	sunIntensity: 1.0,
	aoDirect: 0.3,
	faceTop: 0.8,
	faceBottom: 0.0,
	faceSouth: 0.6,
	faceNorth: 0.06,
	faceWest: 0.4,
	faceEast: 0.12,
	fogStart: 1300,
	fogEnd: 1400,
	tonemap: 'ACES' as TonemapMode,
	// Fitted ACES lifts middle gray (~0.18 → ~0.27); 0.8 re-anchors the
	// scene's mids to their pre-tonemap brightness, tuned by eye.
	exposure: 0.8,
	skyIntensity: 1.0,
	shadows: true,
	shadowStrength: 0.65,
	shadowBias: 0.0,
	shadowNormalBias: 0.35,
};

let pane: Pane | null = null;

export function refreshDebug(): void {
	pane?.refresh();
}

// No change handlers on any binding: the rAF game loop re-renders every
// frame, so pane edits take effect next tick without manual invalidation.
export function BuildDebug(): void {
	pane = new Pane({ title: 'Debug' });

	const playerFolder = pane.addFolder({ title: 'Player' });
	playerFolder.addBinding(debuggerParams, 'freecam', {
		label: 'Freecam (f)',
	});
	playerFolder.addBinding(debuggerParams, 'vertices', {
		readonly: true,
		label: 'Vertices',
		format: (v) => v.toFixed(0),
	});
	playerFolder.addBinding(debuggerParams, 'targetBlock', {
		readonly: true,
		label: 'Target',
	});
	playerFolder.addBinding(debuggerParams, 'playerPos', {
		readonly: true,
		label: 'Location',
	});

	const renderDebugFolder = pane.addFolder({
		title: 'Render',
		expanded: false,
	});
	renderDebugFolder.addBinding(debuggerParams, 'renderMode', {
		label: 'View Mode',
		options: {
			Final: 'Final',
			Albedo: 'Albedo',
			Lighting: 'Lighting',
			AO: 'AO',
		} satisfies Record<RenderMode, RenderMode>,
	});
	renderDebugFolder.addBinding(debuggerParams, 'msaa', {
		label: 'MSAA',
		options: {
			'No MSAA': 'Off',
			'4x MSAA': '4x',
		} satisfies Record<string, MSAAMode>,
	});
	renderDebugFolder.addBinding(debuggerParams, 'wireframe', {
		label: 'Wireframe',
	});

	const reflFolder = pane.addFolder({ title: 'Specular', expanded: false });
	reflFolder.addBinding(debuggerParams, 'shininess', {
		label: 'Shininess',
		min: -100,
		max: 100,
		step: 1,
	});
	reflFolder.addBinding(debuggerParams, 'specularStrength', {
		label: 'Glint Strength',
		min: -1,
		max: 1,
		step: 0.01,
	});
	reflFolder.addBinding(debuggerParams, 'reflectivity', {
		label: 'Reflectivity',
		min: -1,
		max: 1,
		step: 0.01,
	});
	reflFolder.addBinding(debuggerParams, 'roughness', {
		label: 'Roughness',
		min: -1,
		max: 1,
		step: 0.01,
	});

	const lightingFolder = pane.addFolder({
		title: 'Lighting',
		expanded: false,
	});
	lightingFolder.addBinding(debuggerParams, 'ambientColor', {
		label: 'Ambient Color',
		color: { type: 'float' },
	});
	lightingFolder.addBinding(debuggerParams, 'ambientLevel', {
		label: 'Ambient Level',
		min: 0,
		max: 1,
		step: 0.01,
	});
	lightingFolder.addBinding(debuggerParams, 'sunColor', {
		label: 'Sun Color',
		color: { type: 'float' },
	});
	lightingFolder.addBinding(debuggerParams, 'sunIntensity', {
		label: 'Sun Intensity',
		min: 0,
		max: 3,
		step: 0.01,
	});
	lightingFolder.addBinding(debuggerParams, 'aoDirect', {
		label: 'AO on Direct',
		min: 0,
		max: 1,
		step: 0.01,
	});
	const faceBindings = [
		['faceTop', 'Top +Y'],
		['faceBottom', 'Bottom −Y'],
		['faceSouth', 'South +Z'],
		['faceNorth', 'North −Z'],
		['faceWest', 'West −X'],
		['faceEast', 'East +X'],
	] as const;
	for (const [key, label] of faceBindings) {
		lightingFolder.addBinding(debuggerParams, key, {
			label,
			min: 0,
			max: 1.5,
			step: 0.01,
		});
	}

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

	const fogFolder = pane.addFolder({ title: 'Fog', expanded: false });
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

	const tonemapFolder = pane.addFolder({ title: 'Tonemap', expanded: false });
	tonemapFolder.addBinding(debuggerParams, 'tonemap', {
		label: 'Curve',
		options: {
			Off: 'Off',
			Reinhard: 'Reinhard',
			ACES: 'ACES',
			AgX: 'AgX',
			'AgX Punchy': 'AgX Punchy',
		} satisfies Record<TonemapMode, TonemapMode>,
	});
	tonemapFolder.addBinding(debuggerParams, 'exposure', {
		label: 'Exposure',
		min: 0.1,
		max: 4,
		step: 0.05,
	});
	tonemapFolder.addBinding(debuggerParams, 'skyIntensity', {
		label: 'Sky Intensity',
		min: 0.1,
		max: 4,
		step: 0.05,
	});

	const shadowFolder = pane.addFolder({ title: 'Shadows', expanded: false });
	shadowFolder.addBinding(debuggerParams, 'shadows', {
		label: 'Enabled',
	});
	shadowFolder.addBinding(debuggerParams, 'shadowStrength', {
		label: 'Strength',
		min: 0,
		max: 1,
		step: 0.05,
	});
	shadowFolder.addBinding(debuggerParams, 'shadowBias', {
		label: 'Bias',
		min: 0,
		max: 0.01,
		step: 0.0001,
	});
	shadowFolder.addBinding(debuggerParams, 'shadowNormalBias', {
		label: 'Normal Bias',
		min: 0,
		max: 2,
		step: 0.05,
	});
}
