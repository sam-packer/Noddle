import type { ScrabbleAction } from '../games/scrabble/engine';
import { textLexicon, type Lexicon } from '../games/scrabble/lexicon';
import { DemoScrabbleSession } from './demoScrabble';
import { DemoUnoSession } from './demoUno';
import { LocalScrabbleSession, type ScrabbleBot } from './localScrabble';
import { LocalUnoSession } from './localUno';

let lexicon: Promise<Lexicon> | null = null;

/** The word list, fetched once from this site, so it works with no internet. */
export function loadLexicon(): Promise<Lexicon> {
	lexicon ??= fetch('/dict/enable.txt')
		.then((r) => {
			if (!r.ok) throw new Error(`dictionary: ${r.status}`);
			return r.text();
		})
		.then(textLexicon)
		.catch((e) => {
			lexicon = null;
			throw e;
		});
	return lexicon;
}

function workerBot(): { bot: ScrabbleBot; stop: () => void } {
	const worker = new Worker(new URL('../games/scrabble/bot.worker.ts', import.meta.url), { type: 'module' });
	let nextId = 0;
	const waiting = new Map<number, { resolve: (a: ScrabbleAction) => void; reject: (e: Error) => void }>();
	worker.onmessage = (e: MessageEvent<{ id: number; action?: ScrabbleAction; error?: string }>) => {
		const entry = waiting.get(e.data.id);
		waiting.delete(e.data.id);
		if (e.data.action) entry?.resolve(e.data.action);
		else entry?.reject(new Error(e.data.error));
	};
	worker.onerror = (e) => {
		for (const entry of waiting.values()) entry.reject(new Error(e.message));
		waiting.clear();
	};
	return {
		bot: (state, seat) =>
			new Promise((resolve, reject) => {
				const id = nextId++;
				waiting.set(id, { resolve, reject });
				worker.postMessage({ id, state, seat, seed: (Date.now() + id) >>> 0 });
			}),
		stop: () => worker.terminate()
	};
}

export const createDemoUno = () => new DemoUnoSession();
export const createDemoScrabble = () => new DemoScrabbleSession({ lexicon: loadLexicon });
export const createLocalUno = () => new LocalUnoSession();

export function createLocalScrabble() {
	const { bot, stop } = workerBot();
	return new LocalScrabbleSession({ lexicon: loadLexicon, bot, onClose: stop });
}
