import Stats from 'stats.js';
import { Pane } from 'tweakpane';
import type { RenderMode, MSAAMode, TonemapMode } from './render-config';

export const stats = new Stats();
stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
document.body.appendChild(stats.dom);

export const debuggerParams = {
	renderMode: 'Final' as RenderMode,
	msaa: 'Off' as MSAAMode,
	wireframe: false,
	freecam: false,
	vertices: 0,
	targetBlock: 'none',
	playerPos: '0, 0, 0',
	// Additive boosts on top of per-material values from BlockRegistry
	shininess: 0,
	specularStrength: 0,
	reflectivity: 0,
	fogStart: 1300,
	fogEnd: 1400,
	tonemap: 'ACES' as TonemapMode,
	// Fitted ACES lifts middle gray (~0.18 → ~0.27); 0.8 re-anchors the
	// scene's mids to their pre-tonemap brightness, tuned by eye.
	exposure: 0.8,
	skyIntensity: 1.0,
	shadows: true,
	shadowStrength: 0.45,
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
	const renderDebugFolder = pane.addFolder({ title: 'Render Debug' });
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

	const playerFolder = pane.addFolder({ title: 'Player' });
	playerFolder.addBinding(debuggerParams, 'freecam', {
		label: 'Freecam',
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

	const reflFolder = pane.addFolder({ title: 'Specular' });
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
		step: 0.05,
	});
	reflFolder.addBinding(debuggerParams, 'reflectivity', {
		label: 'Reflectivity',
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

	const tonemapFolder = pane.addFolder({ title: 'Tonemap' });
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

	const shadowFolder = pane.addFolder({ title: 'Shadows' });
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
