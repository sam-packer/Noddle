import { nextInt } from '../rng';
import { MIN_BAG_TO_EXCHANGE, type ScrabbleAction, type ScrabbleState } from './engine';
import type { Trie } from './lexicon';
import { generateMoves } from './movegen';

const TOP_MOVES = 3;

/** Picks at random from its best few moves, so it can be beaten. */
export function chooseAction(s: ScrabbleState, seat: number, trie: Trie, seed: number): ScrabbleAction {
	const moves = generateMoves(s, seat, trie).sort((a, b) => b.score - a.score);
	if (moves.length) {
		const pick = nextInt(seed >>> 0, Math.min(TOP_MOVES, moves.length)).value;
		return { type: 'place', seat, tiles: moves[pick].tiles };
	}
	if (s.bag.length >= MIN_BAG_TO_EXCHANGE && s.racks[seat].length) {
		return { type: 'exchange', seat, tileIds: s.racks[seat].map((t) => t.id) };
	}
	return { type: 'pass', seat };
}
