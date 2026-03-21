export interface GameState {
	bp: number;
}

export function createGameState(): GameState {
	return { bp: 500 };
}
