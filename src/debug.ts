import Stats from 'stats.js';
import { Pane } from 'tweakpane';

export const RENDER_MODE = {
	Final: 0,
	Albedo: 1,
	Lighting: 2,
	AO: 3,
} as const;

export type RenderMode = keyof typeof RENDER_MODE;

export const MSAA_MODE = {
	Off: 1,
	'4x': 4,
} as const;

export type MSAAMode = keyof typeof MSAA_MODE;

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
	// Additive boost on top of per-material values from BlockRegistry
	shininess: 0,
	specularStrength: 0,
	fogStart: 1300,
	fogEnd: 1400,
	shadows: true,
	shadowStrength: 0.45,
	shadowBias: 0.0,
	shadowNormalBias: 0.35,
};

let pane: Pane | null = null;

export function refreshDebug(): void {
	pane?.refresh();
}

export function BuildDebug(render: () => void): void {
	pane = new Pane({ title: 'Debug' });
	const renderDebugFolder = pane.addFolder({ title: 'Render Debug' });
	const renderModeBinding = renderDebugFolder.addBinding(
		debuggerParams,
		'renderMode',
		{
			label: 'View Mode',
			options: {
				Final: 'Final',
				Albedo: 'Albedo',
				Lighting: 'Lighting',
				AO: 'AO',
			},
		},
	);
	const msaaBinding = renderDebugFolder.addBinding(debuggerParams, 'msaa', {
		label: 'MSAA',
		options: {
			'No MSAA': 'Off',
			'4x MSAA': '4x',
		},
	});
	const wireframeBinding = renderDebugFolder.addBinding(
		debuggerParams,
		'wireframe',
		{
			label: 'Wireframe',
		},
	);
	const requestDebugRender = () => {
		requestAnimationFrame(() => {
			render();
		});
	};
	renderModeBinding.on('change', requestDebugRender);
	msaaBinding.on('change', requestDebugRender);
	wireframeBinding.on('change', requestDebugRender);

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

// class Debugger {
// 	constructor() {
// 		bar: 1;
// 	}

// 	foo = (): number => {
// 		return this.bar;
// 	};
// }
