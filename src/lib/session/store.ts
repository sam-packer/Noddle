import type { SessionSnapshot } from './types';

/** Holds a session's latest snapshot and tells subscribers when it changes. */
export class SnapshotStore<V> {
	private listeners = new Set<(snapshot: SessionSnapshot<V>) => void>();

	constructor(public value: SessionSnapshot<V>) {}

	subscribe = (run: (snapshot: SessionSnapshot<V>) => void) => {
		this.listeners.add(run);
		run(this.value);
		return () => {
			this.listeners.delete(run);
		};
	};

	set(change: Partial<SessionSnapshot<V>>) {
		this.value = { ...this.value, ...change };
		for (const run of this.listeners) run(this.value);
	}

	reject(reason: string) {
		this.set({ rejected: { reason, n: (this.value.rejected?.n ?? 0) + 1 } });
	}
}
