import { describe, expect, test } from 'bun:test';
import { newGame as newScrabble, viewFor as scrabbleView } from '../games/scrabble/engine';
import { newGame as newUno, viewFor as unoView, type UnoView } from '../games/uno/engine';
import { RemoteSession, type RoomSocket } from './remote';

class FakeSocket implements RoomSocket {
	static all: FakeSocket[] = [];
	readyState = 0;
	sent: Record<string, unknown>[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onclose: ((e: { code: number }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public url: string) {
		FakeSocket.all.push(this);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.readyState = 3;
		this.onclose?.({ code: 1000 });
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	receive(message: unknown) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
	drop(code = 1006) {
		this.readyState = 3;
		this.onclose?.({ code });
	}
}

function memory() {
	const data = new Map<string, string>();
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v)
	};
}

function setup(options: { storage?: ReturnType<typeof memory> } = {}) {
	FakeSocket.all = [];
	const waits: { ms: number; go: () => void }[] = [];
	const session = new RemoteSession({
		baseUrl: 'http://rooms.test',
		code: 'ABCDE',
		name: 'Sam',
		storage: options.storage ?? memory(),
		createSocket: (url) => new FakeSocket(url),
		wait: (ms) => new Promise((go) => waits.push({ ms, go }))
	});
	return { session, waits, socket: () => FakeSocket.all.at(-1)! };
}

const seats = [
	{ name: 'Sam', bot: false, connected: true },
	{ name: 'Bo', bot: false, connected: true }
];
const tick = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('connecting', () => {
	test('turns the http address into the room socket address', () => {
		const { socket, session } = setup();
		expect(socket().url).toBe('ws://rooms.test/rooms/ABCDE/ws');
		session.close();
	});

	test('joins on open with its name, and no token the first time', () => {
		const { socket, session } = setup();
		socket().open();
		expect(socket().sent[0]).toEqual({ type: 'join', code: 'ABCDE', name: 'Sam' });
		session.close();
	});

	test('keeps its seat token for later, and sends it when it joins again', () => {
		const storage = memory();
		const first = setup({ storage });
		first.socket().open();
		first.socket().receive({ type: 'joined', seat: 0, token: 'secret-token-1234', code: 'ABCDE', game: 'uno' });
		first.session.close();
		const second = setup({ storage });
		second.socket().open();
		expect(second.socket().sent[0].token).toBe('secret-token-1234');
		second.session.close();
	});

	test('tracks the room through the lobby', () => {
		const { socket, session } = setup();
		let lobby = session.lobby.value;
		session.lobby.subscribe((v) => (lobby = v));
		expect(lobby.phase).toBe('connecting');
		socket().open();
		socket().receive({ type: 'presence', game: 'uno', phase: 'lobby', host: 0, seats, you: 0 });
		expect(lobby.phase).toBe('lobby');
		expect(lobby.isHost).toBe(true);
		expect(lobby.seats.length).toBe(2);
		expect(lobby.game).toBe('uno');
		session.close();
	});
});

describe('during a game', () => {
	const uno = () => unoView(newUno({ players: 2, seed: 1 }), 0);

	test('views become snapshots the game screen can use', () => {
		const { socket, session } = setup();
		socket().open();
		socket().receive({ type: 'presence', game: 'uno', phase: 'playing', host: 0, seats, you: 0 });
		socket().receive({ type: 'state', view: uno(), seq: 1 });
		let snap!: Parameters<Parameters<typeof session.subscribe>[0]>[0];
		session.subscribe((s) => (snap = s));
		expect(snap.names).toEqual(['Sam', 'Bo']);
		expect((snap.view as UnoView).hand.length).toBe(7);
		expect(snap.status).toBe('live');
		expect(snap.active).toBeNull();
		expect(snap.canLeave).toBe(true);
		expect(session.lobby.value.hasView).toBe(true);
		session.close();
	});

	test('sends actions without a seat, and numbers them', () => {
		const { socket, session } = setup();
		socket().open();
		socket().receive({ type: 'presence', game: 'uno', phase: 'playing', host: 0, seats, you: 0 });
		socket().receive({ type: 'state', view: uno(), seq: 1 });
		session.send({ type: 'draw' });
		session.send({ type: 'pass' });
		const actions = socket().sent.filter((m) => m.type === 'action');
		expect(actions.map((a) => a.seq)).toEqual([1, 2]);
		expect(actions[0].action).toEqual({ type: 'draw' });
		session.close();
	});

	test('a rejected action reports the reason', () => {
		const { socket, session } = setup();
		socket().open();
		socket().receive({ type: 'presence', game: 'uno', phase: 'playing', host: 0, seats, you: 0 });
		socket().receive({ type: 'state', view: uno(), seq: 1 });
		socket().receive({ type: 'rejected', reason: 'Nope', seq: 1 });
		let snap!: Parameters<Parameters<typeof session.subscribe>[0]>[0];
		session.subscribe((s) => (snap = s));
		expect(snap.rejected).toEqual({ reason: 'Nope', n: 1 });
		session.close();
	});

	test('highlights whoever is to move, and says when they have dropped out', () => {
		const { socket, session } = setup();
		socket().open();
		const view = { ...uno(), current: 1 };
		socket().receive({
			type: 'presence', game: 'uno', phase: 'playing', host: 0,
			seats: [seats[0], { ...seats[1], connected: false }], you: 0
		});
		socket().receive({ type: 'state', view, seq: 1 });
		let snap!: Parameters<Parameters<typeof session.subscribe>[0]>[0];
		session.subscribe((s) => (snap = s));
		expect(snap.active).toBe(1);
		expect(snap.note).toContain('Waiting for Bo');
		session.close();
	});

	test('the end of a game is announced, and the host can start another', () => {
		const { socket, session } = setup();
		socket().open();
		socket().receive({ type: 'presence', game: 'scrabble', phase: 'over', host: 0, seats, you: 0 });
		const view = { ...scrabbleView(newScrabble({ players: 2, seed: 1 }), 0), phase: 'over' as const, winner: 1, scores: [10, 20] };
		socket().receive({ type: 'state', view, seq: 9 });
		let snap!: Parameters<Parameters<typeof session.subscribe>[0]>[0];
		session.subscribe((s) => (snap = s));
		expect(snap.ended?.title).toBe('Bo wins');
		expect(snap.canRestart).toBe(true);
		session.restart();
		expect(socket().sent.at(-1)).toEqual({ type: 'start' });
		session.close();
	});

	test("someone who isn't host can't restart", () => {
		const { socket, session } = setup();
		socket().open();
		socket().receive({ type: 'presence', game: 'uno', phase: 'over', host: 1, seats, you: 0 });
		socket().receive({ type: 'state', view: { ...uno(), phase: 'over', winner: 0 }, seq: 2 });
		let snap!: Parameters<Parameters<typeof session.subscribe>[0]>[0];
		session.subscribe((s) => (snap = s));
		expect(snap.canRestart).toBe(false);
		session.close();
	});
});

describe('losing the connection', () => {
	test('goes offline, then retries with growing gaps until it gets back in', async () => {
		const { socket, session, waits } = setup();
		socket().open();
		socket().receive({ type: 'joined', seat: 0, token: 'secret-token-1234', code: 'ABCDE', game: 'uno' });
		socket().drop();
		expect(session.lobby.value.status).toBe('offline');
		const gaps: number[] = [];
		for (let i = 0; i < 3; i++) {
			await tick();
			const w = waits.shift()!;
			gaps.push(w.ms);
			w.go();
			await tick();
			socket().drop();
		}
		expect(gaps[1]).toBeGreaterThan(gaps[0]);
		expect(gaps[2]).toBeGreaterThan(gaps[1]);
		await tick();
		waits.shift()!.go();
		await tick();
		socket().open();
		expect(socket().sent[0].token).toBe('secret-token-1234');
		expect(session.lobby.value.status).toBe('live');
		session.close();
	});

	test('actions sent while offline are refused rather than lost silently', async () => {
		const { socket, session } = setup();
		socket().open();
		socket().receive({ type: 'presence', game: 'uno', phase: 'playing', host: 0, seats, you: 0 });
		socket().receive({ type: 'state', view: unoView(newUno({ players: 2, seed: 1 }), 0), seq: 1 });
		socket().drop();
		session.send({ type: 'draw' });
		let snap!: Parameters<Parameters<typeof session.subscribe>[0]>[0];
		session.subscribe((s) => (snap = s));
		expect(snap.rejected?.n).toBe(1);
		session.close();
	});

	test('a room that says no is final, and it stops retrying', async () => {
		const { socket, session, waits } = setup();
		socket().open();
		socket().receive({ type: 'error', reason: 'That room does not exist.' });
		socket().drop(4404);
		await tick();
		expect(session.lobby.value.error).toBe('That room does not exist.');
		expect(waits.length).toBe(0);
		session.close();
	});

	test('closing stops everything', async () => {
		const { socket, session, waits } = setup();
		socket().open();
		session.close();
		await tick();
		expect(waits.length).toBe(0);
		expect(socket().readyState).toBe(3);
	});
});
