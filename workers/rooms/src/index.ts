import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { RuleError } from '../../../src/lib/games/rng';
import { textLexicon } from '../../../src/lib/games/scrabble/lexicon';
import {
	isGameKind,
	readClientMessage,
	type ClientMessage,
	type GameKind,
	type ServerMessage,
	type WireAction
} from '../../../src/lib/rooms/protocol';
import { gameResult as gameResultTable } from '../../../src/lib/server/db/schema';
import dictionary from '../../../static/dict/enable.txt';
import {
	applyAction,
	createRoom,
	dropSeat,
	expire,
	gameResult,
	joinRoom,
	leaveSeat,
	nextExpiry,
	presence,
	seatView,
	standInDue,
	startRoom,
	stepStandIn,
	type Room,
	type Timing
} from './room';

export interface Env {
	ROOMS: DurableObjectNamespace<RoomObject>;
	DB: D1Database;
	/**
	 * For local checks only, so they needn't wait out the real grace periods: replaces both with
	 * this many milliseconds. Set with `bun run dev:rooms --var ROOM_GRACE_MS:3000`.
	 */
	ROOM_GRACE_MS?: string;
}

const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
/** Looser than the codes we issue, so a typo reaches the room and hears that it doesn't exist. */
const CODE_PATTERN = /^[A-Z0-9]{1,16}$/;
const CREATE_ATTEMPTS = 5;
/** A room is deleted after this long with nothing happening. */
const IDLE_MS = 2 * 60 * 60 * 1000;
/** Long enough for a wifi blip or a reload to come back to the same lobby seat. */
const LOBBY_GRACE_MS = 20_000;
/** How long a game waits for someone before a stand-in moves for them. */
const GAME_GRACE_MS = 30_000;
/** How long each bot takes, so people can follow the game. */
const BOT_MS = 1000;
const MAX_MESSAGE_BYTES = 4096;
const NOT_ALLOWED = "That move isn't allowed.";

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type'
};

// Binary search over the raw list, so waking up a room costs no CPU to parse 173k words.
const lexicon = textLexicon(dictionary);
const encoder = new TextEncoder();

function randomCode() {
	const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
	return Array.from(bytes, (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...CORS }
	});

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

		if (request.method === 'POST' && pathname === '/rooms') {
			const body: unknown = await request.json().catch(() => null);
			const game = typeof body === 'object' && body !== null && 'game' in body ? body.game : null;
			if (!isGameKind(game)) return json({ error: 'Unknown game' }, 400);
			for (let i = 0; i < CREATE_ATTEMPTS; i++) {
				const code = randomCode();
				const created = await env.ROOMS.getByName(code).create(code, game);
				if (created) return json({ code });
			}
			return json({ error: 'Could not make a room' }, 500);
		}

		const ws = pathname.match(/^\/rooms\/([^/]+)\/ws$/);
		if (ws && request.method === 'GET') {
			const code = ws[1].toUpperCase();
			if (!CODE_PATTERN.test(code)) return json({ error: 'Bad room code' }, 400);
			if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426);
			return env.ROOMS.getByName(code).fetch(request);
		}

		return json({ error: 'Not found' }, 404);
	}
} satisfies ExportedHandler<Env>;

/** Whom a state message answers, so their client knows its move arrived. */
type Answer = { ws: WebSocket; seq: number };

/**
 * One game room. Holds the only true copy of the game, using hibernating sockets, so an idle room
 * costs nothing. Each message reads from `room`, which is reloaded from storage after waking.
 *
 * One alarm serves every deadline: the next bot or stand-in move, the end of someone's grace
 * period, and the idle timeout. Each wake does whatever is due, then sets it for the next.
 */
export class RoomObject extends DurableObject<Env> {
	private room: Room | null = null;
	private lastActive = Date.now();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			const stored = await ctx.storage.get<Room>('room');
			// A room saved by an older version of this worker can't be read, so it's treated as gone.
			this.room = stored && 'hostToken' in stored ? stored : null;
			this.lastActive = (await ctx.storage.get<number>('lastActive')) ?? Date.now();
		});
	}

	private get timing(): Timing {
		const override = Number(this.env.ROOM_GRACE_MS);
		const grace = Number.isFinite(override) && override > 0 ? override : null;
		return { lobbyGraceMs: grace ?? LOBBY_GRACE_MS, gameGraceMs: grace ?? GAME_GRACE_MS, botMs: BOT_MS };
	}

	async create(code: string, kind: GameKind) {
		if (this.room) return false;
		this.room = createRoom(code, kind, Date.now());
		await this.save();
		await this.schedule();
		return true;
	}

	override async fetch(): Promise<Response> {
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		if (!this.room) {
			this.sendTo(server, { type: 'error', reason: 'That room does not exist.' });
			server.close(4404, 'No such room');
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
		if (typeof raw !== 'string' || !this.room) return;
		if (raw.length > MAX_MESSAGE_BYTES || encoder.encode(raw).byteLength > MAX_MESSAGE_BYTES) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		const read = readClientMessage(parsed);
		if (!read.message) {
			// Unreadable. A move still hears back, so its sender isn't left waiting.
			if (read.seq !== null) this.sendTo(ws, { type: 'rejected', code: 'bad-move', reason: NOT_ALLOWED, seq: read.seq });
			return;
		}
		const message = read.message;
		this.lastActive = Date.now();

		try {
			await this.handle(ws, message);
		} catch (e) {
			const known = e instanceof RuleError;
			if (!known) console.error('Room message failed', e);
			const code = known ? e.code : 'bad-move';
			const reason = known ? e.message : NOT_ALLOWED;
			if (message.type === 'join' && code !== 'already-joined') {
				this.sendTo(ws, { type: 'error', reason });
				ws.close(4403, 'Could not join');
			} else {
				this.sendTo(ws, { type: 'rejected', code, reason, seq: message.type === 'action' ? message.seq : null });
			}
		}
	}

	private async handle(ws: WebSocket, message: ClientMessage) {
		switch (message.type) {
			case 'join':
				// One seat per connection. Joining again would leave a seat nobody could ever free.
				if (this.tokenOf(ws)) throw new RuleError('already-joined', 'You are already in this room.');
				return this.join(ws, message.token, message.name);
			case 'start':
				return this.start(ws);
			case 'action':
				return this.act(ws, message.action, message.seq);
			case 'leave':
				return this.leave(ws);
		}
	}

	private async join(ws: WebSocket, token: string | undefined, name: string | undefined) {
		const claimed = token ?? crypto.randomUUID();
		const { room, seat } = joinRoom(this.settled(), { token: claimed, name });
		this.room = room;
		ws.serializeAttachment({ token: claimed });
		// A reconnect can arrive before the old connection has noticed it's dead.
		for (const other of this.ctx.getWebSockets()) {
			if (other !== ws && this.tokenOf(other) === claimed) other.close(4001, 'Replaced');
		}
		await this.save();
		this.sendTo(ws, { type: 'joined', seat, token: claimed, code: room.code, game: room.kind });
		this.broadcast();
		await this.schedule();
	}

	private async start(ws: WebSocket) {
		const seed = crypto.getRandomValues(new Uint32Array(1))[0];
		this.room = startRoom(this.settled(), this.seatOf(ws), seed, Date.now());
		await this.save();
		this.broadcast();
		await this.schedule();
	}

	private async act(ws: WebSocket, action: WireAction, seq: number) {
		this.room = applyAction(this.settled(), this.seatOf(ws), action, lexicon, Date.now());
		await this.afterMove({ ws, seq });
	}

	/** Gives the seat up now. The socket closes, and its close event finds no seat to hold. */
	private async leave(ws: WebSocket) {
		const seat = this.seatOf(ws);
		ws.serializeAttachment(null);
		this.room = leaveSeat(this.settled(), seat, Date.now());
		await this.save();
		this.broadcast(ws);
		await this.schedule();
		ws.close(1000, 'Left');
	}

	private async afterMove(answer?: Answer) {
		await this.record();
		await this.save();
		this.broadcast(undefined, answer);
		await this.schedule();
	}

	override async webSocketClose(ws: WebSocket) {
		await this.dropped(ws);
	}

	override async webSocketError(ws: WebSocket) {
		await this.dropped(ws);
	}

	/** A connection went. The seat waits out a grace period for the same player to come back. */
	private async dropped(ws: WebSocket) {
		const token = this.tokenOf(ws);
		if (!this.room || !token) return;
		const stillHere = this.ctx.getWebSockets().some((other) => other !== ws && this.tokenOf(other) === token);
		const seat = this.room.seats.findIndex((s) => s.token === token);
		if (stillHere || seat < 0) return;
		this.room = dropSeat(this.room, seat, Date.now());
		await this.save();
		this.broadcast(ws);
		await this.schedule();
	}

	override async alarm() {
		if (!this.room) {
			// Nothing here can be used, so there's nothing to keep.
			await this.ctx.storage.deleteAll();
			return;
		}
		const now = Date.now();
		if (now - this.lastActive >= IDLE_MS) {
			for (const ws of this.ctx.getWebSockets()) ws.close(4408, 'Room closed');
			this.room = null;
			await this.ctx.storage.deleteAll();
			return;
		}
		const settled = this.settled(now);
		const due = standInDue(settled, this.timing);
		if (due !== null && due <= now) {
			this.room = stepStandIn(settled, lexicon, now);
			await this.afterMove();
			return;
		}
		if (settled !== this.room) {
			this.room = settled;
			await this.save();
			this.broadcast();
		}
		await this.schedule();
	}

	/** The room with every grace period that has run out dealt with. */
	private settled(now = Date.now()) {
		return expire(this.room!, now, this.timing);
	}

	/** Wakes for whichever comes first: a bot's move, a grace period ending, or the idle timeout. */
	private async schedule() {
		if (!this.room) return;
		const deadlines = [this.lastActive + IDLE_MS, standInDue(this.room, this.timing), nextExpiry(this.room, this.timing)];
		await this.ctx.storage.setAlarm(Math.min(...deadlines.filter((d) => d !== null)));
	}

	private async save() {
		await this.ctx.storage.put({ room: this.room, lastActive: this.lastActive });
	}

	/** Writes the finished game once. A failure here must never affect the game itself. */
	private async record() {
		const result = this.room && !this.room.recorded ? gameResult(this.room) : null;
		if (!result) return;
		this.room = { ...this.room!, recorded: true };
		try {
			await drizzle(this.env.DB)
				.insert(gameResultTable)
				.values({ ...result, endedAt: new Date() });
		} catch (e) {
			console.error('Could not record the game', e);
		}
	}

	private tokenOf(ws: WebSocket): string | null {
		return (ws.deserializeAttachment() as { token?: string } | null)?.token ?? null;
	}

	private seatOf(ws: WebSocket) {
		const token = this.tokenOf(ws);
		const seat = token ? this.room!.seats.findIndex((s) => s.token === token) : -1;
		if (seat < 0) throw new RuleError('not-seated', 'You are not in this room.');
		return seat;
	}

	private sendTo(ws: WebSocket, message: ServerMessage) {
		try {
			ws.send(JSON.stringify(message));
		} catch {
			// Already gone. Its close event deals with the seat.
		}
	}

	/** Sends everyone the seat list, and their own view of the game. */
	private broadcast(except?: WebSocket, answer?: Answer) {
		if (!this.room) return;
		const seats = presence(this.room);
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === except) continue;
			const token = this.tokenOf(ws);
			if (!token) continue;
			const you = this.room.seats.findIndex((s) => s.token === token);
			this.sendTo(ws, { type: 'presence', ...seats, you });
			const view = seatView(this.room, you);
			const seq = answer?.ws === ws ? answer.seq : undefined;
			if (view) this.sendTo(ws, { type: 'state', view, version: this.room.version, seq });
		}
	}
}
