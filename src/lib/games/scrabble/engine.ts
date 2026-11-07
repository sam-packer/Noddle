import { RuleError, shuffle } from '../rng';
import type { Lexicon } from './lexicon';

export const SIZE = 15;
const CENTRE = 7;
const RACK_SIZE = 7;
const BINGO = 50;
/** Exchanging needs this many tiles left in the bag. */
export const MIN_BAG_TO_EXCHANGE = 7;
const MAX_SCORELESS = 6;

export const VALUES: Record<string, number> = {
	'?': 0, A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3,
	N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10
};

const DISTRIBUTION: Record<string, number> = {
	'?': 2, A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2,
	N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1
};

export const tileValue = (letter: string) => VALUES[letter] ?? 0;

export type Premium = 'TW' | 'DW' | 'TL' | 'DL';

export function premiumAt(r: number, c: number): Premium | null {
	const a = Math.min(r, 14 - r);
	const b = Math.min(c, 14 - c);
	const [p, q] = a < b ? [a, b] : [b, a];
	if ((p === 0 && q === 0) || (p === 0 && q === 7)) return 'TW';
	if (p === q && p >= 1 && p <= 4) return 'DW';
	if (p === 7 && q === 7) return 'DW';
	if ((p === 1 && q === 5) || (p === 5 && q === 5)) return 'TL';
	if ((p === 0 && q === 3) || (p === 2 && q === 6) || (p === 3 && q === 7) || (p === 6 && q === 6))
		return 'DL';
	return null;
}

export type Tile = { id: number; letter: string };
export type BoardTile = { letter: string; blank: boolean };
/** Squares are keyed "r,c". */
export type Board = Record<string, BoardTile>;
/** For a blank, letter is the letter it stands for. For any other tile it must be the tile's own. */
export type PlaceTile = { r: number; c: number; tileId: number; letter: string };

export type ScrabbleLast =
	| { seat: number; kind: 'place'; word: string; words: string[]; score: number; bingo: boolean }
	| { seat: number; kind: 'pass' }
	| { seat: number; kind: 'exchange'; count: number };

export type ScrabbleState = {
	game: 'scrabble';
	players: number;
	board: Board;
	racks: Tile[][];
	bag: Tile[];
	scores: number[];
	current: number;
	scoreless: number;
	phase: 'play' | 'over';
	winner: number | null;
	rng: number;
	last: ScrabbleLast | null;
};

export type ScrabbleAction =
	| { type: 'place'; seat: number; tiles: PlaceTile[] }
	| { type: 'pass'; seat: number }
	| { type: 'exchange'; seat: number; tileIds: number[] };

function fullBag(): Tile[] {
	const tiles: Tile[] = [];
	for (const [letter, count] of Object.entries(DISTRIBUTION)) {
		for (let i = 0; i < count; i++) tiles.push({ id: tiles.length + 1, letter });
	}
	return tiles;
}

export function newGame({ players, seed }: { players: number; seed: number }): ScrabbleState {
	if (!Number.isInteger(players) || players < 2 || players > 4) throw new RuleError('Scrabble needs 2 to 4 players');
	const shuffled = shuffle(fullBag(), seed >>> 0);
	const bag = shuffled.items;
	const racks = Array.from({ length: players }, () => bag.splice(-RACK_SIZE));
	return {
		game: 'scrabble',
		players,
		board: {},
		racks,
		bag,
		scores: Array(players).fill(0),
		current: 0,
		scoreless: 0,
		phase: 'play',
		winner: null,
		rng: shuffled.rng,
		last: null
	};
}

type Cell = { r: number; c: number; letter: string; fresh: boolean; blank: boolean };

/** Reads the whole word running through a square, in one direction, with the new tiles included. */
function wordThrough(board: Board, placed: Map<string, PlaceTile & { blank: boolean }>, r: number, c: number, dr: number, dc: number) {
	const at = (cr: number, cc: number) => {
		const key = `${cr},${cc}`;
		return placed.get(key) ?? board[key];
	};
	let [sr, sc] = [r, c];
	while (at(sr - dr, sc - dc)) {
		sr -= dr;
		sc -= dc;
	}
	const cells: Cell[] = [];
	for (let [cr, cc] = [sr, sc]; at(cr, cc); cr += dr, cc += dc) {
		const key = `${cr},${cc}`;
		const fresh = placed.get(key);
		const tile = fresh ?? board[key];
		cells.push({ r: cr, c: cc, letter: tile.letter, fresh: !!fresh, blank: tile.blank });
	}
	return cells;
}

function scoreWord(cells: Cell[]) {
	let sum = 0;
	let mult = 1;
	for (const cell of cells) {
		let v = cell.blank ? 0 : tileValue(cell.letter);
		if (cell.fresh) {
			const pr = premiumAt(cell.r, cell.c);
			if (pr === 'DL') v *= 2;
			if (pr === 'TL') v *= 3;
			if (pr === 'DW') mult *= 2;
			if (pr === 'TW') mult *= 3;
		}
		sum += v;
	}
	return sum * mult;
}

export type PlayVerdict = { main: string; words: string[]; score: number; bingo: boolean };

/**
 * Reads the words a set of connected tiles makes, with their score. Doesn't check the dictionary.
 * The move generator uses this too, so bots and players are scored by the same code.
 */
export function readPlay(board: Board, tiles: (PlaceTile & { blank: boolean })[]) {
	const placed = new Map(tiles.map((t) => [`${t.r},${t.c}`, t]));
	const rows = new Set(tiles.map((t) => t.r));
	const cols = new Set(tiles.map((t) => t.c));
	if (rows.size > 1 && cols.size > 1) throw new RuleError('Tiles must be in one line.');
	const first = tiles[0];
	const across =
		rows.size === 1 && (cols.size > 1 || wordThrough(board, placed, first.r, first.c, 0, 1).length > 1);
	const [dr, dc] = across ? [0, 1] : [1, 0];
	const main = wordThrough(board, placed, first.r, first.c, dr, dc);
	if (!tiles.every((t) => main.some((m) => m.r === t.r && m.c === t.c))) {
		throw new RuleError('Tiles must connect with no gaps.');
	}
	const words = [main];
	for (const t of tiles) {
		const cross = wordThrough(board, placed, t.r, t.c, dc, dr);
		if (cross.length > 1) words.push(cross);
	}
	const bingo = tiles.length === RACK_SIZE;
	return {
		cells: main,
		words,
		score: words.reduce((sum, w) => sum + scoreWord(w), 0) + (bingo ? BINGO : 0),
		bingo
	};
}

const text = (cells: Cell[]) => cells.map((c) => c.letter).join('');

/** Checks a whole play against the rules. Breaking one throws RuleError, with a reason to show. */
export function checkPlay(s: ScrabbleState, tiles: PlaceTile[], lexicon: Lexicon): PlayVerdict {
	if (!tiles.length) throw new RuleError('Place a tile first.');
	const rack = s.racks[s.current];
	const seen = new Set<string>();
	const usedIds = new Set<number>();
	const checked = tiles.map((t) => {
		const key = `${t.r},${t.c}`;
		if (!Number.isInteger(t.r) || !Number.isInteger(t.c) || t.r < 0 || t.r >= SIZE || t.c < 0 || t.c >= SIZE) {
			throw new RuleError("That square isn't on the board.");
		}
		if (s.board[key] || seen.has(key)) throw new RuleError('That square is taken.');
		seen.add(key);
		const tile = rack.find((x) => x.id === t.tileId);
		if (!tile || usedIds.has(t.tileId)) throw new RuleError("That tile isn't on your rack.");
		usedIds.add(t.tileId);
		const blank = tile.letter === '?';
		if (blank ? !/^[A-Z]$/.test(t.letter) : t.letter !== tile.letter) {
			throw new RuleError("That tile doesn't match.");
		}
		return { ...t, blank };
	});

	const read = readPlay(s.board, checked);
	const empty = Object.keys(s.board).length === 0;
	if (empty) {
		if (!tiles.some((t) => t.r === CENTRE && t.c === CENTRE)) {
			throw new RuleError('The first word must cover the centre square.');
		}
	} else if (!read.cells.some((c) => !c.fresh) && read.words.length === 1) {
		throw new RuleError('Your word has to connect to the board.');
	}
	for (const cells of read.words) {
		const word = text(cells);
		if (word.length < 2 || !lexicon.has(word)) throw new RuleError(`${word} isn't in the dictionary.`);
	}
	return { main: text(read.cells), words: read.words.map(text), score: read.score, bingo: read.bingo };
}

function refill(s: ScrabbleState, seat: number) {
	while (s.racks[seat].length < RACK_SIZE && s.bag.length) s.racks[seat].push(s.bag.pop()!);
}

const rackValue = (rack: Tile[]) => rack.reduce((sum, t) => sum + tileValue(t.letter), 0);

function finish(s: ScrabbleState, wentOut: number | null) {
	s.phase = 'over';
	const left = s.racks.map(rackValue);
	s.scores = s.scores.map((score, i) => score - left[i]);
	if (wentOut !== null) s.scores[wentOut] += left.reduce((a, b) => a + b, 0);
	const best = Math.max(...s.scores);
	const leaders = s.scores.flatMap((score, i) => (score === best ? [i] : []));
	s.winner = leaders.length === 1 ? leaders[0] : null;
}

function endTurn(s: ScrabbleState) {
	s.current = (s.current + 1) % s.players;
}

/** Returns the next state. The given state is never changed. Breaking the rules throws RuleError. */
export function apply(state: ScrabbleState, action: ScrabbleAction, lexicon: Lexicon): ScrabbleState {
	if (state.phase === 'over') throw new RuleError('The game is over.');
	if (action.seat !== state.current) throw new RuleError("It isn't your turn.");
	const seat = action.seat;

	if (action.type === 'place') {
		const verdict = checkPlay(state, action.tiles, lexicon);
		const s = structuredClone(state);
		for (const t of action.tiles) {
			const tile = s.racks[seat].find((x) => x.id === t.tileId)!;
			s.board[`${t.r},${t.c}`] = { letter: t.letter, blank: tile.letter === '?' };
		}
		const ids = new Set(action.tiles.map((t) => t.tileId));
		s.racks[seat] = s.racks[seat].filter((t) => !ids.has(t.id));
		s.scores[seat] += verdict.score;
		s.scoreless = 0;
		s.last = { seat, kind: 'place', word: verdict.main, words: verdict.words, score: verdict.score, bingo: verdict.bingo };
		refill(s, seat);
		if (!s.racks[seat].length && !s.bag.length) finish(s, seat);
		else endTurn(s);
		return s;
	}

	const s = structuredClone(state);
	if (action.type === 'pass') {
		s.last = { seat, kind: 'pass' };
	} else {
		if (s.bag.length < MIN_BAG_TO_EXCHANGE) throw new RuleError('Too few tiles left in the bag to exchange.');
		const ids = new Set(action.tileIds);
		if (!ids.size || ids.size !== action.tileIds.length) throw new RuleError('Choose the tiles to exchange.');
		const outgoing = s.racks[seat].filter((t) => ids.has(t.id));
		if (outgoing.length !== ids.size) throw new RuleError("That tile isn't on your rack.");
		s.racks[seat] = s.racks[seat].filter((t) => !ids.has(t.id));
		refill(s, seat);
		const r = shuffle([...s.bag, ...outgoing], s.rng);
		s.bag = r.items;
		s.rng = r.rng;
		s.last = { seat, kind: 'exchange', count: ids.size };
	}
	s.scoreless += 1;
	if (s.scoreless >= MAX_SCORELESS) finish(s, null);
	else endTurn(s);
	return s;
}

/**
 * The non-placing options for the current seat. Plays depend on the dictionary, so they come from
 * generateMoves in movegen.ts. Exchange is listed as swapping the whole rack, as the simplest form.
 */
export function legalActions(s: ScrabbleState): ScrabbleAction[] {
	if (s.phase === 'over') return [];
	const seat = s.current;
	const actions: ScrabbleAction[] = [{ type: 'pass', seat }];
	if (s.bag.length >= MIN_BAG_TO_EXCHANGE && s.racks[seat].length) {
		actions.push({ type: 'exchange', seat, tileIds: s.racks[seat].map((t) => t.id) });
	}
	return actions;
}

export type ScrabbleCan = { place: boolean; pass: boolean; exchange: boolean };

/** Everything one seat may see. Other racks, the bag and the seed never leave the engine. */
export type ScrabbleView = {
	game: 'scrabble';
	me: number;
	players: number;
	board: Board;
	rack: Tile[];
	rackCounts: number[];
	bagCount: number;
	scores: number[];
	current: number;
	scoreless: number;
	phase: ScrabbleState['phase'];
	winner: number | null;
	last: ScrabbleLast | null;
	can: ScrabbleCan;
};

export function viewFor(s: ScrabbleState, seat: number): ScrabbleView {
	const myTurn = s.phase === 'play' && s.current === seat;
	return {
		game: 'scrabble',
		me: seat,
		players: s.players,
		board: s.board,
		rack: s.racks[seat],
		rackCounts: s.racks.map((r) => r.length),
		bagCount: s.bag.length,
		scores: s.scores,
		current: s.current,
		scoreless: s.scoreless,
		phase: s.phase,
		winner: s.winner,
		last: s.last,
		can: { place: myTurn, pass: myTurn, exchange: myTurn && s.bag.length >= MIN_BAG_TO_EXCHANGE }
	};
}
