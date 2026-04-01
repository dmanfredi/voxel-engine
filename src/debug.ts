import Stats from 'stats.js';
import { Pane } from 'tweakpane';

export const stats = new Stats();
stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
document.body.appendChild(stats.dom);

export const debuggerParams = {
	wireframe: false,
	freecam: false,
	vertices: 0,
	targetBlock: 'none',
	shininess: 32,
	specularStrength: 0.3,
	fogStart: 1300,
	fogEnd: 1400,
};

let pane: Pane | null = null;

export function refreshDebug(): void {
	pane?.refresh();
}

export function BuildDebug(render: () => void): void {
	pane = new Pane({ title: 'Debug' });
	const wireframeBinding = pane.addBinding(debuggerParams, 'wireframe', {
		label: 'Wireframe',
	});
	pane.addBinding(debuggerParams, 'freecam', {
		label: 'Freecam',
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

	wireframeBinding.on('change', () => {
		requestAnimationFrame(() => {
			render();
		});
	});

	const reflFolder = pane.addFolder({ title: 'Specular' });
	reflFolder.addBinding(debuggerParams, 'shininess', {
		label: 'Shininess',
		min: 2,
		max: 256,
		step: 1,
	});
	reflFolder.addBinding(debuggerParams, 'specularStrength', {
		label: 'Spec Strength',
		min: 0,
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
}

// class Debugger {
// 	constructor() {
// 		bar: 1;
// 	}

// 	foo = (): number => {
// 		return this.bar;
// 	};
// }
