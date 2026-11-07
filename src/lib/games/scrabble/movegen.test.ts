import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { apply, checkPlay, newGame, type ScrabbleState, type Tile } from './engine';
import { buildTrie, textLexicon } from './lexicon';
import { generateMoves } from './movegen';
import { chooseAction } from './bot';

const text = readFileSync('static/dict/enable.txt', 'utf8');
const lexicon = textLexicon(text);
const trie = buildTrie(text);
const rack = (letters: string, from = 1): Tile[] => [...letters].map((letter, i) => ({ id: from + i, letter }));
const boardWith = (word: string, r: number, c: number) =>
	Object.fromEntries([...word].map((letter, i) => [`${r},${c + i}`, { letter, blank: false }]));

function checkAll(s: ScrabbleState, seat = s.current) {
	const moves = generateMoves(s, seat, trie);
	for (const m of moves) {
		const verdict = checkPlay({ ...s, current: seat }, m.tiles, lexicon);
		expect(verdict.score).toBe(m.score);
		expect(verdict.main).toBe(m.word);
	}
	return moves;
}

describe('move generator', () => {
	test('every first move is valid and scored as the validator scores it', () => {
		const s = { ...newGame({ players: 2, seed: 1 }), racks: [rack('CATSDOG'), rack('EEEEEEE', 50)] };
		const moves = checkAll(s);
		expect(moves.length).toBeGreaterThan(50);
		expect(moves.some((m) => m.word === 'COATS')).toBe(true);
		expect(moves.every((m) => m.tiles.some((t) => t.r === 7 && t.c === 7))).toBe(true);
	});

	test('finds the bingo on the demo board', () => {
		const s = { ...newGame({ players: 2, seed: 1 }), board: boardWith('BOARD', 7, 5), racks: [rack('TGIMELS'), rack('', 50)], bag: [] };
		const moves = checkAll(s);
		const best = moves.toSorted((a, b) => b.score - a.score)[0];
		expect(best.score).toBeGreaterThanOrEqual(79);
		expect(moves.some((m) => m.word === 'GIMLETS' && m.score === 79)).toBe(true);
	});

	test('handles blanks, which score nothing', () => {
		const s = { ...newGame({ players: 2, seed: 1 }), board: boardWith('BOARD', 7, 5), racks: [rack('Q?'), rack('', 50)], bag: [] };
		const moves = checkAll(s);
		expect(moves.length).toBeGreaterThan(10);
		expect(moves.some((m) => m.tiles.some((t) => t.tileId === 2))).toBe(true);
	});

	test('returns nothing for an empty rack, or when nothing fits', () => {
		const s = { ...newGame({ players: 2, seed: 1 }), racks: [rack(''), rack('', 50)] };
		expect(generateMoves(s, 0, trie)).toEqual([]);
		const stuck = { ...newGame({ players: 2, seed: 1 }), racks: [rack('VVV'), rack('', 50)] };
		expect(generateMoves(stuck, 0, trie)).toEqual([]);
	});

	test('does not repeat a move found in both directions', () => {
		const s = { ...newGame({ players: 2, seed: 1 }), board: boardWith('BOARD', 7, 5), racks: [rack('S'), rack('', 50)], bag: [] };
		const moves = generateMoves(s, 0, trie);
		const keys = moves.map((m) => m.tiles.map((t) => `${t.r},${t.c},${t.letter}`).join('|'));
		expect(new Set(keys).size).toBe(keys.length);
	});

	test('misses nothing the validator allows, on a small brute force', () => {
		const s = { ...newGame({ players: 2, seed: 1 }), board: boardWith('BOARD', 7, 5), racks: [rack('AT'), rack('', 50)], bag: [] };
		const found = new Set(generateMoves(s, 0, trie).map((m) => m.tiles.map((t) => `${t.r},${t.c},${t.letter}`).sort().join('|')));
		const squares: [number, number][] = [];
		for (let r = 5; r <= 9; r++) for (let c = 3; c <= 11; c++) if (!s.board[`${r},${c}`]) squares.push([r, c]);
		const letters = [{ id: 1, letter: 'A' }, { id: 2, letter: 'T' }];
		const tryPlay = (tiles: { r: number; c: number; tileId: number; letter: string }[]) => {
			try {
				checkPlay(s, tiles, lexicon);
			} catch {
				return;
			}
			expect(found).toContain(tiles.map((t) => `${t.r},${t.c},${t.letter}`).sort().join('|'));
		};
		for (const [r, c] of squares) {
			for (const l of letters) {
				tryPlay([{ r, c, tileId: l.id, letter: l.letter }]);
				for (const [r2, c2] of squares) {
					if (r === r2 && c === c2) continue;
					const other = letters.find((x) => x !== l)!;
					tryPlay([{ r, c, tileId: l.id, letter: l.letter }, { r: r2, c: c2, tileId: other.id, letter: other.letter }]);
				}
			}
		}
	}, 30000);
});

describe('bot', () => {
	test('plays one of its top 3 moves, chosen by seed', () => {
		const s = { ...newGame({ players: 2, seed: 4 }), board: boardWith('BOARD', 7, 5), racks: [rack('TGIMELS'), rack('', 50)], bag: [] };
		const top = generateMoves(s, 0, trie).toSorted((a, b) => b.score - a.score).slice(0, 3).map((m) => m.score);
		const seen = new Set<number>();
		for (let seed = 0; seed < 30; seed++) {
			const action = chooseAction(s, 0, trie, seed);
			if (action.type !== 'place') throw new Error('expected a play');
			const score = checkPlay(s, action.tiles, lexicon).score;
			expect(top).toContain(score);
			seen.add(score);
		}
		expect(seen.size).toBeGreaterThan(1);
	});

	test('exchanges when it has no move and the bag allows, otherwise passes', () => {
		const stuck = { ...newGame({ players: 2, seed: 1 }), racks: [rack('VVV'), rack('', 50)] };
		const a = chooseAction(stuck, 0, trie, 1);
		expect(a.type).toBe('exchange');
		const low = { ...stuck, bag: stuck.bag.slice(0, 3) };
		expect(chooseAction(low, 0, trie, 1)).toEqual({ type: 'pass', seat: 0 });
	});

	test('two bots finish a whole game with every move valid, over several seeds', () => {
		for (let seed = 0; seed < 5; seed++) {
			let s = newGame({ players: 2, seed });
			let steps = 0;
			while (s.phase !== 'over' && steps < 500) {
				s = apply(s, chooseAction(s, s.current, trie, seed + steps), lexicon);
				steps++;
			}
			expect(s.phase).toBe('over');
			const tilesOnBoard = Object.keys(s.board).length;
			expect(tilesOnBoard + s.bag.length + s.racks.flat().length).toBe(100);
		}
	}, 60000);
});
