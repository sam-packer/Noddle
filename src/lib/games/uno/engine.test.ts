import { describe, expect, test } from 'bun:test';
import { apply, deckOf, legalActions, newGame, viewFor, type Card, type UnoAction, type UnoState } from './engine';
import { chooseAction } from './bot';

const card = (id: number, color: Card['color'], value: Card['value']): Card => ({ id, color, value });

/** A game with a known table. Everything not given is filled so the state stays valid. */
function table(over: Partial<UnoState>): UnoState {
	const g = newGame({ players: 3, seed: 1 });
	return {
		...g,
		hands: [[card(901, 'red', '1'), card(902, 'blue', '2')], [card(903, 'red', '3'), card(904, 'blue', '3')], [card(905, 'green', '3'), card(906, 'green', '4')]],
		discard: [{ ...card(900, 'red', '5'), by: null }],
		activeColor: 'red',
		...over
	};
}

function allCards(s: UnoState) {
	return [...s.hands.flat(), ...s.deck, ...s.discard];
}

describe('setup', () => {
	test('the deck has the standard 108 cards', () => {
		const deck = deckOf();
		expect(deck.length).toBe(108);
		expect(new Set(deck.map((c) => c.id)).size).toBe(108);
		expect(deck.filter((c) => c.value === 'wild').length).toBe(4);
		expect(deck.filter((c) => c.value === 'wild4').length).toBe(4);
		expect(deck.filter((c) => c.color === 'red').length).toBe(25);
		expect(deck.filter((c) => c.color === 'red' && c.value === '0').length).toBe(1);
		expect(deck.filter((c) => c.color === 'red' && c.value === 'skip').length).toBe(2);
	});

	test('deals 7 each and starts on a number card, for many seeds', () => {
		for (let seed = 0; seed < 200; seed++) {
			const g = newGame({ players: 4, seed });
			expect(g.hands.map((h) => h.length)).toEqual([7, 7, 7, 7]);
			expect(g.discard.length).toBe(1);
			expect(g.discard[0].value).toMatch(/^\d$/);
			expect(g.activeColor as string).toBe(g.discard[0].color);
			expect(allCards(g).length).toBe(108);
		}
	});

	test('rejects player counts outside 2 to 4', () => {
		expect(() => newGame({ players: 1, seed: 1 })).toThrow();
		expect(() => newGame({ players: 5, seed: 1 })).toThrow();
	});

	test('the same seed deals the same game', () => {
		expect(newGame({ players: 2, seed: 9 })).toEqual(newGame({ players: 2, seed: 9 }));
	});
});

describe('playing cards', () => {
	test('apply does not change the state it was given', () => {
		const s = table({});
		const copy = structuredClone(s);
		apply(s, { type: 'play', seat: 0, cardId: 901 });
		expect(s).toEqual(copy);
	});

	test('a card matching colour or value is legal, others are not', () => {
		const s = table({ hands: [[card(1, 'red', '9'), card(2, 'blue', '5'), card(3, 'blue', '9')], [card(4, 'red', '1')], [card(5, 'red', '2')]] });
		const ids = legalActions(s).flatMap((a) => (a.type === 'play' ? [a.cardId] : []));
		expect(ids).toEqual([1, 2]);
		expect(() => apply(s, { type: 'play', seat: 0, cardId: 3 })).toThrow();
	});

	test('it must be your turn and your card', () => {
		const s = table({});
		expect(() => apply(s, { type: 'play', seat: 1, cardId: 903 })).toThrow(/turn/i);
		expect(() => apply(s, { type: 'play', seat: 0, cardId: 903 })).toThrow();
	});

	test('wilds are always legal, need a colour, and offer one action per colour', () => {
		const s = table({ hands: [[card(1, 'wild', 'wild'), card(2, 'wild', 'wild4')], [card(4, 'red', '1')], [card(5, 'red', '2')]] });
		const plays = legalActions(s).filter((a) => a.type === 'play');
		expect(plays.length).toBe(8);
		expect(() => apply(s, { type: 'play', seat: 0, cardId: 1 })).toThrow(/colou?r/i);
		const after = apply(s, { type: 'play', seat: 0, cardId: 1, color: 'green' });
		expect(after.activeColor).toBe('green');
		expect(after.discard.at(-1)?.shown).toBe('green');
	});

	test('skip jumps a player', () => {
		const s = table({ hands: [[card(1, 'red', 'skip'), card(9, 'red', '1')], [card(4, 'red', '1')], [card(5, 'red', '2')]] });
		expect(apply(s, { type: 'play', seat: 0, cardId: 1 }).current).toBe(2);
	});

	test('reverse flips direction with 3 players and acts as skip with 2', () => {
		const three = table({ hands: [[card(1, 'red', 'reverse'), card(9, 'red', '1')], [card(4, 'red', '1')], [card(5, 'red', '2')]] });
		const after = apply(three, { type: 'play', seat: 0, cardId: 1 });
		expect(after.direction).toBe(-1);
		expect(after.current).toBe(2);
		const two = table({ players: 2, hands: [[card(1, 'red', 'reverse'), card(9, 'red', '1')], [card(4, 'red', '1')]] });
		const after2 = apply(two, { type: 'play', seat: 0, cardId: 1 });
		expect(after2.current).toBe(0);
	});

	test('draw two and wild four make the next player draw and lose their turn', () => {
		const s = table({ hands: [[card(1, 'red', 'draw2'), card(2, 'wild', 'wild4'), card(9, 'blue', '1')], [card(4, 'red', '1')], [card(5, 'red', '2')]] });
		const before = s.deck.length;
		const a = apply(s, { type: 'play', seat: 0, cardId: 1 });
		expect(a.hands[1].length).toBe(3);
		expect(a.current).toBe(2);
		expect(a.deck.length).toBe(before - 2);
		const b = apply(s, { type: 'play', seat: 0, cardId: 2, color: 'blue' });
		expect(b.hands[1].length).toBe(5);
		expect(b.current).toBe(2);
	});

	test('emptying a hand wins at once, even on an action card', () => {
		const s = table({ hands: [[card(1, 'red', 'draw2')], [card(4, 'red', '1')], [card(5, 'red', '2')]] });
		const after = apply(s, { type: 'play', seat: 0, cardId: 1 });
		expect(after.phase).toBe('over');
		expect(after.winner).toBe(0);
		expect(after.hands[1].length).toBe(1);
		expect(legalActions(after)).toEqual([]);
		expect(() => apply(after, { type: 'draw', seat: 1 })).toThrow();
	});
});

describe('drawing', () => {
	test('a drawn card that cannot play ends the turn', () => {
		const s = table({ deck: [card(50, 'blue', '9')], hands: [[card(1, 'blue', '1')], [card(4, 'red', '1')], [card(5, 'red', '2')]] });
		const after = apply(s, { type: 'draw', seat: 0 });
		expect(after.hands[0].map((c) => c.id)).toEqual([1, 50]);
		expect(after.current).toBe(1);
		expect(after.phase).toBe('play');
	});

	test('a drawn card that can play may be played or kept, and nothing else', () => {
		const s = table({ deck: [card(50, 'red', '9')], hands: [[card(1, 'red', '1'), card(2, 'blue', '1')], [card(4, 'red', '1')], [card(5, 'red', '2')]] });
		const after = apply(s, { type: 'draw', seat: 0 });
		expect(after.phase).toBe('drawn');
		expect(after.drawnId).toBe(50);
		expect(after.current).toBe(0);
		expect(legalActions(after).map((a) => a.type).sort()).toEqual(['pass', 'play']);
		expect(() => apply(after, { type: 'play', seat: 0, cardId: 1 })).toThrow();
		expect(() => apply(after, { type: 'draw', seat: 0 })).toThrow();
		const kept = apply(after, { type: 'pass', seat: 0 });
		expect(kept.current).toBe(1);
		expect(kept.drawnId).toBeNull();
		const played = apply(after, { type: 'play', seat: 0, cardId: 50 });
		expect(played.current).toBe(1);
		expect(played.discard.at(-1)?.id).toBe(50);
	});

	test('pass is only allowed after a draw', () => {
		expect(() => apply(table({}), { type: 'pass', seat: 0 })).toThrow();
	});

	test('the discard reshuffles into the deck when it runs out, keeping the top card', () => {
		const s = table({
			deck: [],
			discard: [
				{ ...card(70, 'blue', '1'), by: 0 },
				{ ...card(71, 'wild', 'wild'), by: 1, shown: 'green' },
				{ ...card(72, 'red', '5'), by: 2 }
			]
		});
		const after = apply(s, { type: 'draw', seat: 0 });
		expect(after.discard.map((c) => c.id)).toEqual([72]);
		expect(after.deck.length + after.hands[0].length).toBe(2 + 2);
		const reshuffled = [...after.deck, ...after.hands[0]].find((c) => c.id === 71) as Record<string, unknown>;
		expect(reshuffled.shown).toBeUndefined();
		expect(reshuffled.by).toBeUndefined();
	});

	test('with no cards anywhere to draw, the turn simply passes', () => {
		const s = table({ deck: [], discard: [{ ...card(72, 'red', '5'), by: 2 }], hands: [[card(1, 'blue', '1')], [card(4, 'red', '1')], [card(5, 'red', '2')]] });
		const after = apply(s, { type: 'draw', seat: 0 });
		expect(after.current).toBe(1);
		expect(after.hands[0].length).toBe(1);
	});
});

describe('whole games', () => {
	test('random legal play always finishes, conserves all 108 cards and stays legal', () => {
		for (let seed = 0; seed < 150; seed++) {
			const players = 2 + (seed % 3);
			let s = newGame({ players, seed });
			let rng = seed + 1;
			let steps = 0;
			while (s.phase !== 'over' && steps < 20000) {
				const options = legalActions(s);
				expect(options.length).toBeGreaterThan(0);
				rng = (rng * 1103515245 + 12345) >>> 0;
				s = apply(s, options[rng % options.length]);
				steps++;
				expect(allCards(s).length).toBe(108);
			}
			expect(s.phase).toBe('over');
			expect(s.hands[s.winner!].length).toBe(0);
		}
	});

	test('bots only ever choose legal actions and finish games', () => {
		for (let seed = 0; seed < 100; seed++) {
			let s = newGame({ players: 2 + (seed % 3), seed });
			let steps = 0;
			while (s.phase !== 'over' && steps < 20000) {
				const action = chooseAction(s, s.current);
				expect(legalActions(s)).toContainEqual(action);
				s = apply(s, action);
				steps++;
			}
			expect(s.phase).toBe('over');
		}
	});
});

describe('bot preferences', () => {
	const pick = (s: UnoState) => chooseAction(s, 0) as Extract<UnoAction, { type: 'play' }>;

	test('favours its most common colour', () => {
		const s = table({ hands: [[card(1, 'red', '1'), card(2, 'blue', '5'), card(3, 'blue', '6'), card(4, 'blue', '7')], [card(5, 'red', '1'), card(6, 'red', '1'), card(7, 'red', '1')], [card(8, 'red', '2')]], discard: [{ ...card(900, 'red', '5'), by: null }] });
		expect(pick(s).cardId).toBe(2);
	});

	test('plays wilds last', () => {
		const s = table({ hands: [[card(1, 'wild', 'wild'), card(2, 'red', '5')], [card(5, 'red', '1'), card(6, 'red', '1'), card(7, 'red', '1')], [card(8, 'red', '2')]] });
		expect(pick(s).cardId).toBe(2);
	});

	test('reaches for an action card when the next player has 2 or fewer cards', () => {
		const hand = [card(1, 'red', '4'), card(2, 'red', 'draw2'), card(3, 'red', '6')];
		const near = table({ hands: [hand, [card(5, 'red', '1'), card(6, 'red', '1')], [card(8, 'red', '2')]] });
		expect(pick(near).cardId).toBe(2);
		const far = table({ hands: [hand, [card(5, 'red', '1'), card(6, 'red', '1'), card(7, 'red', '1')], [card(8, 'red', '2')]] });
		expect(pick(far).cardId).not.toBe(2);
	});

	test('names its most common colour when it plays a wild', () => {
		const s = table({ hands: [[card(1, 'wild', 'wild'), card(2, 'green', '2'), card(3, 'green', '3'), card(4, 'blue', '3')], [card(5, 'red', '1')], [card(8, 'red', '2')]] });
		const action = pick(s);
		expect(action.cardId).toBe(1);
		expect(action.color).toBe('green');
	});

	test('draws with nothing to play, and plays a card it just drew', () => {
		const s = table({ deck: [card(50, 'red', '9')], hands: [[card(1, 'blue', '1')], [card(5, 'red', '1')], [card(8, 'red', '2')]] });
		expect(chooseAction(s, 0).type).toBe('draw');
		const drawn = apply(s, { type: 'draw', seat: 0 });
		expect(chooseAction(drawn, 0)).toEqual({ type: 'play', seat: 0, cardId: 50 });
	});
});

describe('per-seat views', () => {
	test('show your hand, only counts for others, and nothing about the deck or seed', () => {
		const s = newGame({ players: 3, seed: 5 });
		const v = viewFor(s, 1);
		expect(v.me).toBe(1);
		expect(v.hand).toEqual(s.hands[1]);
		expect(v.counts).toEqual([7, 7, 7]);
		const text = JSON.stringify(v);
		expect(text).not.toContain('"rng"');
		expect(text).not.toContain('"deck"');
		expect(text).not.toContain('"hands"');
		const visible = new Set([...v.hand.map((c) => c.id), ...v.discard.map((c) => c.id)]);
		for (const c of [...s.hands[0], ...s.hands[2], ...s.deck]) {
			if (visible.has(c.id)) throw new Error(`card ${c.id} leaked`);
			expect(text).not.toContain(`"id":${c.id},`);
		}
	});

	test('a draw shows other players a count but not the card', () => {
		const s = table({ deck: [card(50, 'red', '9')] });
		const after = apply(s, { type: 'draw', seat: 0 });
		const other = JSON.stringify(viewFor(after, 1));
		expect(other).not.toContain('"id":50');
		expect(viewFor(after, 1).drawnId).toBeNull();
		expect(viewFor(after, 0).drawnId).toBe(50);
		expect(viewFor(after, 1).last).toEqual({ seat: 0, kind: 'draw', count: 1 });
	});

	test('legal lists only your own options, and only on your turn', () => {
		const s = table({});
		expect(viewFor(s, 1).legal).toEqual({ cards: [], draw: false, keep: false });
		const mine = viewFor(s, 0).legal;
		expect(mine.cards).toEqual([901]);
		expect(mine.draw).toBe(true);
	});

	test('only recent discards are sent', () => {
		const discard = Array.from({ length: 30 }, (_, i) => ({ ...card(200 + i, 'red', '5' as const), by: 0 }));
		expect(viewFor(table({ discard }), 0).discard.length).toBe(4);
	});
});
