import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { textLexicon } from '../../../src/lib/games/scrabble/lexicon';
import { legalActions as unoLegal, type UnoState } from '../../../src/lib/games/uno/engine';
import type { ScrabbleState } from '../../../src/lib/games/scrabble/engine';
import {
	applyAction,
	botAction,
	cleanName,
	createRoom,
	gameResult,
	joinRoom,
	presence,
	seatView,
	setConnected,
	startRoom,
	stepBot,
	type Room
} from './room';

const lexicon = textLexicon(readFileSync('static/dict/enable.txt', 'utf8'));

function withPlayers(game: 'uno' | 'scrabble', n: number): Room {
	let room = createRoom('ABCDE', game);
	for (let i = 0; i < n; i++) room = joinRoom(room, { token: `tok-${i}`, name: `P${i}` }).room;
	return room;
}

describe('joining', () => {
	test('the first to join is the host, and each gets the next seat', () => {
		const a = joinRoom(createRoom('ABCDE', 'uno'), { token: 't1', name: 'Ann' });
		expect(a.seat).toBe(0);
		expect(a.room.host).toBe(0);
		const b = joinRoom(a.room, { token: 't2', name: 'Bo' });
		expect(b.seat).toBe(1);
		expect(b.room.host).toBe(0);
	});

	test('rejoining with a token gets the same seat back, even mid game', () => {
		const room = startRoom(withPlayers('uno', 2), 0, 1);
		const back = joinRoom(setConnected(room, 1, false), { token: 'tok-1', name: 'New name' });
		expect(back.seat).toBe(1);
		expect(back.room.seats[1].connected).toBe(true);
	});

	test('a full room, or one already started, turns new people away', () => {
		expect(() => joinRoom(withPlayers('scrabble', 2), { token: 'x', name: 'X' })).toThrow(/full/i);
		expect(() => joinRoom(withPlayers('uno', 4), { token: 'x', name: 'X' })).toThrow(/full/i);
		expect(() => joinRoom(startRoom(withPlayers('uno', 2), 0, 1), { token: 'x', name: 'X' })).toThrow(/started/i);
	});

	test('names are tidied and limited', () => {
		expect(cleanName('  Sam  ')).toBe('Sam');
		expect(cleanName('')).toBe('Player');
		expect(cleanName(undefined)).toBe('Player');
		expect(cleanName('x'.repeat(100)).length).toBeLessThanOrEqual(20);
		expect(cleanName('<b>\n\tx')).toBe('<b> x');
	});
});

describe('leaving before the game starts', () => {
	test('frees the seat, and passes on the host', () => {
		const room = setConnected(withPlayers('scrabble', 2), 0, false);
		expect(room.seats.map((s) => s.name)).toEqual(['P1']);
		expect(room.host).toBe(0);
		expect(joinRoom(room, { token: 'new', name: 'N' }).seat).toBe(1);
	});
});

describe('starting', () => {
	test('only the host can start', () => {
		expect(() => startRoom(withPlayers('uno', 2), 1, 1)).toThrow(/host/i);
	});

	test('uno fills empty seats with bots', () => {
		const room = startRoom(withPlayers('uno', 2), 0, 1);
		expect(room.phase).toBe('playing');
		expect(room.seats.length).toBe(4);
		expect(room.seats.map((s) => s.bot)).toEqual([false, false, true, true]);
		expect((room.game as UnoState).players).toBe(4);
	});

	test('scrabble needs two people and no bots', () => {
		expect(() => startRoom(withPlayers('scrabble', 1), 0, 1)).toThrow(/2 players/);
		const room = startRoom(withPlayers('scrabble', 2), 0, 1);
		expect(room.seats.every((s) => !s.bot)).toBe(true);
	});

	test("can't start twice while playing, but can restart after the game", () => {
		const room = startRoom(withPlayers('uno', 2), 0, 1);
		expect(() => startRoom(room, 0, 2)).toThrow();
		const over: Room = { ...room, phase: 'over' };
		expect(startRoom(over, 0, 2).phase).toBe('playing');
		expect(startRoom(over, 0, 2).game).not.toEqual(room.game);
	});
});

describe('playing', () => {
	test('the seat always comes from the connection, never from what the client claims', () => {
		const room = startRoom(withPlayers('scrabble', 2), 0, 1);
		const claimed = { type: 'pass', seat: 0 };
		expect(() => applyAction(room, 1, claimed, lexicon)).toThrow(/turn/i);
		const after = applyAction(room, 0, { type: 'pass', seat: 1 }, lexicon);
		expect((after.game as ScrabbleState).last).toEqual({ seat: 0, kind: 'pass' });
	});

	test('actions before the start or of unknown kinds are refused', () => {
		expect(() => applyAction(withPlayers('uno', 2), 0, { type: 'draw' }, lexicon)).toThrow();
		const room = startRoom(withPlayers('uno', 2), 0, 1);
		expect(() => applyAction(room, 0, { type: 'cheat' }, lexicon)).toThrow();
		expect(() => applyAction(room, 0, null, lexicon)).toThrow();
		expect(() => applyAction(room, 0, 'draw', lexicon)).toThrow();
	});

	test('garbage in a scrabble play is refused, not a crash', () => {
		const room = startRoom(withPlayers('scrabble', 2), 0, 1);
		expect(() => applyAction(room, 0, { type: 'place', tiles: 'all of them' }, lexicon)).toThrow();
		expect(() => applyAction(room, 0, { type: 'exchange', tileIds: 3 }, lexicon)).toThrow();
	});

	test('sequence goes up with each change', () => {
		const room = startRoom(withPlayers('scrabble', 2), 0, 1);
		expect(applyAction(room, 0, { type: 'pass' }, lexicon).seq).toBe(room.seq + 1);
	});

	test('bots only move on bot turns', () => {
		const room = startRoom(withPlayers('uno', 2), 0, 1);
		expect(botAction(room)).toBeNull();
		const onBot: Room = { ...room, game: { ...(room.game as UnoState), current: 2 } };
		expect(botAction(onBot)).not.toBeNull();
		const next = stepBot(onBot);
		expect((next.game as UnoState).last?.seat).toBe(2);
	});

	test('a game with people and bots runs to the end, and the result is ready to record', () => {
		let room = startRoom(withPlayers('uno', 2), 0, 3);
		let steps = 0;
		while (room.phase === 'playing' && steps++ < 20000) {
			const bot = botAction(room);
			if (bot) room = stepBot(room);
			else {
				const g = room.game as UnoState;
				room = applyAction(room, g.current, unoLegal(g)[0], lexicon);
			}
		}
		expect(room.phase).toBe('over');
		const result = gameResult(room)!;
		expect(result.game).toBe('uno');
		expect(result.players).toBe(4);
		expect(result.winnerSeat).toBe((room.game as UnoState).winner);
	});

	test('no result while the game is running', () => {
		expect(gameResult(startRoom(withPlayers('uno', 2), 0, 3))).toBeNull();
	});

	test('dropping out mid game keeps the seat, and no bot takes it', () => {
		const room = setConnected(startRoom(withPlayers('scrabble', 2), 0, 1), 0, false);
		expect(room.seats.length).toBe(2);
		expect(room.seats[0].bot).toBe(false);
		expect(room.seats[0].connected).toBe(false);
		expect(botAction(room)).toBeNull();
	});
});

/** Every value anywhere inside something, for searching for what must not be there. */
function flatten(value: unknown, into: string[] = []): string[] {
	if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) {
			into.push(k);
			flatten(v, into);
		}
	} else into.push(String(value));
	return into;
}

describe('nothing hidden ever leaks to another seat', () => {
	test('uno: another seat sees no hand, deck, seed or token of anyone else', () => {
		const room = startRoom(withPlayers('uno', 3), 0, 9);
		const g = room.game as UnoState;
		for (let seat = 0; seat < 3; seat++) {
			const view = seatView(room, seat)!;
			const text = JSON.stringify(view);
			const keys = flatten(view);
			for (const banned of ['rng', 'deck', 'hands', 'token', 'seed']) expect(keys).not.toContain(banned);
			for (let other = 0; other < 4; other++) {
				if (other === seat) continue;
				for (const c of g.hands[other]) expect(text).not.toContain(`"id":${c.id},`);
			}
			for (const c of g.deck) expect(text).not.toContain(`"id":${c.id},`);
			for (const t of ['tok-0', 'tok-1', 'tok-2']) expect(text).not.toContain(t);
		}
	});

	test('scrabble: another seat sees no rack, bag, seed or token', () => {
		const room = startRoom(withPlayers('scrabble', 2), 0, 9);
		const g = room.game as ScrabbleState;
		for (let seat = 0; seat < 2; seat++) {
			const view = seatView(room, seat)!;
			const text = JSON.stringify(view);
			const keys = flatten(view);
			for (const banned of ['rng', 'bag', 'racks', 'token', 'seed']) expect(keys).not.toContain(banned);
			for (const t of g.racks[1 - seat]) expect(text).not.toContain(`"id":${t.id},`);
			for (const t of g.bag) expect(text).not.toContain(`"id":${t.id},`);
		}
	});

	test('still true after a whole uno game of moves, at every step', () => {
		let room = startRoom(withPlayers('uno', 2), 0, 5);
		for (let step = 0; step < 200 && room.phase === 'playing'; step++) {
			const g = room.game as UnoState;
			for (let seat = 0; seat < 2; seat++) {
				const text = JSON.stringify(seatView(room, seat));
				for (const c of g.hands[1 - seat]) {
					const inDiscard = g.discard.slice(-4).some((d) => d.id === c.id);
					if (!inDiscard) expect(text).not.toContain(`"id":${c.id},`);
				}
			}
			room = botAction(room) ? stepBot(room) : applyAction(room, g.current, unoLegal(g)[0], lexicon);
		}
	});

	test('presence holds names and status, and never anyone’s token', () => {
		const room = withPlayers('uno', 3);
		const p = presence(room);
		const text = JSON.stringify(p);
		expect(text).not.toContain('tok-');
		expect(p.seats.map((s) => s.name)).toEqual(['P0', 'P1', 'P2']);
		expect(p.host).toBe(0);
		expect(p.phase).toBe('lobby');
		expect(p.game).toBe('uno');
	});

	test('nobody has a view before the game starts', () => {
		expect(seatView(withPlayers('uno', 2), 0)).toBeNull();
	});
});
