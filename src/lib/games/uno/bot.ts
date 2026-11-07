import { COLORS, isWild, legalActions, type Card, type Color, type UnoAction, type UnoState } from './engine';

const ACTION_VALUES = new Set(['skip', 'reverse', 'draw2', 'wild4']);

function favouriteColor(hand: Card[]): Color {
	const count = (color: Color) => hand.filter((c) => c.color === color).length;
	return COLORS.reduce((best, color) => (count(color) > count(best) ? color : best));
}

/**
 * Picks a legal action: favours its most common colour, reaches for action cards when the next
 * player is close to winning, and keeps wilds for last. Decided only from the bot's own hand and
 * what every player can see.
 */
export function chooseAction(s: UnoState, seat: number): UnoAction {
	const hand = s.hands[seat];
	const favourite = favouriteColor(hand);
	const next = (((seat + s.direction) % s.players) + s.players) % s.players;
	const threatened = s.hands[next].length <= 2;
	const options = legalActions(s).filter((a) => a.type !== 'play' || !a.color || a.color === favourite);

	let best: UnoAction | undefined;
	let bestScore = -Infinity;
	for (const action of options) {
		if (action.type !== 'play') continue;
		const card = hand.find((c) => c.id === action.cardId)!;
		let score = 0;
		if (isWild(card)) score -= 10;
		else score += hand.filter((c) => c.color === card.color).length;
		if (threatened && ACTION_VALUES.has(card.value)) score += 100;
		if (score > bestScore) {
			bestScore = score;
			best = action;
		}
	}
	return best ?? options.find((a) => a.type !== 'play')!;
}
