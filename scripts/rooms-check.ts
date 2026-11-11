/**
 * Plays real games against a running rooms worker, over real sockets: `bun run dev:rooms`, then
 * `bun run rooms:check`. Pass another address to check a deployed worker.
 *
 * This proves the parts only a real server can: sockets, seat tokens, reconnecting, grace periods,
 * bots moving on their own, and that nothing hidden crosses the wire.
 *
 * Grace periods are 20 and 30 seconds for real. To wait less, shorten them on both sides:
 * `bun run dev:rooms --var ROOM_GRACE_MS:3000`, then `ROOM_GRACE_MS=3000 bun run rooms:check`.
 */
const BASE = process.argv[2] ?? 'http://localhost:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
/** The longest grace period the server may be using, so waits for one are long enough. */
const GRACE_MS = Number(process.env.ROOM_GRACE_MS) || 30000;
const PAST_GRACE_MS = GRACE_MS + 8000;

type Message = Record<string, any>;

class Client {
	socket!: WebSocket;
	inbox: Message[] = [];
	raw: string[] = [];
	view: any = null;
	token = '';
	presence: any = null;
	closeCode: number | null = null;
	private seq = 0;

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
				socket.send(JSON.stringify({ type: 'join', name: this.name, token }));
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

	/** Sends a move, numbered like the app numbers them. Returns its number. */
	act(action: Message) {
		const seq = ++this.seq;
		this.send({ type: 'action', action, seq });
		return seq;
	}

	answered(seq: number) {
		return this.inbox.some((m) => (m.type === 'state' || m.type === 'rejected') && m.seq === seq);
	}

	/** Where this client's seat is, and whether it's the host, from its own presence. */
	get me() {
		return this.presence.seats[this.presence.you];
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

/** Makes any legal Uno move. */
function playUno(c: Client) {
	const { legal, hand } = c.view;
	if (legal.cards.length) {
		const card = hand.find((x: any) => x.id === legal.cards[0]);
		return c.act(card.color === 'wild' ? { type: 'play', cardId: card.id, color: 'red' } : { type: 'play', cardId: card.id });
	}
	return c.act(legal.keep ? { type: 'pass' } : { type: 'draw' });
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
	check('only the host can start', a.view === null && b.inbox.some((m) => m.code === 'not-host'));

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

	const outOfTurn = b.act({ type: 'pass', seat: 0 });
	await b.until('out of turn refused', () => b.answered(outOfTurn));
	check('claiming to be another seat fails', a.view.current === 0);

	const t = a.view.rack[0];
	const offCentre = a.act({ type: 'place', tiles: [{ r: 0, c: 0, tileId: t.id, letter: t.letter }] });
	await a.until('bad play refused', () => a.answered(offCentre));
	check('a play away from the centre is refused', Object.keys(a.view.board).length === 0);
	check(
		'the refusal says why with a code, and answers that move',
		a.inbox.some((m) => m.type === 'rejected' && m.seq === offCentre && m.code === 'must-cover-centre')
	);

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
		const seq = mover.act({ type: 'pass' });
		await a.until(`pass ${i}`, () => a.view.scoreless === i + 1);
		await mover.until(`pass ${i} answered`, () => mover.answered(seq));
	}
	check('six scoreless turns end it', a.view.phase === 'over');
	await a.until('over in presence', () => a.presence.phase === 'over');

	a.send({ type: 'start' });
	await a.until('rematch', () => a.view.phase === 'play' && a.view.scoreless === 0);
	check('the host can start another game', a.presence.phase === 'playing');

	// The host walks off after a game. Someone else becomes host, and their turns are passed.
	for (let i = 0; i < 6; i++) {
		const mover = a.view.current === 0 ? a : back;
		mover.act({ type: 'pass' });
		await a.until(`second game pass ${i}`, () => a.view.scoreless === i + 1);
	}
	await back.until('second game over', () => back.view.phase === 'over');
	a.socket.close();
	await back.until('host is away', () => back.presence.seats[0].connected === false);
	check('the host keeps the role during the grace period', back.presence.host === 0);
	await back.until('host moves on', () => back.presence.host === back.presence.you, PAST_GRACE_MS);
	check('then it passes to someone who is here', back.presence.seats[0].covered === true);
	back.send({ type: 'start' });
	await back.until('third game', () => back.view.phase === 'play' && back.view.scoreless === 0);
	check('so the room can still have a rematch', back.presence.phase === 'playing');
	await back.until('stand-in passes for the absent player', () => back.view.current === 1 && back.view.scoreless === 1);
	check('an absent Scrabble player passes', back.view.last?.seat === 0 && back.view.last?.kind === 'pass');
	back.socket.close();
}

async function uno() {
	console.log('Uno, two people and two bots');
	const code = await newRoom('uno');
	const a = new Client(code, 'Ann');
	const b = new Client(code, 'Ana');
	await a.connect();
	await a.until('a joined', () => !!a.token);
	await b.connect();
	await a.until('both', () => a.presence?.seats.length === 2);
	a.send({ type: 'start' });
	await a.until('views', () => a.view && b.view);
	check('bots fill the empty seats', a.presence.seats.length === 4 && a.presence.seats[3].bot);
	const names = a.presence.seats.map((s: any) => s.name);
	check('a bot never shares a name with a person', new Set(names).size === names.length);
	check('four hands', a.view.counts.length === 4);

	const start = Date.now();
	let moves = 0;
	let botMoves = 0;
	let lastVersion = -1;
	let checkedEcho = false;
	while (a.view.phase !== 'over' && Date.now() - start < 240000) {
		const version = a.inbox.filter((m) => m.type === 'state').at(-1)?.version ?? 0;
		if (version === lastVersion) {
			await Bun.sleep(25);
			continue;
		}
		lastVersion = version;
		const current = a.view.current;
		if (current >= 2) botMoves++;
		await Bun.sleep(40);
		if (a.view.phase === 'over') break;
		if (a.view.current === 0) {
			const seq = playUno(a);
			if (!checkedEcho) {
				await a.until('the move is answered', () => a.answered(seq));
				const echoes = b.inbox.filter((m) => m.type === 'state' && m.seq !== undefined);
				check('only the mover hears its move number back', echoes.length === 0);
				checkedEcho = true;
			}
		} else if (a.view.current === 1) {
			await b.until('b catches up', () => b.view.current === 1 && (b.view.legal.draw || b.view.legal.keep || b.view.legal.cards.length > 0));
			playUno(b);
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

/** Someone drops mid game and stays away: a bot plays their hand until they come back. */
async function coveredUno() {
	console.log('Uno, when someone drops mid game');
	const code = await newRoom('uno');
	const a = new Client(code, 'Ann');
	const b = new Client(code, 'Bo');
	await a.connect();
	await a.until('a joined', () => !!a.token);
	await b.connect();
	await a.until('both', () => a.presence?.seats.length === 2);
	a.send({ type: 'start' });
	await a.until('views', () => a.view && b.view);

	const token = b.token;
	b.socket.close();
	await a.until('b is away', () => a.presence.seats[1].connected === false);
	check('at first the seat waits, uncovered', a.presence.seats[1].covered === false);

	// Ann keeps playing. Bo's seat must move by itself once the grace period is over.
	const start = Date.now();
	let lastVersion = -1;
	let coveredMove = false;
	while (!coveredMove && a.view.phase !== 'over' && Date.now() - start < PAST_GRACE_MS + 30000) {
		coveredMove = a.presence.seats[1].covered && a.view.last?.seat === 1;
		const version = a.inbox.filter((m) => m.type === 'state').at(-1)?.version ?? 0;
		if (version !== lastVersion && a.view.current === 0) {
			lastVersion = version;
			await Bun.sleep(40);
			if (a.view.current === 0 && a.view.phase !== 'over') playUno(a);
		}
		await Bun.sleep(25);
	}
	check('after the grace period a bot covers the absent player', a.presence.seats[1].covered === true);
	check('and plays their turns, so the game goes on', coveredMove || a.view.phase === 'over');

	const back = new Client(code, 'Bo');
	await back.connect(token);
	await back.until('state on return', () => back.view !== null);
	await a.until('presence shows return', () => a.presence.seats[1].connected === true);
	check('coming back takes the seat back from the bot', back.view.me === 1 && a.presence.seats[1].covered === false);
	a.socket.close();
	back.socket.close();
}

/** A blip in the lobby must not cost anyone their seat, or the host their role. */
async function lobby() {
	console.log('Lobby blips, leaving, and odd messages');
	const code = await newRoom('uno');
	const a = new Client(code, 'Ann');
	const b = new Client(code, 'Bo');
	await a.connect();
	await a.until('a joined', () => !!a.token);
	await b.connect();
	await a.until('both', () => a.presence?.seats.length === 2);

	const token = a.token;
	a.socket.close();
	await b.until('host blip seen', () => b.presence.seats[0].connected === false);
	check('a blip keeps the seat in place', b.presence.seats.length === 2 && b.presence.you === 1);
	check('and the host stays host', b.presence.host === 0);
	const again = new Client(code, 'Ann');
	await again.connect(token);
	await again.until('back in', () => again.presence?.seats[0]?.connected === true);
	check('the host comes back to the same seat', again.presence.you === 0 && again.presence.host === 0);
	check('with nobody else moved', b.presence.you === 1 && b.presence.seats.length === 2);

	const before = again.inbox.filter((m) => m.type === 'joined').length;
	again.send({ type: 'join', name: 'Ann twice' });
	await again.until('second join refused', () => again.inbox.some((m) => m.code === 'already-joined'));
	await Bun.sleep(200);
	check('joining twice on one socket adds no seat', again.presence.seats.length === 2);
	check('and keeps the socket open', again.closeCode === null && again.inbox.filter((m) => m.type === 'joined').length === before);

	for (const junk of ['null', '[]', '"start"', '7', '{"type":"action"}']) again.socket.send(junk);
	again.send({ type: 'action', seq: 41, action: null });
	await again.until('a bad move is answered', () => again.answered(41));
	check('null and other junk is ignored, and a bad move hears back', again.closeCode === null);
	const bodyNull = await fetch(`${BASE}/rooms`, { method: 'POST', body: 'null' });
	check('a room request of null is refused, not a crash', bodyNull.status === 400);

	const c = new Client(code, 'Cy');
	await c.connect();
	await again.until('c in', () => again.presence.seats.length === 3);
	c.send({ type: 'leave' });
	await again.until('c gone', () => again.presence.seats.length === 2, 3000);
	check('leaving on purpose frees the seat at once', c.closeCode === 1000);

	again.socket.close();
	await b.until('the host is away', () => b.presence.seats[0].connected === false);
	await b.until('the seat is freed', () => b.presence.seats.length === 1, PAST_GRACE_MS);
	check('someone who stays away loses the lobby seat after the grace period', b.presence.seats[0].name === 'Bo');
	check('and the host passes to whoever is here', b.presence.host === b.presence.you);
	b.socket.close();
}

async function missing() {
	console.log('Rooms that are not there');
	const ghost = new Client('ZZZZZ', 'Lost');
	await ghost.connect();
	await ghost.until('refusal', () => ghost.inbox.some((m) => m.type === 'error'));
	await ghost.until('closed', () => ghost.closeCode !== null);
	check('an unknown code is refused cleanly', ghost.closeCode === 4404);
	const typo = new Client('IIIII', 'Lost');
	await typo.connect();
	await typo.until('refusal for a typo', () => typo.closeCode !== null);
	check("a code with letters we never issue says it doesn't exist", typo.closeCode === 4404);
	const bad = await fetch(`${BASE}/rooms`, { method: 'POST', body: JSON.stringify({ game: 'chess' }) });
	check('an unknown game is refused', bad.status === 400);
}

/** Rooms sleep after about 10 idle seconds, and sockets must still be told apart after waking. */
async function hibernation() {
	console.log('After the room has gone to sleep');
	const code = await newRoom('scrabble');
	const a = new Client(code, 'Ann');
	const b = new Client(code, 'Bo');
	await a.connect();
	await a.until('a joined', () => !!a.token);
	await b.connect();
	await a.until('both seated', () => a.presence?.seats.length === 2);
	await Bun.sleep(15000);
	b.socket.close();
	await a.until('the seat to free up', () => a.presence.seats.length === 1, PAST_GRACE_MS);
	check('closing a tab still frees its lobby seat, after the grace period', a.presence.seats[0].name === 'Ann');
	a.socket.close();
}

await missing();
await lobby();
await hibernation();
await scrabble();
await uno();
await coveredUno();
console.log(`\nAll ${passed} checks passed.`);
process.exit(0);
