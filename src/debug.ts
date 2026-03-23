import Stats from 'stats.js';
import { Pane } from 'tweakpane';

export const stats = new Stats();
stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
document.body.appendChild(stats.dom);

export const debuggerParams = {
	wireframe: false,
	freecam: false,
	bevelMesh: false,
	bevelSize: 0.8,
	bevelShader: true,
	bevelIntensity: 1.0,
	vertices: 0,
	targetBlock: 'none',
};

let pane: Pane | null = null;

export function refreshDebug(): void {
	pane?.refresh();
}

export function BuildDebug(render: () => void, remeshAll: () => void): void {
	pane = new Pane({ title: 'Debug' });
	const wireframeBinding = pane.addBinding(debuggerParams, 'wireframe', {
		label: 'Wireframe',
	});
	pane.addBinding(debuggerParams, 'freecam', {
		label: 'Freecam',
	});
	const bevelBinding = pane.addBinding(debuggerParams, 'bevelMesh', {
		label: 'Bevel Mesh',
	});
	const bevelShaderBinding = pane.addBinding(debuggerParams, 'bevelShader', {
		label: 'Bevel Shader',
	});
	const bevelSizeBinding = pane.addBinding(debuggerParams, 'bevelSize', {
		label: 'Bevel Size',
		min: 0.1,
		max: 5.0,
		step: 0.1,
	});
	pane.addBinding(debuggerParams, 'bevelIntensity', {
		label: 'Bevel Intensity',
		min: 0.1,
		max: 5.0,
		step: 0.1,
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
	bevelBinding.on('change', () => {
		remeshAll();
	});
	bevelShaderBinding.on('change', () => {
		requestAnimationFrame(() => {
			render();
		});
	});
	bevelSizeBinding.on('change', () => {
		if (debuggerParams.bevelMesh) {
			remeshAll();
		}
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
