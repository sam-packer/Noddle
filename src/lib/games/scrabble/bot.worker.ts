import { chooseAction } from './bot';
import type { ScrabbleState } from './engine';
import { buildTrie, type Trie } from './lexicon';

/** Thinks away from the page, so even a slow move can never stall the head pointer. */
let trie: Trie | null = null;

type Request = { id: number; state: ScrabbleState; seat: number; seed: number; words?: string };

self.onmessage = (e: MessageEvent<Request>) => {
	const { id, state, seat, seed, words } = e.data;
	try {
		// The page fetches the word list once and hands it over with the first request.
		if (words !== undefined) trie = buildTrie(words);
		if (!trie) throw new Error('The bot was never given the word list');
		self.postMessage({ id, action: chooseAction(state, seat, trie, seed) });
	} catch (err) {
		self.postMessage({ id, error: String(err) });
	}
};
