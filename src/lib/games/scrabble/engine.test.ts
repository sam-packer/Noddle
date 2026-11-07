import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	apply,
	checkPlay,
	legalActions,
	newGame,
	premiumAt,
	tileValue,
	viewFor,
	type PlaceTile,
	type ScrabbleState,
	type Tile
} from './engine';
import { textLexicon } from './lexicon';

const lexicon = textLexicon(readFileSync('static/dict/enable.txt', 'utf8'));

const tile = (id: number, letter: string): Tile => ({ id, letter });
const rack = (letters: string, from = 1) => [...letters].map((l, i) => tile(from + i, l));

/** A game with a known table. */
function table(over: Partial<ScrabbleState> = {}): ScrabbleState {
	return { ...newGame({ players: 2, seed: 1 }), racks: [rack('CATSDOG'), rack('EEEEEEE', 50)], ...over };
}

/** Lays a word from the rack, in the rack's letter order. */
function lay(s: ScrabbleState, word: string, r: number, c: number, across = true): PlaceTile[] {
	const pool = [...s.racks[s.current]];
	const tiles: PlaceTile[] = [];
	[...word].forEach((letter, i) => {
		const [tr, tc] = across ? [r, c + i] : [r + i, c];
		if (s.board[`${tr},${tc}`]) return;
		let at = pool.findIndex((t) => t.letter === letter);
		if (at < 0) at = pool.findIndex((t) => t.letter === '?');
		const t = pool.splice(at, 1)[0];
		tiles.push({ r: tr, c: tc, tileId: t.id, letter });
	});
	return tiles;
}

const boardWith = (word: string, r: number, c: number, across = true) =>
	Object.fromEntries(
		[...word].map((letter, i) => [across ? `${r},${c + i}` : `${r + i},${c}`, { letter, blank: false }])
	);

describe('setup', () => {
	test('the bag holds 100 tiles with the standard distribution', () => {
		const g = newGame({ players: 2, seed: 3 });
		const all = [...g.bag, ...g.racks.flat()];
		expect(all.length).toBe(100);
		expect(new Set(all.map((t) => t.id)).size).toBe(100);
		const count = (l: string) => all.filter((t) => t.letter === l).length;
		expect(count('?')).toBe(2);
		expect(count('E')).toBe(12);
		expect(count('A')).toBe(9);
		expect(count('Q')).toBe(1);
		expect(g.racks.map((r) => r.length)).toEqual([7, 7]);
		expect(g.bag.length).toBe(86);
	});

	test('the board has the standard premium squares', () => {
		const all: Record<string, number> = { TW: 0, DW: 0, TL: 0, DL: 0 };
		for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
			const p = premiumAt(r, c);
			if (p) all[p]++;
		}
		expect(all).toEqual({ TW: 8, DW: 17, TL: 12, DL: 24 });
		expect(premiumAt(7, 7)).toBe('DW');
		expect(premiumAt(0, 0)).toBe('TW');
		expect(premiumAt(0, 3)).toBe('DL');
		expect(premiumAt(1, 5)).toBe('TL');
	});

	test('tile values are the standard ones, and a blank is worth nothing', () => {
		expect(tileValue('Q')).toBe(10);
		expect(tileValue('E')).toBe(1);
		expect(tileValue('?')).toBe(0);
	});
});

describe('checking a play', () => {
	test('the first word must cover the centre', () => {
		const s = table();
		expect(() => checkPlay(s, lay(s, 'CAT', 0, 0), lexicon)).toThrow(/centre/i);
		expect(checkPlay(s, lay(s, 'CAT', 7, 5), lexicon).main).toBe('CAT');
	});

	test('a first word needs at least two letters', () => {
		const s = table();
		expect(() => checkPlay(s, lay(s, 'C', 7, 7), lexicon)).toThrow();
	});

	test('tiles must be in one line', () => {
		const s = table();
		const tiles = [
			{ r: 7, c: 7, tileId: 1, letter: 'C' },
			{ r: 8, c: 8, tileId: 2, letter: 'A' }
		];
		expect(() => checkPlay(s, tiles, lexicon)).toThrow('Tiles must be in one line.');
	});

	test('tiles must connect with no gaps', () => {
		const s = table();
		const tiles = [
			{ r: 7, c: 6, tileId: 1, letter: 'C' },
			{ r: 7, c: 8, tileId: 2, letter: 'A' }
		];
		expect(() => checkPlay(s, tiles, lexicon)).toThrow('Tiles must connect with no gaps.');
	});

	test('later words must connect to the board', () => {
		const s = table({ board: boardWith('BOARD', 7, 5) });
		expect(() => checkPlay(s, lay(s, 'CAT', 0, 0), lexicon)).toThrow('Your word has to connect to the board.');
	});

	test('every word formed must be in the dictionary, including cross words', () => {
		const s = table();
		expect(() => checkPlay(s, lay(s, 'TCA', 7, 5), lexicon)).toThrow("TCA isn't in the dictionary.");
		const crossed = table({ board: boardWith('BOARD', 7, 5) });
		expect(() => checkPlay(crossed, lay(crossed, 'CAT', 8, 5), lexicon)).toThrow(/isn't in the dictionary/);
	});

	test('a square that is taken, a repeated tile, or a tile not on your rack is rejected', () => {
		const s = table({ board: boardWith('BOARD', 7, 5) });
		expect(() => checkPlay(s, [{ r: 7, c: 5, tileId: 1, letter: 'C' }], lexicon)).toThrow();
		expect(() =>
			checkPlay(s, [{ r: 8, c: 5, tileId: 1, letter: 'C' }, { r: 8, c: 6, tileId: 1, letter: 'C' }], lexicon)
		).toThrow();
		expect(() => checkPlay(s, [{ r: 8, c: 5, tileId: 999, letter: 'C' }], lexicon)).toThrow();
	});

	test("a normal tile can't pretend to be another letter, and off-board squares are rejected", () => {
		const s = table({ board: boardWith('BOARD', 7, 5) });
		expect(() => checkPlay(s, [{ r: 8, c: 7, tileId: 1, letter: 'Z' }], lexicon)).toThrow();
		expect(() => checkPlay(s, [{ r: 15, c: 7, tileId: 1, letter: 'C' }], lexicon)).toThrow();
	});

	test('a blank must name a real letter', () => {
		const s = table({ racks: [rack('?ATSDOG'), rack('EEEEEEE', 50)] });
		const bad = lay(s, 'CAT', 7, 5).map((t) => (t.tileId === 1 ? { ...t, letter: '?' } : t));
		expect(() => checkPlay(s, bad, lexicon)).toThrow();
	});
});

describe('scoring', () => {
	test('CAT across the centre: double word', () => {
		const s = table();
		expect(checkPlay(s, lay(s, 'CAT', 7, 5), lexicon).score).toBe((3 + 1 + 1) * 2);
	});

	test('letter premiums and the existing tiles count', () => {
		const s = table({ board: boardWith('CAT', 7, 6), racks: [rack('SDOGEEE'), rack('EEEEEEE', 50)] });
		// CATS: the S on 7,9 has no premium, and the centre square under the A is already used.
		expect(checkPlay(s, lay(s, 'S', 7, 9), lexicon).score).toBe(3 + 1 + 1 + 1);
	});

	test('a blank scores nothing, though a premium under it still multiplies the word', () => {
		const s = table({ racks: [rack('?ATSDOG'), rack('EEEEEEE', 50)] });
		// C (blank) on 7,7 double word.
		expect(checkPlay(s, lay(s, 'CAT', 7, 7), lexicon).score).toBe((0 + 1 + 1) * 2);
	});

	test('cross words score as well as the main word', () => {
		const s = table({ board: boardWith('AT', 7, 7), racks: [rack('SOEEEEE'), rack('EEEEEEE', 50)] });
		const play = [{ r: 8, c: 7, tileId: 2, letter: 'O' }];
		expect(() => checkPlay(s, play, lexicon)).toThrow(/AO/);
		const hook = [{ r: 7, c: 9, tileId: 3, letter: 'E' }];
		expect(checkPlay(s, hook, lexicon).words).toEqual(['ATE']);
	});

	test('the demo: GIMLETS through the S of BOARDS scores 79 with the bingo', () => {
		const s = table({ board: boardWith('BOARD', 7, 5), racks: [rack('TGIMELS'), rack('', 50)], bag: [] });
		const result = checkPlay(s, lay(s, 'GIMLETS', 1, 10, false), lexicon);
		expect(result.words.sort()).toEqual(['BOARDS', 'GIMLETS']);
		expect(result.bingo).toBe(true);
		expect(result.score).toBe(79);
	});
});

describe('turns', () => {
	test('a play scores, refills the rack from the bag and moves the turn on', () => {
		const s = table();
		const before = s.bag.length;
		const after = apply(s, { type: 'place', seat: 0, tiles: lay(s, 'CAT', 7, 5) }, lexicon);
		expect(after.scores[0]).toBe(10);
		expect(after.racks[0].length).toBe(7);
		expect(after.bag.length).toBe(before - 3);
		expect(after.current).toBe(1);
		expect(after.board['7,5']).toEqual({ letter: 'C', blank: false });
		expect(after.scoreless).toBe(0);
		expect(after.last).toEqual({ seat: 0, kind: 'place', word: 'CAT', words: ['CAT'], score: 10, bingo: false });
	});

	test('apply leaves its input alone', () => {
		const s = table();
		const copy = structuredClone(s);
		apply(s, { type: 'place', seat: 0, tiles: lay(s, 'CAT', 7, 5) }, lexicon);
		expect(s).toEqual(copy);
	});

	test('a blank stays that letter on the board', () => {
		const s = table({ racks: [rack('?ATSDOG'), rack('EEEEEEE', 50)] });
		const after = apply(s, { type: 'place', seat: 0, tiles: lay(s, 'CAT', 7, 7) }, lexicon);
		expect(after.board['7,7']).toEqual({ letter: 'C', blank: true });
	});

	test("you can't play out of turn, and a rejected play changes nothing", () => {
		const s = table();
		expect(() => apply(s, { type: 'pass', seat: 1 }, lexicon)).toThrow(/turn/i);
		expect(() => apply(s, { type: 'place', seat: 0, tiles: lay(s, 'TCA', 7, 5) }, lexicon)).toThrow();
		expect(s.current).toBe(0);
	});

	test('an empty play is rejected', () => {
		expect(() => apply(table(), { type: 'place', seat: 0, tiles: [] }, lexicon)).toThrow();
	});

	test('exchange swaps tiles, ends the turn and scores nothing', () => {
		const s = table();
		const after = apply(s, { type: 'exchange', seat: 0, tileIds: [1, 2] }, lexicon);
		expect(after.racks[0].length).toBe(7);
		expect(after.racks[0].some((t) => t.id === 3)).toBe(true);
		expect(after.bag.length).toBe(s.bag.length);
		expect(after.current).toBe(1);
		expect(after.scoreless).toBe(1);
	});

	test('exchange keeps all 100 tiles in play, with none lost or duplicated', () => {
		const g = newGame({ players: 2, seed: 6 });
		const after = apply(g, { type: 'exchange', seat: 0, tileIds: g.racks[0].slice(0, 3).map((t) => t.id) }, lexicon);
		const all = [...after.bag, ...after.racks.flat()].map((t) => t.id);
		expect(new Set(all).size).toBe(100);
		expect(all.length).toBe(100);
	});

	test('exchange needs 7 tiles in the bag and real tiles from your rack', () => {
		const s = table();
		expect(() => apply({ ...s, bag: s.bag.slice(0, 6) }, { type: 'exchange', seat: 0, tileIds: [1] }, lexicon)).toThrow(/bag/i);
		expect(() => apply(s, { type: 'exchange', seat: 0, tileIds: [] }, lexicon)).toThrow();
		expect(() => apply(s, { type: 'exchange', seat: 0, tileIds: [999] }, lexicon)).toThrow();
		expect(() => apply(s, { type: 'exchange', seat: 0, tileIds: [1, 1] }, lexicon)).toThrow();
	});

	test('a play resets the scoreless count', () => {
		const s = table({ scoreless: 3 });
		expect(apply(s, { type: 'place', seat: 0, tiles: lay(s, 'CAT', 7, 5) }, lexicon).scoreless).toBe(0);
	});
});

describe('ending', () => {
	test('going out with an empty bag ends the game with the rack adjustment', () => {
		const s = table({
			board: boardWith('BOARD', 7, 5),
			racks: [rack('S'), rack('QZ', 50)],
			bag: [],
			scores: [10, 12]
		});
		const after = apply(s, { type: 'place', seat: 0, tiles: lay(s, 'S', 7, 10) }, lexicon);
		expect(after.phase).toBe('over');
		const word = 3 + 1 + 1 + 1 + 2 + 1;
		expect(after.scores[0]).toBe(10 + word + 20);
		expect(after.scores[1]).toBe(12 - 20);
		expect(after.winner).toBe(0);
	});

	test('six scoreless turns end the game, and everyone loses their rack value', () => {
		let s = table({ racks: [rack('Q'), rack('A', 50)], scores: [20, 15] });
		for (let i = 0; i < 6; i++) {
			expect(s.phase).toBe('play');
			s = apply(s, { type: 'pass', seat: s.current }, lexicon);
		}
		expect(s.phase).toBe('over');
		expect(s.scores).toEqual([10, 14]);
		expect(s.winner).toBe(1);
	});

	test('a tie has no winner', () => {
		let s = table({ racks: [rack('A'), rack('A', 50)], scores: [5, 5] });
		for (let i = 0; i < 6; i++) s = apply(s, { type: 'pass', seat: s.current }, lexicon);
		expect(s.phase).toBe('over');
		expect(s.winner).toBeNull();
	});

	test('nothing can be played once the game is over', () => {
		let s = table();
		for (let i = 0; i < 6; i++) s = apply(s, { type: 'pass', seat: s.current }, lexicon);
		expect(() => apply(s, { type: 'pass', seat: s.current }, lexicon)).toThrow();
		expect(legalActions(s)).toEqual([]);
	});
});

describe('per-seat views', () => {
	test('never include another rack, the bag contents or the seed', () => {
		const s = newGame({ players: 2, seed: 8 });
		const v = viewFor(s, 0);
		expect(v.rack).toEqual(s.racks[0]);
		expect(v.rackCounts).toEqual([7, 7]);
		expect(v.bagCount).toBe(86);
		const text = JSON.stringify(v);
		expect(text).not.toContain('"rng"');
		expect(text).not.toContain('"bag"');
		expect(text).not.toContain('"racks"');
		for (const t of [...s.racks[1], ...s.bag]) expect(text).not.toContain(`"id":${t.id},`);
	});

	test('an exchange tells the other player only how many', () => {
		const s = table();
		const after = apply(s, { type: 'exchange', seat: 0, tileIds: [1, 2] }, lexicon);
		expect(viewFor(after, 1).last).toEqual({ seat: 0, kind: 'exchange', count: 2 });
	});

	test('says whether you can pass or exchange', () => {
		const s = table();
		expect(viewFor(s, 0).can).toEqual({ place: true, pass: true, exchange: true });
		expect(viewFor(s, 1).can).toEqual({ place: false, pass: false, exchange: false });
		expect(viewFor({ ...s, bag: s.bag.slice(0, 6) }, 0).can.exchange).toBe(false);
	});
});
