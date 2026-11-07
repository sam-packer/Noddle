/**
 * Plays real games against a running rooms worker, over real sockets: `bun run dev:rooms`, then
 * `bun run rooms:check`. Pass another address to check a deployed worker.
 *
 * The rules are tested by `bun test`. This proves the parts only a real server can: sockets, seat
 * tokens, reconnecting, bots moving on their own, and that nothing hidden crosses the wire.
 */
const BASE = process.argv[2] ?? 'http://localhost:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');

type Message = Record<string, any>;

class Client {
	socket!: WebSocket;
	inbox: Message[] = [];
	raw: string[] = [];
	view: any = null;
	token = '';
	presence: any = null;
	closeCode: number | null = null;

	constructor(
		readonly code: string,
		readonly name: string
	) {}

	connect(token?: string) {
		this.closeCode = null;
		return new Promise<void>((resolve, reject) => {
			const socket = new WebSocket(`${WS_BASE}/rooms/${this.code}/ws`);
			this.socket = socket;
			socket.onopen = () => {
				socket.send(JSON.stringify({ type: 'join', code: this.code, name: this.name, token }));
				resolve();
			};
			socket.onerror = () => reject(new Error('socket error'));
			socket.onclose = (e) => (this.closeCode = e.code);
			socket.onmessage = (e) => {
				this.raw.push(String(e.data));
				const m = JSON.parse(String(e.data));
				this.inbox.push(m);
				if (m.type === 'joined') this.token = m.token;
				if (m.type === 'presence') this.presence = m;
				if (m.type === 'state') this.view = m.view;
			};
		});
	}

	send(m: Message) {
		this.socket.send(JSON.stringify(m));
	}

	act(action: Message) {
		this.send({ type: 'action', action, seq: 1 });
	}

	async until(what: string, test: () => boolean, ms = 8000) {
		const start = Date.now();
		while (!test()) {
			if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
			await Bun.sleep(20);
		}
	}
}

let passed = 0;
function check(what: string, ok: boolean) {
	if (!ok) throw new Error(`FAILED: ${what}`);
	passed++;
	console.log(`  ok  ${what}`);
}

async function newRoom(game: string) {
	const r = await fetch(`${BASE}/rooms`, { method: 'POST', body: JSON.stringify({ game }) });
	check(`can create a ${game} room`, r.ok);
	return ((await r.json()) as { code: string }).code;
}

async function scrabble() {
	console.log('Scrabble, two people');
	const code = await newRoom('scrabble');
	check('codes are 5 characters', /^[A-Z0-9]{5}$/.test(code));

	const a = new Client(code, 'Ann');
	const b = new Client(code, 'Bo');
	await a.connect();
	await a.until('joined', () => !!a.token);
	await b.connect();
	await a.until('both seated', () => a.presence?.seats.length === 2);
	check('first in is host', a.presence.host === 0 && a.presence.you === 0 && b.presence !== null);
	check('presence carries no tokens', !a.raw.join('').includes(b.token));

	b.send({ type: 'start' });
	await b.until('non-host refused', () => b.inbox.some((m) => m.type === 'rejected'));
	check('only the host can start', a.view === null);

	a.send({ type: 'start' });
	await a.until('views', () => a.view && b.view);
	check('each sees their own rack', a.view.rack.length === 7 && b.view.rack.length === 7);
	check('and only that rack', a.view.me === 0 && b.view.me === 1);

	const aTiles = new Set<number>(a.view.rack.map((t: any) => t.id));
	const leaked = b.raw.some((raw) => {
		const m = JSON.parse(raw);
		if (m.type !== 'state') return false;
		return [...aTiles].some((id) => m.view.rack.some((t: any) => t.id === id));
	});
	check("the other player's tiles never reach this socket", !leaked);
	for (const banned of ['"bag"', '"racks"', '"rng"', '"token":"' + a.token]) {
		check(`no ${banned.slice(0, 12)} in anything sent to the other seat`, !b.raw.join('').includes(banned));
	}

	b.act({ type: 'pass', seat: 0 });
	await b.until('out of turn refused', () => b.inbox.filter((m) => m.type === 'rejected').length === 2);
	check('claiming to be another seat fails', a.view.current === 0);

	const t = a.view.rack[0];
	a.act({ type: 'place', tiles: [{ r: 0, c: 0, tileId: t.id, letter: t.letter }] });
	await a.until('bad play refused', () => a.inbox.some((m) => m.type === 'rejected'));
	check('a play away from the centre is refused', Object.keys(a.view.board).length === 0);

	// The dropped player keeps their seat, and the game waits.
	const token = b.token;
	b.socket.close();
	await a.until('presence shows the drop', () => a.presence.seats[1].connected === false);
	check('a drop keeps the seat, with no bot in it', a.presence.seats[1].bot === false);
	const c = new Client(code, 'Bo again');
	await c.connect('not-a-real-token-at-all');
	await c.until('stranger turned away', () => c.inbox.some((m) => m.type === 'error'));
	check('a stranger cannot take the seat', c.inbox.some((m) => /started/.test(m.reason ?? '')));
	const back = new Client(code, 'Bo');
	await back.connect(token);
	await back.until('state on return', () => back.view !== null);
	check('the token gets the seat and rack back', back.view.me === 1 && back.view.rack.length === 7);
	await a.until('presence shows return', () => a.presence.seats[1].connected === true);

	// Six passes end the game, which also tests rack adjustment over the wire.
	for (let i = 0; i < 6; i++) {
		const mover = a.view.current === 0 ? a : back;
		mover.act({ type: 'pass' });
		await a.until(`pass ${i}`, () => a.view.scoreless === i + 1);
	}
	check('six scoreless turns end it', a.view.phase === 'over');
	await a.until('over in presence', () => a.presence.phase === 'over');

	a.send({ type: 'start' });
	await a.until('rematch', () => a.view.phase === 'play');
	check('the host can start another game', a.presence.phase === 'playing');
	a.socket.close();
	back.socket.close();
}

async function uno() {
	console.log('Uno, two people and two bots');
	const code = await newRoom('uno');
	const a = new Client(code, 'Ann');
	const b = new Client(code, 'Bo');
	await a.connect();
	await a.until('a joined', () => !!a.token);
	await b.connect();
	await a.until('both', () => a.presence?.seats.length === 2);
	a.send({ type: 'start' });
	await a.until('views', () => a.view && b.view);
	check('bots fill the empty seats', a.presence.seats.length === 4 && a.presence.seats[3].bot);
	check('four hands', a.view.counts.length === 4);

	const play = (c: Client) => {
		const { legal, hand } = c.view;
		if (legal.cards.length) {
			const card = hand.find((x: any) => x.id === legal.cards[0]);
			c.act(card.color === 'wild' ? { type: 'play', cardId: card.id, color: 'red' } : { type: 'play', cardId: card.id });
		} else if (legal.keep) c.act({ type: 'pass' });
		else c.act({ type: 'draw' });
	};

	const start = Date.now();
	let moves = 0;
	let botMoves = 0;
	let lastSeq = -1;
	while (a.view.phase !== 'over' && Date.now() - start < 240000) {
		const stateMsgs = a.inbox.filter((m) => m.type === 'state');
		const seq = stateMsgs.at(-1)?.seq ?? 0;
		if (seq === lastSeq) {
			await Bun.sleep(25);
			continue;
		}
		lastSeq = seq;
		const current = a.view.current;
		if (current >= 2) botMoves++;
		await Bun.sleep(40);
		if (a.view.phase === 'over') break;
		if (a.view.current === 0) play(a);
		else if (a.view.current === 1) {
			await b.until('b catches up', () => b.view.current === 1 && (b.view.legal.draw || b.view.legal.keep || b.view.legal.cards.length > 0));
			play(b);
		}
		moves++;
	}
	check('a whole game finishes, with bots moving by themselves', a.view.phase === 'over' && botMoves > 0);
	console.log(`      after ${moves} messages. Winner: seat ${a.view.winner}`);
	for (const client of [a, b]) {
		check(`seat ${client === a ? 0 : 1} never saw a deck or seed`, !/"deck"|"rng"|"hands"/.test(client.raw.join('')));
	}
	a.socket.close();
	b.socket.close();
}

async function missing() {
	console.log('Rooms that are not there');
	const ghost = new Client('ZZZZZ', 'Lost');
	await ghost.connect();
	await ghost.until('refusal', () => ghost.inbox.some((m) => m.type === 'error'));
	await ghost.until('closed', () => ghost.closeCode !== null);
	check('an unknown code is refused cleanly', ghost.closeCode === 4404);
	const bad = await fetch(`${BASE}/rooms`, { method: 'POST', body: JSON.stringify({ game: 'chess' }) });
	check('an unknown game is refused', bad.status === 400);
}

await missing();
await scrabble();
await uno();
console.log(`\nAll ${passed} checks passed.`);
process.exit(0);
