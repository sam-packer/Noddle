import type { EyeFrame, EyeScore } from '../vision/eyeSignal';

/** One person's run. Stays in this browser, plus .recordings/eyes when running locally. */
export type EyeRun = {
	id: string;
	label: string;
	at: string;
	irisPx: number;
	resolution: string;
	fps: number;
	score: EyeScore;
	frames: EyeFrame[];
	clip: Blob;
};

const STORE = 'runs';

/** One connection, opened on first use and shared by every request after. */
let db: Promise<IDBDatabase> | null = null;

function open() {
	db ??= new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open('noddle-eyes', 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
		req.onsuccess = () => {
			const conn = req.result;
			// Another tab upgrading, or the browser closing it, ends this one. The next use reopens.
			conn.onversionchange = () => {
				conn.close();
				db = null;
			};
			conn.onclose = () => (db = null);
			resolve(conn);
		};
		req.onerror = () => {
			db = null;
			reject(req.error);
		};
	});
	return db;
}

async function request<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) {
	const db = await open();
	return new Promise<T>((resolve, reject) => {
		const req = run(db.transaction(STORE, mode).objectStore(STORE));
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export async function loadRuns(): Promise<EyeRun[]> {
	const runs = await request<EyeRun[]>('readonly', (s) => s.getAll());
	return runs.sort((a, b) => a.at.localeCompare(b.at));
}

export const putRun = (run: EyeRun) => request('readwrite', (s) => s.put(run));
export const deleteRun = (id: string) => request('readwrite', (s) => s.delete(id));

/** A copy on disk, for slides and analysis. Only exists under the dev server, so failure is fine. */
export function saveRunToDisk(run: EyeRun, withClip: boolean) {
	const { clip, ...numbers } = run;
	fetch(`/__eyes?id=${run.id}&ext=json`, { method: 'POST', body: JSON.stringify(numbers) }).catch(() => {});
	if (withClip) {
		const ext = clip.type.includes('mp4') ? 'mp4' : 'webm';
		fetch(`/__eyes?id=${run.id}&ext=${ext}`, { method: 'POST', body: clip }).catch(() => {});
	}
}
