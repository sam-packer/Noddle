import { describe, expect, test } from 'bun:test';
import { nextInt, shuffle } from './rng';

describe('seeded rng', () => {
	test('the same seed gives the same sequence, and the state moves on', () => {
		const a = nextInt(42, 1000);
		const b = nextInt(42, 1000);
		expect(a).toEqual(b);
		expect(nextInt(a.rng, 1000).rng).not.toBe(a.rng);
	});

	test('values stay in range', () => {
		let rng = 7;
		for (let i = 0; i < 1000; i++) {
			const r = nextInt(rng, 6);
			expect(r.value).toBeGreaterThanOrEqual(0);
			expect(r.value).toBeLessThan(6);
			rng = r.rng;
		}
	});

	test('shuffle keeps every item, does not touch its input, and depends on the seed', () => {
		const input = Array.from({ length: 52 }, (_, i) => i);
		const a = shuffle(input, 1);
		const b = shuffle(input, 2);
		expect(input[0]).toBe(0);
		expect([...a.items].sort((x, y) => x - y)).toEqual(input);
		expect(a.items).not.toEqual(b.items);
		expect(shuffle(input, 1).items).toEqual(a.items);
	});
});
