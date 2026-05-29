const SLOT_COUNT = 4;

export interface ToolbarOptions {
	/** Initial highlighted slot. Defaults to 0. */
	initialIndex?: number;
	/**
	 * Called whenever the user changes the selected slot. The receiver
	 * (main.ts) writes through to `gameState.selectedToolIndex` so the
	 * toolbar isn't a second source of truth.
	 */
	onSelect?: (index: number) => void;
}

/**
 * Initialize the hotbar UI. Binds 1-4 + scroll wheel to slot selection
 * and toggles the `.selected` class on `.toolbar-item` elements. State
 * lives wherever `onSelect` writes — the toolbar holds only the current
 * index locally for diffing purposes (avoid pointless DOM toggles).
 */
export function initToolbar(opts: ToolbarOptions = {}): void {
	const items = Array.from(
		document.querySelectorAll<HTMLElement>('.toolbar-item'),
	);
	if (items.length !== SLOT_COUNT) {
		throw new Error(
			`Toolbar expected ${String(SLOT_COUNT)} .toolbar-item elements, found ${String(items.length)}`,
		);
	}

	let selected = opts.initialIndex ?? 0;

	function apply(): void {
		for (let i = 0; i < items.length; i++) {
			items[i].classList.toggle('selected', i === selected);
		}
	}
	apply();

	function setSelected(i: number): void {
		// Wrap with positive-modulo so scroll past either end loops cleanly.
		const next = ((i % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT;
		if (next === selected) return;
		selected = next;
		apply();
		opts.onSelect?.(selected);
	}

	window.addEventListener('keydown', (e) => {
		if (e.code === 'Digit1') setSelected(0);
		else if (e.code === 'Digit2') setSelected(1);
		else if (e.code === 'Digit3') setSelected(2);
		else if (e.code === 'Digit4') setSelected(3);
	});

	window.addEventListener(
		'wheel',
		(e) => {
			if (e.deltaY === 0) return;
			setSelected(selected + (e.deltaY > 0 ? 1 : -1));
			e.preventDefault();
		},
		{ passive: false },
	);
}
