import type { SourceId } from '../vision/engine.svelte';

export type TestRow = {
	at: string;
	label: string;
	trained: boolean;
	distanceCm: number;
	yaw: number;
	pitch: number;
	faces: number;
	resolution: string;
	fps: number;
	/** Median error in cm, over the dots where that source gave a reading. */
	errorCm: Record<SourceId, number | null>;
	/** Worst horizontal and vertical bias, in cm. Positive means right of or below the target. */
	biasCm: Record<SourceId, { x: number; y: number } | null>;
};

const KEY = 'gaze-test-log';

function load(): TestRow[] {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? '[]');
	} catch {
		return [];
	}
}

class TestLog {
	rows = $state<TestRow[]>(load());
	label = $state('seated, normal');

	add(row: TestRow) {
		this.rows.push(row);
		this.save();
	}

	clear() {
		this.rows = [];
		this.save();
	}

	private save() {
		try {
			localStorage.setItem(KEY, JSON.stringify(this.rows));
		} catch {
			// Log only lives for this page view if storage is blocked.
		}
	}

	async copy() {
		await navigator.clipboard.writeText(JSON.stringify(this.rows, null, 2));
	}
}

export const testLog = new TestLog();
