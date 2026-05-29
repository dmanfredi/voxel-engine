import type { Tool } from './tool';
import { pickaxeTool } from './tool';

export interface GameState {
	bp: number;
	/**
	 * Hotbar slots. Length matches the toolbar UI (currently 4). Null
	 * slots are empty — input handlers no-op on the selected slot if it
	 * holds null.
	 */
	tools: (Tool | null)[];
	/**
	 * Index into `tools` of the currently held tool. Written by the
	 * toolbar UI (via its setter callback), read by LMB/RMB handlers.
	 */
	selectedToolIndex: number;
}

export function createGameState(): GameState {
	return {
		bp: 500,
		tools: [pickaxeTool, null, null, null],
		selectedToolIndex: 0,
	};
}
