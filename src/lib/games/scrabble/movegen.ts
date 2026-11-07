import { readPlay, SIZE, type PlaceTile, type ScrabbleState } from './engine';
import type { Trie } from './lexicon';

export type GeneratedMove = { tiles: PlaceTile[]; score: number; word: string };

const A = 65;
const BLANK = 26;
const ALL_LETTERS = (1 << 26) - 1;

type Step = { pos: number; letter: number; blank: boolean };

/**
 * Every play available from a seat's rack, by Appel and Jacobson's method: start from each anchor
 * square beside an existing tile, and let the trie say which letters can follow.
 */
export function generateMoves(s: ScrabbleState, seat: number, trie: Trie): GeneratedMove[] {
	const rackTiles = s.racks[seat];
	if (!rackTiles.length) return [];
	const counts = new Int8Array(27);
	for (const t of rackTiles) counts[t.letter === '?' ? BLANK : t.letter.charCodeAt(0) - A]++;

	const grid = new Int8Array(SIZE * SIZE).fill(-1);
	let boardEmpty = true;
	for (const [key, tile] of Object.entries(s.board)) {
		const [r, c] = key.split(',').map(Number);
		grid[r * SIZE + c] = tile.letter.charCodeAt(0) - A;
		boardEmpty = false;
	}

	const moves = new Map<string, GeneratedMove>();

	for (const across of [true, false]) {
		const at = (line: number, pos: number) =>
			pos < 0 || pos >= SIZE || line < 0 || line >= SIZE
				? -1
				: grid[across ? line * SIZE + pos : pos * SIZE + line];

		/** Which letters would make a real word with the tiles above and below this square. */
		const crossMask = (line: number, pos: number) => {
			if (at(line - 1, pos) < 0 && at(line + 1, pos) < 0) return ALL_LETTERS;
			let node = trie.root;
			let start = line;
			while (at(start - 1, pos) >= 0) start--;
			for (let l = start; l < line; l++) {
				node = trie.child(node, at(l, pos));
				if (!node) return 0;
			}
			let mask = 0;
			trie.forEachChild(node, (letter, child) => {
				let n = child;
				for (let l = line + 1; at(l, pos) >= 0 && n; l++) n = trie.child(n, at(l, pos));
				if (n && trie.isWord(n)) mask |= 1 << letter;
			});
			return mask;
		};

		const isAnchor = (line: number, pos: number) => {
			if (at(line, pos) >= 0) return false;
			if (boardEmpty) return line === 7 && pos === 7;
			return at(line - 1, pos) >= 0 || at(line + 1, pos) >= 0 || at(line, pos - 1) >= 0 || at(line, pos + 1) >= 0;
		};

		for (let line = 0; line < SIZE; line++) {
			const masks = new Int32Array(SIZE);
			const anchors: boolean[] = [];
			for (let pos = 0; pos < SIZE; pos++) {
				anchors.push(isAnchor(line, pos));
				masks[pos] = at(line, pos) >= 0 ? 0 : crossMask(line, pos);
			}

			const placed: Step[] = [];

			const record = () => {
				const pool = [...rackTiles];
				const tiles = placed.map((step): PlaceTile & { blank: boolean } => {
					const wanted = step.blank ? '?' : String.fromCharCode(A + step.letter);
					const tile = pool.splice(pool.findIndex((t) => t.letter === wanted), 1)[0];
					const letter = String.fromCharCode(A + step.letter);
					const [r, c] = across ? [line, step.pos] : [step.pos, line];
					return { r, c, tileId: tile.id, letter, blank: step.blank };
				});
				tiles.sort((a, b) => a.r - b.r || a.c - b.c);
				const key = tiles.map((t) => `${t.r},${t.c},${t.letter},${t.blank ? 1 : 0}`).join('|');
				if (moves.has(key)) return;
				const read = readPlay(s.board, tiles);
				moves.set(key, {
					tiles: tiles.map(({ blank: _blank, ...t }) => t),
					score: read.score,
					word: read.cells.map((c) => c.letter).join('')
				});
			};

			/** Uses a real tile if there is one, otherwise a blank. */
			const withLetter = (letter: number, pos: number, then: () => void) => {
				if (counts[letter] > 0) {
					counts[letter]--;
					placed.push({ pos, letter, blank: false });
					then();
					placed.pop();
					counts[letter]++;
				} else if (counts[BLANK] > 0) {
					counts[BLANK]--;
					placed.push({ pos, letter, blank: true });
					then();
					placed.pop();
					counts[BLANK]++;
				}
			};

			const extendRight = (node: number, pos: number, anchor: number) => {
				if (pos > anchor && placed.length && trie.isWord(node) && at(line, pos) < 0) record();
				if (pos >= SIZE) return;
				const existing = at(line, pos);
				if (existing >= 0) {
					const next = trie.child(node, existing);
					if (next) extendRight(next, pos + 1, anchor);
					return;
				}
				trie.forEachChild(node, (letter, child) => {
					if (!(masks[pos] & (1 << letter))) return;
					withLetter(letter, pos, () => extendRight(child, pos + 1, anchor));
				});
			};

			/** Builds letters to the left of the anchor. They are laid out once their length is known. */
			const leftPart = (node: number, built: number[], limit: number, anchor: number) => {
				const start = anchor - built.length;
				const mark = placed.length;
				const blanksUsed: boolean[] = [];
				let ok = true;
				for (let i = 0; i < built.length; i++) {
					const letter = built[i];
					if (counts[letter] > 0) {
						counts[letter]--;
						blanksUsed.push(false);
					} else if (counts[BLANK] > 0) {
						counts[BLANK]--;
						blanksUsed.push(true);
					} else {
						ok = false;
						break;
					}
					placed.push({ pos: start + i, letter, blank: blanksUsed[i] });
				}
				if (ok) extendRight(node, anchor, anchor);
				for (let i = blanksUsed.length - 1; i >= 0; i--) {
					if (blanksUsed[i]) counts[BLANK]++;
					else counts[built[i]]++;
				}
				placed.length = mark;
				if (!ok || limit === 0) return;
				trie.forEachChild(node, (letter, child) => {
					leftPart(child, [...built, letter], limit - 1, anchor);
				});
			};

			for (let anchor = 0; anchor < SIZE; anchor++) {
				if (!anchors[anchor]) continue;
				if (at(line, anchor - 1) >= 0) {
					// Tiles already sit to the left, so the word must start with them.
					let start = anchor - 1;
					while (at(line, start - 1) >= 0) start--;
					let node = trie.child(trie.root, at(line, start));
					for (let pos = start + 1; pos < anchor && node; pos++) node = trie.child(node, at(line, pos));
					if (node) extendRight(node, anchor, anchor);
				} else {
					// Free squares to the left, up to the previous anchor.
					let limit = 0;
					for (let pos = anchor - 1; pos >= 0 && at(line, pos) < 0 && !anchors[pos]; pos--) limit++;
					leftPart(trie.root, [], limit, anchor);
				}
			}
		}
	}
	return [...moves.values()];
}
