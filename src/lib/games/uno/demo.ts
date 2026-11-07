import { RuleError } from '../rng';
import { apply, legalFor, newGame, type Card, type Color, type UnoLegal, type UnoState, type Value } from './engine';

/**
 * The scripted Uno run, played through the real engine with a rigged hand and rigged opponents.
 * The script picks the opponents' cards each turn, so whatever the player does, the next turn is
 * set up to have few legal cards, far apart in the hand.
 */
export type DemoUno = {
	state: UnoState;
	turn: number;
	drawQueue: { color: Color; value: Value }[];
	nextId: number;
};

export type DemoAction = { type: 'play'; cardId: number; color?: Color } | { type: 'draw' };

const SEATS = [1, 2, 3];
/** An opponent never gets this low, so the script can't accidentally win the game for one. */
const MIN_OPPONENT_CARDS = 2;
/** Well above every id the demo shows, so the unseen deck can never clash with a visible card. */
const HIDDEN_ID_BASE = 1000;

export function newDemoUno(): DemoUno {
	const base = newGame({ players: 4, seed: 1 });
	const hide = (c: Card): Card => ({ ...c, id: c.id + HIDDEN_ID_BASE });
	// No green in the hand, so a green top card later makes the Wild the only play.
	// Only the ends of the hand match the first top card, so legal cards sit far apart.
	const hand: Card[] = [
		{ id: 1, color: 'red', value: '3' },
		{ id: 2, color: 'blue', value: '7' },
		{ id: 3, color: 'yellow', value: '5' },
		{ id: 4, color: 'wild', value: 'wild' },
		{ id: 5, color: 'yellow', value: '2' },
		{ id: 6, color: 'yellow', value: '9' },
		{ id: 7, color: 'blue', value: '4' }
	];
	return {
		state: {
			...base,
			hands: [hand, ...base.hands.slice(1).map((h) => h.map(hide))],
			deck: base.deck.map(hide),
			discard: [{ id: 0, color: 'red', value: '4', by: null }],
			activeColor: 'red'
		},
		turn: 0,
		drawQueue: [
			{ color: 'red', value: '6' },
			{ color: 'blue', value: '1' },
			{ color: 'yellow', value: '8' }
		],
		nextId: 100
	};
}

/** What the script lets the player do. The Wild is held back until its turn, to keep targets few. */
export function demoLegal(d: DemoUno): UnoLegal {
	const legal = legalFor(d.state, 0);
	const hand = d.state.hands[0];
	return {
		cards: legal.cards.filter((id) => hand.find((c) => c.id === id)?.color !== 'wild' || d.turn === 2),
		draw: legal.draw,
		keep: false
	};
}

export const demoFinished = (d: DemoUno) => d.state.hands[0].length === 1;

/** The player's move. A drawn card is always kept, so a draw ends the turn at once. */
export function demoApply(d: DemoUno, action: DemoAction): DemoUno {
	const legal = demoLegal(d);
	if (action.type === 'draw') {
		if (!legal.draw) throw new RuleError("It isn't your turn");
		const queued = d.drawQueue[0] ?? { color: 'red' as Color, value: '1' as Value };
		const rigged: UnoState = {
			...d.state,
			deck: [...d.state.deck, { id: d.nextId, ...queued }]
		};
		let state = apply(rigged, { type: 'draw', seat: 0 });
		if (state.phase === 'drawn') state = apply(state, { type: 'pass', seat: 0 });
		return { ...d, state, drawQueue: d.drawQueue.slice(1), nextId: d.nextId + 1 };
	}
	if (!legal.cards.includes(action.cardId)) throw new RuleError("That card can't be played right now");
	return { ...d, state: apply(d.state, { type: 'play', seat: 0, cardId: action.cardId, color: action.color }) };
}

/** Sets up the next turn so the playable cards sit at opposite ends of the hand. */
function nextTop(d: DemoUno, turn: number): { color: Color; value: Value } {
	const hand = d.state.hands[0];
	if (turn === 2 && hand.some((c) => c.color === 'wild')) return { color: 'green', value: '8' };
	const plain = hand.filter((c) => c.color !== 'wild');
	if (plain.length === 0) return { color: d.state.activeColor, value: d.state.discard.at(-1)!.value };
	return { color: plain[0].color as Color, value: plain[plain.length - 1].value };
}

export type DemoStep = (() => DemoUno) & { seat: number; draws: boolean };

/**
 * One round of opponents: two play and one draws. Each play is legal, and the last sets up the next
 * turn. Run the steps in order. Each returns the demo as it stands after that opponent's move.
 */
export function demoOpponentTurn(d: DemoUno): DemoStep[] {
	const turn = d.turn + 1;
	const goal = nextTop(d, turn);
	const drawer = SEATS[turn % SEATS.length];
	const plays = [
		{ color: d.state.activeColor, value: goal.value },
		{ color: goal.color, value: goal.value }
	];
	let current: DemoUno = { ...d, turn };

	return SEATS.map((seat) => {
		const draws = seat === drawer;
		const run = () => {
			if (draws) {
				let state = apply(current.state, { type: 'draw', seat });
				if (state.phase === 'drawn') state = apply(state, { type: 'pass', seat });
				current = { ...current, state };
				return current;
			}
			const play = plays.shift()!;
			const state = structuredClone(current.state);
			const hand = state.hands[seat];
			while (hand.length < MIN_OPPONENT_CARDS + 1) hand.push(state.deck.pop()!);
			const id = current.nextId;
			hand[0] = { id, ...play };
			current = {
				...current,
				state: apply(state, { type: 'play', seat, cardId: id }),
				nextId: id + 1
			};
			return current;
		};
		return Object.assign(run, { seat, draws });
	});
}
