import type { Tool } from './tool';
import { pickaxeTool, boreTool, bridgeTool } from './tool';

export interface GameState {
	bp: number;
	/**
	 * Seconds left on the hit lockout — the BP economy is frozen while > 0
	 * (no spending, no earning; see `applyPlayerHit`). Ticked toward 0 each
	 * frame. Satisfies `PlayerHitLike`, so the death dispatch writes it
	 * directly when a blast lands.
	 */
	lockoutRemaining: number;
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
		lockoutRemaining: 0,
		tools: [pickaxeTool, boreTool, bridgeTool, null],
		selectedToolIndex: 0,
	};
}
