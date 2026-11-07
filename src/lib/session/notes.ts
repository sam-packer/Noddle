import type { Card, LastMove } from '../games/uno/engine';
import type { ScrabbleLast } from '../games/scrabble/engine';

const VALUE_NAMES: Partial<Record<Card['value'], string>> = {
	skip: 'Skip',
	reverse: 'Reverse',
	draw2: 'Draw 2',
	wild: 'Wild',
	wild4: 'Wild Draw 4'
};

export function cardName(card: Card) {
	const value = VALUE_NAMES[card.value] ?? card.value;
	return card.color === 'wild' ? value : `${card.color} ${value}`;
}

const who = (seat: number, names: string[], me: number) => (seat === me ? 'You' : names[seat]);

/** Sends a line about the last move, in plain words, naming the player. */
export function unoNote(last: LastMove | null, names: string[], me: number, counts: number[]) {
	if (!last) return '';
	const actor = who(last.seat, names, me);
	const you = last.seat === me;
	let text = '';
	if (last.kind === 'draw') text = last.count ? `${actor} ${you ? 'draw' : 'draws'}` : `${actor} can't draw`;
	else if (last.kind === 'pass') text = `${actor} ${you ? 'keep' : 'keeps'} the card`;
	else {
		text = `${actor} ${you ? 'play' : 'plays'} ${cardName(last.card)}`;
		if (last.color) text += `, choosing ${last.color}`;
		if (last.victim !== undefined) {
			const victim = who(last.victim, names, me);
			const yours = last.victim === me;
			if (last.drew !== undefined) text += `. ${victim} ${yours ? 'draw' : 'draws'} ${last.drew}`;
			else text += `. ${victim} ${yours ? 'are' : 'is'} skipped`;
		}
	}
	return counts[last.seat] === 1 ? `${text}. UNO!` : text;
}

export function unoEnded(winner: number | null, names: string[], me: number) {
	if (winner === me) return { title: 'You win!', text: 'Nice game.', won: true };
	return { title: `${winner === null ? 'Nobody' : names[winner]} wins`, text: 'Good game.' };
}

export function scrabbleNote(last: ScrabbleLast | null, names: string[], me: number) {
	if (!last) return '';
	const actor = who(last.seat, names, me);
	if (last.kind === 'pass') return `${actor} passed`;
	if (last.kind === 'exchange') {
		return `${actor} swapped ${last.count} ${last.count === 1 ? 'tile' : 'tiles'}`;
	}
	return `${actor} played ${last.word} for ${last.score} points${last.bingo ? ', with the bingo!' : ''}`;
}

export function scrabbleEnded(scores: number[], winner: number | null, names: string[], me: number) {
	const table = scores.map((score, i) => `${who(i, names, me)} ${score}`).join(', ');
	if (winner === null) return { title: "It's a tie", text: table };
	if (winner === me) return { title: 'You win!', text: table, won: true };
	return { title: `${names[winner]} wins`, text: table };
}
