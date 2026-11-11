import type { ScrabbleAction } from '../games/scrabble/engine';
import { textLexicon, type Lexicon } from '../games/scrabble/lexicon';
import { DemoScrabbleSession } from './demoScrabble';
import { DemoUnoSession } from './demoUno';
import { LocalScrabbleSession, type ScrabbleBot } from './localScrabble';
import { LocalUnoSession } from './localUno';

let words: Promise<string> | null = null;

/**
 * The word list, fetched once from this site, so it works with no internet. The page checks the
 * player's words with it, and the bot worker is handed the same text rather than fetching its own.
 */
function loadWords(): Promise<string> {
	words ??= fetch('/dict/enable.txt')
		.then((r) => {
			if (!r.ok) throw new Error(`dictionary: ${r.status}`);
			return r.text();
		})
		.catch((e) => {
			// Try again next time it's needed, rather than staying broken for the rest of the game.
			words = null;
			throw e;
		});
	return words;
}

let lexicon: Promise<Lexicon> | null = null;

export function loadLexicon(): Promise<Lexicon> {
	lexicon ??= loadWords()
		.then(textLexicon)
		.catch((e) => {
			lexicon = null;
			throw e;
		});
	return lexicon;
}

/**
 * The Scrabble bot, thinking in a worker. Once the worker has failed it stays failed, so every later
 * request is refused at once rather than waiting for an answer that will never come.
 */
function workerBot(): { bot: ScrabbleBot; stop: () => void } {
	let failed: Error | null = null;
	let worker: Worker | null = null;
	const waiting = new Map<number, { resolve: (a: ScrabbleAction) => void; reject: (e: Error) => void }>();
	const fail = (error: Error) => {
		failed = error;
		for (const entry of waiting.values()) entry.reject(error);
		waiting.clear();
		worker?.terminate();
	};
	try {
		worker = new Worker(new URL('../games/scrabble/bot.worker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (e: MessageEvent<{ id: number; action?: ScrabbleAction; error?: string }>) => {
			const entry = waiting.get(e.data.id);
			waiting.delete(e.data.id);
			if (e.data.action) entry?.resolve(e.data.action);
			else entry?.reject(new Error(e.data.error));
		};
		worker.onerror = (e) => fail(new Error(e.message || 'The bot worker failed'));
		worker.onmessageerror = () => fail(new Error('The bot worker sent something unreadable'));
	} catch (e) {
		failed = e instanceof Error ? e : new Error(String(e));
	}
	let nextId = 0;
	/** Whether the worker has the word list yet. It gets it with its first request. */
	let gaveWords = false;
	return {
		bot: async (state, seat) => {
			const text = gaveWords ? undefined : await loadWords();
			return new Promise((resolve, reject) => {
				if (failed || !worker) return reject(failed ?? new Error('No bot worker'));
				const id = nextId++;
				waiting.set(id, { resolve, reject });
				worker.postMessage({ id, state, seat, seed: (Date.now() + id) >>> 0, words: text });
				gaveWords = true;
			});
		},
		stop: () => worker?.terminate()
	};
}

export const createDemoUno = () => new DemoUnoSession();
export const createDemoScrabble = () => new DemoScrabbleSession({ lexicon: loadLexicon });
export const createLocalUno = () => new LocalUnoSession();

export function createLocalScrabble() {
	const { bot, stop } = workerBot();
	return new LocalScrabbleSession({ lexicon: loadLexicon, bot, onClose: stop });
}
