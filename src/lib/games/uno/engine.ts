import { RuleError, shuffle } from '../rng';

export const COLORS = ['red', 'blue', 'green', 'yellow'] as const;
export type Color = (typeof COLORS)[number];
export type Value =
	| '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
	| 'skip' | 'reverse' | 'draw2' | 'wild' | 'wild4';
export type Card = { id: number; color: Color | 'wild'; value: Value };
/** A played card: who played it, and the colour a wild was turned into. */
export type PlayedCard = Card & { by: number | null; shown?: Color };

export type LastMove =
	| { seat: number; kind: 'play'; card: Card; color?: Color; victim?: number; drew?: number }
	| { seat: number; kind: 'draw'; count: number }
	| { seat: number; kind: 'pass' };

export type UnoState = {
	game: 'uno';
	players: number;
	hands: Card[][];
	deck: Card[];
	discard: PlayedCard[];
	activeColor: Color;
	current: number;
	direction: 1 | -1;
	phase: 'play' | 'drawn' | 'over';
	/** The card just drawn, which is the only one that may be played in the 'drawn' phase. */
	drawnId: number | null;
	winner: number | null;
	rng: number;
	last: LastMove | null;
};

export type UnoAction =
	| { type: 'play'; seat: number; cardId: number; color?: Color }
	| { type: 'draw'; seat: number }
	| { type: 'pass'; seat: number };

const HAND_SIZE = 7;
const VIEW_DISCARDS = 4;

export function deckOf(): Card[] {
	const cards: Omit<Card, 'id'>[] = [];
	for (const color of COLORS) {
		cards.push({ color, value: '0' });
		for (const value of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'] as const) {
			cards.push({ color, value }, { color, value });
		}
	}
	for (let i = 0; i < 4; i++) cards.push({ color: 'wild', value: 'wild' }, { color: 'wild', value: 'wild4' });
	return cards.map((c, i) => ({ ...c, id: i + 1 }));
}

const COLOR_ORDER: Card['color'][] = [...COLORS, 'wild'];

/** Groups a hand by colour, so a long one is easy to page through. */
export function sortHand(hand: Card[]) {
	return [...hand].sort(
		(a, b) => COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) || a.value.localeCompare(b.value) || a.id - b.id
	);
}

const isNumber = (c: Card) => /^\d$/.test(c.value);
export const isWild = (c: Card) => c.color === 'wild';

export function newGame({ players, seed }: { players: number; seed: number }): UnoState {
	if (!Number.isInteger(players) || players < 2 || players > 4) throw new RuleError('bad-setup', 'Uno needs 2 to 4 players');
	const shuffled = shuffle(deckOf(), seed >>> 0);
	const deck = shuffled.items;
	const hands = Array.from({ length: players }, () => deck.splice(-HAND_SIZE));
	// Redraw until the first card is a number. The rejects go back under the deck.
	let first = deck.pop()!;
	while (!isNumber(first)) {
		deck.unshift(first);
		first = deck.pop()!;
	}
	return {
		game: 'uno',
		players,
		hands,
		deck,
		discard: [{ ...first, by: null }],
		activeColor: first.color as Color,
		current: 0,
		direction: 1,
		phase: 'play',
		drawnId: null,
		winner: null,
		rng: shuffled.rng,
		last: null
	};
}

export function canPlay(s: Pick<UnoState, 'discard' | 'activeColor'>, card: Card) {
	if (isWild(card)) return true;
	return card.color === s.activeColor || card.value === s.discard[s.discard.length - 1].value;
}

export function legalActions(s: UnoState): UnoAction[] {
	if (s.phase === 'over') return [];
	const seat = s.current;
	const playable =
		s.phase === 'drawn'
			? s.hands[seat].filter((c) => c.id === s.drawnId)
			: s.hands[seat].filter((c) => canPlay(s, c));
	const plays = playable.flatMap<UnoAction>((c) =>
		isWild(c)
			? COLORS.map((color) => ({ type: 'play' as const, seat, cardId: c.id, color }))
			: [{ type: 'play' as const, seat, cardId: c.id }]
	);
	return [...plays, s.phase === 'drawn' ? { type: 'pass', seat } : { type: 'draw', seat }];
}

function nextSeat(s: UnoState, from: number, steps = 1) {
	return (((from + s.direction * steps) % s.players) + s.players) % s.players;
}

/** Draws up to n cards, reshuffling the discard when the deck runs out. */
function drawInto(s: UnoState, seat: number, n: number) {
	const drawn: Card[] = [];
	for (let i = 0; i < n; i++) {
		if (!s.deck.length && s.discard.length > 1) {
			const top = s.discard.pop()!;
			const returned = s.discard.map(({ id, color, value }): Card => ({ id, color, value }));
			const r = shuffle(returned, s.rng);
			s.deck = r.items;
			s.rng = r.rng;
			s.discard = [top];
		}
		const card = s.deck.pop();
		if (!card) break;
		s.hands[seat].push(card);
		drawn.push(card);
	}
	return drawn;
}

/** Returns the next state. The given state is never changed. Breaking the rules throws RuleError. */
export function apply(state: UnoState, action: UnoAction): UnoState {
	if (state.phase === 'over') throw new RuleError('game-over', 'The game is over');
	if (action.seat !== state.current) throw new RuleError('not-your-turn', "It isn't your turn");
	const s = structuredClone(state);
	const seat = action.seat;

	if (action.type === 'draw') {
		if (s.phase !== 'play') throw new RuleError('already-drew', 'You already drew a card');
		const [card] = drawInto(s, seat, 1);
		s.last = { seat, kind: 'draw', count: card ? 1 : 0 };
		if (card && canPlay(s, card)) {
			s.phase = 'drawn';
			s.drawnId = card.id;
		} else {
			s.current = nextSeat(s, seat);
		}
		return s;
	}

	if (action.type === 'pass') {
		if (s.phase !== 'drawn') throw new RuleError('draw-first', 'You can only pass after drawing a card');
		s.phase = 'play';
		s.drawnId = null;
		s.last = { seat, kind: 'pass' };
		s.current = nextSeat(s, seat);
		return s;
	}

	const index = s.hands[seat].findIndex((c) => c.id === action.cardId);
	if (index < 0) throw new RuleError('not-your-card', "You don't have that card");
	const card = s.hands[seat][index];
	if (s.phase === 'drawn' && card.id !== s.drawnId) throw new RuleError('play-drawn-card', 'You can only play the card you drew');
	if (!canPlay(s, card)) throw new RuleError('card-mismatch', "That card doesn't match");
	if (isWild(card) && !COLORS.includes(action.color as Color)) throw new RuleError('pick-colour', 'Pick a colour for the wild');

	s.hands[seat].splice(index, 1);
	const played: PlayedCard = { ...card, by: seat };
	if (isWild(card)) played.shown = action.color;
	s.discard.push(played);
	s.activeColor = isWild(card) ? action.color! : (card.color as Color);
	s.phase = 'play';
	s.drawnId = null;
	const last: Extract<LastMove, { kind: 'play' }> = { seat, kind: 'play', card };
	if (isWild(card)) last.color = action.color;
	s.last = last;

	if (s.hands[seat].length === 0) {
		s.phase = 'over';
		s.winner = seat;
		return s;
	}

	if (card.value === 'skip' || (card.value === 'reverse' && s.players === 2)) {
		last.victim = nextSeat(s, seat);
		s.current = nextSeat(s, seat, 2);
	} else if (card.value === 'reverse') {
		s.direction = s.direction === 1 ? -1 : 1;
		s.current = nextSeat(s, seat);
	} else if (card.value === 'draw2' || card.value === 'wild4') {
		const victim = nextSeat(s, seat);
		last.victim = victim;
		last.drew = drawInto(s, victim, card.value === 'draw2' ? 2 : 4).length;
		s.current = nextSeat(s, seat, 2);
	} else {
		s.current = nextSeat(s, seat);
	}
	return s;
}

export type UnoLegal = { cards: number[]; draw: boolean; keep: boolean };

/** Everything one seat may see. Other hands, the deck and the seed never leave the engine. */
export type UnoView = {
	game: 'uno';
	me: number;
	players: number;
	hand: Card[];
	counts: number[];
	discard: PlayedCard[];
	deckCount: number;
	activeColor: Color;
	current: number;
	direction: 1 | -1;
	phase: UnoState['phase'];
	drawnId: number | null;
	winner: number | null;
	last: LastMove | null;
	legal: UnoLegal;
};

export function legalFor(s: UnoState, seat: number): UnoLegal {
	if (s.phase === 'over' || s.current !== seat) return { cards: [], draw: false, keep: false };
	const actions = legalActions(s);
	return {
		cards: [...new Set(actions.flatMap((a) => (a.type === 'play' ? [a.cardId] : [])))],
		draw: actions.some((a) => a.type === 'draw'),
		keep: actions.some((a) => a.type === 'pass')
	};
}

export function viewFor(s: UnoState, seat: number): UnoView {
	return {
		game: 'uno',
		me: seat,
		players: s.players,
		hand: s.hands[seat],
		counts: s.hands.map((h) => h.length),
		discard: s.discard.slice(-VIEW_DISCARDS),
		deckCount: s.deck.length,
		activeColor: s.activeColor,
		current: s.current,
		direction: s.direction,
		phase: s.phase,
		drawnId: s.current === seat ? s.drawnId : null,
		winner: s.winner,
		last: s.last,
		legal: legalFor(s, seat)
	};
}
