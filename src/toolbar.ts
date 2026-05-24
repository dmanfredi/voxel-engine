const SLOT_COUNT = 4;

export interface ToolbarState {
	getSelected(): number;
}

export function initToolbar(): ToolbarState {
	const items = Array.from(
		document.querySelectorAll<HTMLElement>('.toolbar-item'),
	);
	if (items.length !== SLOT_COUNT) {
		throw new Error(
			`Toolbar expected ${String(SLOT_COUNT)} .toolbar-item elements, found ${String(items.length)}`,
		);
	}

	let selected = 0;

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

	return {
		getSelected: () => selected,
	};
}
