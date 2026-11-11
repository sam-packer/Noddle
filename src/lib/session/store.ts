import type { RuleCode } from '../games/rng';
import type { SessionSnapshot } from './types';

/** A value that tells subscribers when it changes. A Svelte store. */
export class Store<T extends object> {
	private listeners = new Set<(value: T) => void>();

	constructor(public value: T) {}

	subscribe = (run: (value: T) => void) => {
		this.listeners.add(run);
		run(this.value);
		return () => {
			this.listeners.delete(run);
		};
	};

	set(change: Partial<T>) {
		this.value = { ...this.value, ...change };
		for (const run of this.listeners) run(this.value);
	}
}

/** Holds a session's latest snapshot. */
export class SnapshotStore<V> extends Store<SessionSnapshot<V>> {
	reject({ code, message }: { code: RuleCode; message: string }) {
		this.set({ rejected: { code, reason: message, n: (this.value.rejected?.n ?? 0) + 1 } });
	}
}
