import { describe, expect, test } from 'bun:test';
import { demoApply, demoFinished, demoLegal, demoOpponentTurn, newDemoUno, type DemoUno } from './demo';
import { COLORS, canPlay } from './engine';

/** Every card or draw the player could choose on this turn. */
function choices(d: DemoUno) {
	const legal = demoLegal(d);
	const hand = d.state.hands[0];
	const out: { type: 'play' | 'draw'; cardId?: number; color?: (typeof COLORS)[number] }[] = [];
	for (const id of legal.cards) {
		const card = hand.find((c) => c.id === id)!;
		if (card.color === 'wild') for (const color of COLORS) out.push({ type: 'play', cardId: id, color });
		else out.push({ type: 'play', cardId: id });
	}
	if (legal.draw) out.push({ type: 'draw' });
	return out;
}

function runOpponents(d: DemoUno) {
	let next = d;
	for (const step of demoOpponentTurn(next)) next = step();
	return next;
}

describe('opening', () => {
	test('matches the script: the fixed hand, a red 4 on top, and 3 opponents with 7 cards', () => {
		const d = newDemoUno();
		const hand = d.state.hands[0].map((c) => `${c.id}:${c.color} ${c.value}`);
		expect(hand).toEqual([
			'1:red 3', '2:blue 7', '3:yellow 5', '4:wild wild', '5:yellow 2', '6:yellow 9', '7:blue 4'
		]);
		expect(d.state.discard.at(-1)).toMatchObject({ id: 0, color: 'red', value: '4' });
		expect(d.state.hands.slice(1).map((h) => h.length)).toEqual([7, 7, 7]);
	});

	test('only the two ends of the hand are playable, plus the draw pile', () => {
		const legal = demoLegal(newDemoUno());
		expect(legal.cards).toEqual([1, 7]);
		expect(legal.draw).toBe(true);
		expect(legal.keep).toBe(false);
	});

	test('the Wild is held back until its turn, when it becomes the only card to play', () => {
		let d = newDemoUno();
		d = runOpponents(demoApply(d, { type: 'play', cardId: 1 }));
		expect(demoLegal(d).cards).not.toContain(4);
		d = runOpponents(demoApply(d, { type: 'play', cardId: demoLegal(d).cards[0] }));
		expect(d.turn).toBe(2);
		expect(demoLegal(d).cards).toEqual([4]);
	});
});

describe('a turn', () => {
	test('two opponents play and one draws, and each play follows the real rules', () => {
		let d = demoApply(newDemoUno(), { type: 'play', cardId: 1 });
		const before = d.state.hands.map((h) => h.length);
		const steps = demoOpponentTurn(d);
		expect(steps.length).toBe(3);
		for (const step of steps) d = step();
		const after = d.state.hands.map((h) => h.length);
		expect(after.slice(1).reduce((a, b) => a + b, 0)).toBe(before.slice(1).reduce((a, b) => a + b, 0) - 1);
		expect(d.state.current).toBe(0);
	});

	test('drawing ends the turn straight away, even with a card that could play', () => {
		const d = demoApply(newDemoUno(), { type: 'draw' });
		expect(d.state.hands[0].at(-1)).toMatchObject({ color: 'red', value: '6' });
		expect(d.state.phase).toBe('play');
		expect(d.state.current).toBe(1);
	});

	test("a card the script doesn't allow is refused", () => {
		expect(() => demoApply(newDemoUno(), { type: 'play', cardId: 2 })).toThrow();
		expect(() => demoApply(newDemoUno(), { type: 'play', cardId: 4, color: 'red' })).toThrow();
	});
});

describe('every route through the script', () => {
	test('reaches one card left with opponents still in the game', () => {
		const MAX_DRAWS = 3;
		let routes = 0;
		// Routes that reach the same position continue identically, so each is walked once.
		const seen = new Set<string>();
		const walk = (d: DemoUno, draws: number, depth: number) => {
			const { hands, discard, activeColor } = d.state;
			const key = [draws, d.turn, activeColor, discard.at(-1)!.value, hands[0].map((c) => c.id), hands.map((h) => h.length)].join('/');
			if (seen.has(key)) return;
			seen.add(key);
			expect(depth).toBeLessThan(30);
			if (demoFinished(d)) {
				routes++;
				expect(d.state.hands[0].length).toBe(1);
				expect(d.state.phase).not.toBe('over');
				return;
			}
			const options = choices(d);
			expect(options.some((o) => o.type === 'play')).toBe(true);
			for (const option of options) {
				if (option.type === 'draw' && draws >= MAX_DRAWS) continue;
				const after = demoApply(d, option as Parameters<typeof demoApply>[1]);
				if (demoFinished(after)) {
					walk(after, draws, depth + 1);
					continue;
				}
				let next = after;
				for (const step of demoOpponentTurn(next)) {
					next = step();
					expect(next.state.phase).not.toBe('over');
				}
				for (const hand of next.state.hands.slice(1)) expect(hand.length).toBeGreaterThanOrEqual(1);
				const top = next.state.discard.at(-1)!;
				expect(canPlay(next.state, top)).toBe(true);
				walk(next, draws + (option.type === 'draw' ? 1 : 0), depth + 1);
			}
		};
		walk(newDemoUno(), 0, 0);
		expect(routes).toBeGreaterThan(50);
	}, 60000);
});
