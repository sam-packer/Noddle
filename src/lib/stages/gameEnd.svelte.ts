import { untrack } from 'svelte';
import type { Ended } from '../session/types';

/** A stray nod just after the game ends must not choose what happens next. */
const END_BUTTONS_DELAY_MS = 1500;

/**
 * How every game screen ends, and how the next game starts. A scripted ending moves on by itself
 * after its `advanceMs`. A real one shows its buttons after a pause. When another game starts in
 * the same screen, `onNewGame` clears whatever belonged to the last one.
 *
 * Create it before any effect that reacts to the new game's cards or board, so they already see a
 * clean slate. Keyed on plain values, because each session update is a new object and must not
 * restart the pause.
 */
export function gameEnd(options: {
	ended: () => Ended | null;
	/** Where a scripted ending moves on to. */
	onDone: () => void;
	onEnd?: () => void;
	onNewGame?: () => void;
}) {
	let buttons = $state(false);
	const over = $derived(!!options.ended());
	const advanceMs = $derived(options.ended()?.advanceMs);
	let wasOver = false;

	$effect.pre(() => {
		const now = over;
		untrack(() => {
			if (now && !wasOver) options.onEnd?.();
			if (!now && wasOver) options.onNewGame?.();
			wasOver = now;
		});
	});

	$effect(() => {
		if (!over) {
			buttons = false;
			return;
		}
		const delay = advanceMs;
		const timer = setTimeout(() => {
			if (delay !== undefined) options.onDone();
			else buttons = true;
		}, delay ?? END_BUTTONS_DELAY_MS);
		return () => clearTimeout(timer);
	});

	return {
		get over() {
			return over;
		},
		/** It moves on by itself, so there is nothing to choose. */
		get scripted() {
			return advanceMs !== undefined;
		},
		/** Again and Menu can be chosen. */
		get buttons() {
			return buttons;
		}
	};
}
