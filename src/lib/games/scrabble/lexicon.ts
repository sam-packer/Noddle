/** Anything that can say whether a word is allowed. */
export type Lexicon = { has(word: string): boolean };

/**
 * Looks words up by binary search in the raw sorted word list, without parsing it. The rooms worker
 * has very little CPU time at start-up, and this needs none. The list must be sorted, lower case,
 * with one word per line.
 */
export function textLexicon(text: string): Lexicon {
	return {
		has(word) {
			if (word.length < 2) return false;
			const wanted = word.toLowerCase();
			let lo = 0;
			let hi = text.length;
			while (lo < hi) {
				const mid = (lo + hi) >>> 1;
				const start = text.lastIndexOf('\n', mid - 1) + 1;
				let end = text.indexOf('\n', mid);
				if (end < 0) end = text.length;
				const line = text.slice(start, end).trimEnd();
				if (line === wanted) return true;
				if (line < wanted) lo = end + 1;
				else hi = start;
			}
			return false;
		}
	};
}

const CHAR_A = 97;

/**
 * A trie stored in flat arrays as first-child and next-sibling links, which takes about 4 MB for
 * the whole dictionary against about 80 MB as objects. Letters are 0-25. The word list must be sorted.
 */
export class Trie implements Lexicon {
	readonly root = 0;
	private letter: Uint8Array;
	private firstChild: Int32Array;
	private nextSibling: Int32Array;
	private terminal: Uint8Array;

	constructor(text: string) {
		const capacity = text.length + 1;
		this.letter = new Uint8Array(capacity);
		this.firstChild = new Int32Array(capacity);
		this.nextSibling = new Int32Array(capacity);
		this.terminal = new Uint8Array(capacity);
		let used = 1;
		// The nodes for the previous word. Sorted input means a new word shares a prefix with it.
		const path = [0];
		let previous = '';
		for (const raw of text.split('\n')) {
			const word = raw.trim();
			if (!word) continue;
			let shared = 0;
			while (shared < word.length && shared < previous.length && word[shared] === previous[shared]) shared++;
			let node = path[shared];
			for (let i = shared; i < word.length; i++) {
				const child = used++;
				this.letter[child] = word.charCodeAt(i) - CHAR_A;
				// The parent's newest child is on the old path, one deeper, if that path went this way.
				const sibling = i === shared && shared < previous.length ? path[shared + 1] : 0;
				if (sibling) this.nextSibling[sibling] = child;
				else this.firstChild[node] = child;
				node = child;
				path[i + 1] = child;
			}
			this.terminal[node] = 1;
			previous = word;
		}
	}

	/** The child for a letter, or 0 if there is none. */
	child(node: number, letter: number) {
		for (let c = this.firstChild[node]; c; c = this.nextSibling[c]) {
			if (this.letter[c] === letter) return c;
		}
		return 0;
	}

	/** Walks every child. */
	forEachChild(node: number, visit: (letter: number, child: number) => void) {
		for (let c = this.firstChild[node]; c; c = this.nextSibling[c]) visit(this.letter[c], c);
	}

	isWord(node: number) {
		return this.terminal[node] === 1;
	}

	has(word: string) {
		const w = word.toLowerCase();
		let node = this.root;
		for (let i = 0; i < w.length; i++) {
			node = this.child(node, w.charCodeAt(i) - CHAR_A);
			if (!node) return false;
		}
		return w.length > 0 && this.isWord(node);
	}
}

export const buildTrie = (text: string) => new Trie(text);
