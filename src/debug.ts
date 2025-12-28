import Stats from 'stats.js';
import { Pane } from 'tweakpane';

export const stats = new Stats();
stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
document.body.appendChild(stats.dom);

export const debuggerParams = {
	wireframe: false,
};

export function BuildDebug(render: () => void): void {
	const pane = new Pane({ title: 'Debug' });
	const wireframeBinding = pane.addBinding(debuggerParams, 'wireframe', {
		label: 'Wireframe',
	});

	wireframeBinding.on('change', () => {
		// ev.value is the *new* value
		// ev.last is the *previous* value
		// engine.setWireframe(ev.value);

		requestAnimationFrame(() => {
			render();
		});
	});
	return;
}

// class Debugger {
// 	constructor() {
// 		bar: 1;
// 	}

// 	foo = (): number => {
// 		return this.bar;
// 	};
// }
