import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { textLexicon } from '../games/scrabble/lexicon';
import { chooseAction as scrabbleBot } from '../games/scrabble/bot';
import { buildTrie } from '../games/scrabble/lexicon';
import { DemoUnoSession } from './demoUno';
import { DemoScrabbleSession } from './demoScrabble';
import { LocalUnoSession } from './localUno';
import { LocalScrabbleSession } from './localScrabble';
import type { GameSession, SessionSnapshot } from './types';

const text = readFileSync('static/dict/enable.txt', 'utf8');
const lexicon = textLexicon(text);
const trie = buildTrie(text);

/** Runs timers at once, keeping the same order. */
const instant = () => Promise.resolve();
const tick = async () => {
	for (let i = 0; i < 50; i++) await Promise.resolve();
};
async function settle(until: () => boolean, rounds = 5000) {
	for (let i = 0; i < rounds && !until(); i++) await tick();
	if (!until()) throw new Error('never settled');
}

function latest<V, A>(s: GameSession<V, A>) {
	let snap!: SessionSnapshot<V>;
	s.subscribe((v) => (snap = v));
	return () => snap;
}

describe('store contract', () => {
	test('a subscriber hears the current value at once, and stops after unsubscribing', () => {
		const s = new LocalUnoSession({ seed: 1, wait: instant });
		let calls = 0;
		const stop = s.subscribe(() => calls++);
		expect(calls).toBe(1);
		stop();
		s.send({ type: 'draw' });
		expect(calls).toBe(1);
		s.close();
	});
});

describe('demo uno', () => {
	test('reaches UNO! by playing whatever is legal, and asks to move on', async () => {
		const s = new DemoUnoSession({ wait: instant });
		const snap = latest(s);
		expect(snap().view.hand.length).toBe(7);
		expect(snap().canLeave).toBe(false);
		for (let turn = 0; turn < 40 && !snap().ended; turn++) {
			await settle(() => snap().view.legal.cards.length > 0 || !!snap().ended);
			if (snap().ended) break;
			const id = snap().view.legal.cards[0];
			const card = snap().view.hand.find((c) => c.id === id)!;
			s.send(card.color === 'wild' ? { type: 'play', cardId: id, color: 'red' } : { type: 'play', cardId: id });
		}
		await settle(() => !!snap().ended);
		expect(snap().view.hand.length).toBe(1);
		expect(snap().ended).toMatchObject({ title: 'UNO!', advanceMs: 3500 });
		s.close();
	});

	test('nothing can be played while opponents are moving', async () => {
		let release!: () => void;
		const s = new DemoUnoSession({ wait: () => new Promise((r) => (release = r)) });
		const snap = latest(s);
		s.send({ type: 'play', cardId: 1 });
		expect(snap().view.legal).toEqual({ cards: [], draw: false, keep: false });
		s.send({ type: 'play', cardId: 7 });
		expect(snap().view.hand.some((c) => c.id === 7)).toBe(true);
		release();
		s.close();
	});

	test('shows who is moving and says when one draws, the way the script always has', async () => {
		const seen: (number | null)[] = [];
		const notes = new Set<string>();
		const s = new DemoUnoSession({ wait: instant });
		s.subscribe((v) => {
			seen.push(v.active);
			if (v.note) notes.add(v.note);
		});
		s.send({ type: 'play', cardId: 1 });
		await tick();
		await settle(() => seen.at(-1) === null && seen.length > 4);
		expect(seen).toContain(1);
		expect(seen).toContain(2);
		expect(seen).toContain(3);
		expect([...notes].some((n) => n.endsWith('draws'))).toBe(true);
		s.close();
	});
});

describe('demo scrabble', () => {
	test('opens on BOARD with the fixed rack, and has no pass or exchange', () => {
		const s = new DemoScrabbleSession({ lexicon: async () => lexicon });
		const snap = latest(s);
		expect(snap().view.rack.map((t) => t.letter).join('')).toBe('TGIMELS');
		expect(snap().view.board['7,7']).toEqual({ letter: 'A', blank: false });
		expect(snap().view.can).toEqual({ place: true, pass: false, exchange: false });
		expect(snap().showOpponents).toBe(false);
		s.close();
	});

	test('GIMLETS scores 79, then the demo is over', async () => {
		const s = new DemoScrabbleSession({ lexicon: async () => lexicon });
		const snap = latest(s);
		await s.ready;
		const rack = snap().view.rack;
		const tiles = [...'GIMLETS'].map((letter, i) => ({
			r: 1 + i,
			c: 10,
			tileId: rack.find((t) => t.letter === letter)!.id,
			letter
		}));
		s.send({ type: 'place', tiles });
		await tick();
		expect(snap().view.scores[0]).toBe(79);
		expect(snap().ended?.text).toContain('GIMLETS for 79 points');
		s.close();
	});

	test('a bad word is rejected with the reason, and nothing changes', async () => {
		const s = new DemoScrabbleSession({ lexicon: async () => lexicon });
		const snap = latest(s);
		await s.ready;
		const t = snap().view.rack[0];
		s.send({ type: 'place', tiles: [{ r: 8, c: 5, tileId: t.id, letter: t.letter }] });
		await tick();
		expect(snap().rejected?.reason).toContain("isn't in the dictionary");
		expect(snap().rejected?.n).toBe(1);
		expect(snap().view.rack.length).toBe(7);
		s.close();
	});

	test('still plays if the dictionary fails to load, as it always has', async () => {
		const s = new DemoScrabbleSession({ lexicon: async () => { throw new Error('offline'); } });
		const snap = latest(s);
		await s.ready;
		const t = snap().view.rack.find((x) => x.letter === 'S')!;
		s.send({ type: 'place', tiles: [{ r: 7, c: 10, tileId: t.id, letter: 'S' }] });
		await tick();
		expect(snap().view.scores[0]).toBeGreaterThan(0);
		s.close();
	});
});

describe('local uno', () => {
	test('bots answer, and a game plays through to a winner', async () => {
		const s = new LocalUnoSession({ seed: 11, wait: instant });
		const snap = latest(s);
		expect(snap().canLeave).toBe(true);
		expect(snap().names.length).toBe(4);
		for (let i = 0; i < 2000 && !snap().ended; i++) {
			await settle(() => {
				const l = snap().view.legal;
				return !!snap().ended || l.cards.length > 0 || l.draw || l.keep;
			});
			if (snap().ended) break;
			const { legal, hand } = snap().view;
			if (legal.cards.length) {
				const card = hand.find((c) => c.id === legal.cards[0])!;
				s.send(card.color === 'wild' ? { type: 'play', cardId: card.id, color: 'blue' } : { type: 'play', cardId: card.id });
			} else if (legal.keep) s.send({ type: 'pass' });
			else s.send({ type: 'draw' });
			await tick();
		}
		await settle(() => !!snap().ended);
		expect(snap().view.phase).toBe('over');
		expect(snap().ended?.advanceMs).toBeUndefined();
		expect(snap().ended?.title).toBeTruthy();
		s.close();
	}, 30000);

	test('your hand is sorted by colour so a long one is easy to page through', () => {
		const s = new LocalUnoSession({ seed: 2, wait: instant });
		const snap = latest(s);
		const colors = snap().view.hand.map((c) => c.color);
		const order = ['red', 'blue', 'green', 'yellow', 'wild'];
		expect(colors).toEqual([...colors].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
		s.close();
	});

	test('an illegal action is rejected and changes nothing', () => {
		const s = new LocalUnoSession({ seed: 2, wait: instant });
		const snap = latest(s);
		s.send({ type: 'pass' });
		expect(snap().rejected?.n).toBe(1);
		expect(snap().view.hand.length).toBe(7);
		s.close();
	});

	test('restart deals a fresh game', async () => {
		const s = new LocalUnoSession({ seed: 2, wait: instant });
		const snap = latest(s);
		const before = snap().view.hand.map((c) => c.id);
		s.restart!();
		expect(snap().view.hand.map((c) => c.id)).not.toEqual(before);
		expect(snap().ended).toBeNull();
		s.close();
	});

	test('closing stops the bots', async () => {
		let waits = 0;
		const s = new LocalUnoSession({ seed: 3, wait: () => { waits++; return Promise.resolve(); } });
		s.send({ type: 'draw' });
		s.close();
		const after = waits;
		await tick();
		await tick();
		expect(waits).toBeLessThanOrEqual(after + 1);
	});
});

describe('local scrabble', () => {
	const bot = async (state: Parameters<typeof scrabbleBot>[0], seat: number) => scrabbleBot(state, seat, trie, 5);

	test('the bot replies after your play, and the score updates', async () => {
		const s = new LocalScrabbleSession({ seed: 4, wait: instant, lexicon: async () => lexicon, bot });
		const snap = latest(s);
		await s.ready;
		expect(snap().view.can.pass).toBe(true);
		expect(snap().showOpponents).toBe(true);
		s.send({ type: 'pass' });
		await settle(() => snap().view.last?.seat === 1);
		expect(snap().view.current).toBe(0);
		expect(snap().active).toBeNull();
		s.close();
	});

	test('a game against the bot, with us always passing, ends', async () => {
		const s = new LocalScrabbleSession({ seed: 4, wait: instant, lexicon: async () => lexicon, bot });
		const snap = latest(s);
		await s.ready;
		for (let i = 0; i < 400 && !snap().ended; i++) {
			await settle(() => !!snap().ended || snap().view.can.pass);
			if (snap().ended) break;
			s.send({ type: 'pass' });
			await tick();
		}
		await settle(() => !!snap().ended, 20000);
		expect(snap().view.phase).toBe('over');
		expect(snap().ended?.title).toBeTruthy();
		s.close();
	}, 60000);

	test('if the bot fails, it passes so the game never hangs', async () => {
		const s = new LocalScrabbleSession({
			seed: 4,
			wait: instant,
			lexicon: async () => lexicon,
			bot: async () => { throw new Error('worker died'); }
		});
		const snap = latest(s);
		await s.ready;
		s.send({ type: 'pass' });
		await settle(() => snap().view.last?.seat === 1);
		expect(snap().view.last).toEqual({ seat: 1, kind: 'pass' });
		s.close();
	});
});
