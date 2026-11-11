import { chooseAction } from './bot';
import type { ScrabbleState } from './engine';
import { buildTrie, type Trie } from './lexicon';

/** Thinks away from the page, so even a slow move can never stall the head pointer. */
let trie: Promise<Trie> | null = null;

function loadTrie() {
	trie ??= fetch('/dict/enable.txt')
		.then((r) => {
			if (!r.ok) throw new Error(`dictionary: ${r.status}`);
			return r.text();
		})
		.then(buildTrie)
		.catch((e) => {
			// Try again on the next turn, rather than passing for the rest of the game.
			trie = null;
			throw e;
		});
	return trie;
}

self.onmessage = async (e: MessageEvent<{ id: number; state: ScrabbleState; seat: number; seed: number }>) => {
	const { id, state, seat, seed } = e.data;
	try {
		self.postMessage({ id, action: chooseAction(state, seat, await loadTrie(), seed) });
	} catch (err) {
		self.postMessage({ id, error: String(err) });
	}
};
