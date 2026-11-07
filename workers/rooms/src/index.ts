import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { RuleError } from '../../../src/lib/games/rng';
import { textLexicon } from '../../../src/lib/games/scrabble/lexicon';
import { gameResult as gameResultTable } from '../../../src/lib/server/db/schema';
import dictionary from '../../../static/dict/enable.txt';
import {
	applyAction,
	botAction,
	createRoom,
	gameResult,
	joinRoom,
	presence,
	seatView,
	setConnected,
	startRoom,
	stepBot,
	type GameKind,
	type Room
} from './room';

export interface Env {
	ROOMS: DurableObjectNamespace<RoomObject>;
	DB: D1Database;
}

const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const CODE_PATTERN = new RegExp(`^[${CODE_LETTERS}]{${CODE_LENGTH}}$`);
const CREATE_ATTEMPTS = 5;
/** A room is deleted after this long with nothing happening. */
const IDLE_MS = 2 * 60 * 60 * 1000;
/** How long each bot takes, so people can follow the game. */
const BOT_MS = 1000;
const MAX_MESSAGE_BYTES = 4096;

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type'
};

// Binary search over the raw list, so waking up a room costs no CPU to parse 173k words.
const lexicon = textLexicon(dictionary);

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
			const body = (await request.json().catch(() => ({}))) as { game?: unknown };
			if (body.game !== 'uno' && body.game !== 'scrabble') return json({ error: 'Unknown game' }, 400);
			for (let i = 0; i < CREATE_ATTEMPTS; i++) {
				const code = randomCode();
				const created = await env.ROOMS.getByName(code).create(code, body.game);
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

/**
 * One game room. Holds the only true copy of the game, using hibernating sockets, so an idle room
 * costs nothing. Each message reads from `room`, which is reloaded from storage after waking.
 */
export class RoomObject extends DurableObject<Env> {
	private room: Room | null = null;
	private lastActive = Date.now();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.room = (await ctx.storage.get<Room>('room')) ?? null;
			this.lastActive = (await ctx.storage.get<number>('lastActive')) ?? Date.now();
		});
	}

	async create(code: string, kind: GameKind) {
		if (this.room) return false;
		this.room = createRoom(code, kind);
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
		if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES || !this.room) return;
		let message: { type?: unknown; seq?: unknown; token?: unknown; name?: unknown; action?: unknown };
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		this.lastActive = Date.now();
		const seq = typeof message.seq === 'number' ? message.seq : null;

		try {
			if (message.type === 'join') await this.join(ws, message.token, message.name);
			else if (message.type === 'start') await this.start(ws);
			else if (message.type === 'action') await this.act(ws, message.action);
		} catch (e) {
			const reason = e instanceof RuleError ? e.message : "That move isn't allowed.";
			if (message.type === 'join') {
				this.sendTo(ws, { type: 'error', reason });
				ws.close(4403, 'Could not join');
			} else {
				this.sendTo(ws, { type: 'rejected', reason, seq });
			}
		}
	}

	private async join(ws: WebSocket, token: unknown, name: unknown) {
		const claimed = typeof token === 'string' && token.length >= 16 && token.length <= 64 ? token : crypto.randomUUID();
		const { room, seat } = joinRoom(this.room!, { token: claimed, name });
		this.room = room;
		// A reconnect can arrive before the old connection has noticed it's dead.
		for (const other of this.ctx.getWebSockets()) {
			if (other !== ws && this.tokenOf(other) === claimed) other.close(4001, 'Replaced');
		}
		ws.serializeAttachment({ token: claimed });
		await this.save();
		this.sendTo(ws, { type: 'joined', seat, token: claimed, code: room.code, game: room.kind });
		this.broadcast();
		await this.schedule();
	}

	private async start(ws: WebSocket) {
		this.room = startRoom(this.room!, this.seatOf(ws), crypto.getRandomValues(new Uint32Array(1))[0]);
		await this.save();
		this.broadcast();
		await this.schedule();
	}

	private async act(ws: WebSocket, action: unknown) {
		this.room = applyAction(this.room!, this.seatOf(ws), action, lexicon);
		await this.afterMove();
	}

	private async afterMove() {
		await this.record();
		await this.save();
		this.broadcast();
		await this.schedule();
	}

	override async webSocketClose(ws: WebSocket) {
		await this.dropped(ws);
	}

	override async webSocketError(ws: WebSocket) {
		await this.dropped(ws);
	}

	private async dropped(ws: WebSocket) {
		const token = this.tokenOf(ws);
		if (!this.room || !token) return;
		const stillHere = this.ctx.getWebSockets().some((other) => other !== ws && this.tokenOf(other) === token);
		const seat = this.room.seats.findIndex((s) => s.token === token);
		if (stillHere || seat < 0) return;
		this.room = setConnected(this.room, seat, false);
		await this.save();
		this.broadcast(ws);
	}

	override async alarm() {
		if (!this.room) return;
		if (botAction(this.room)) {
			this.room = stepBot(this.room);
			await this.afterMove();
			return;
		}
		if (Date.now() - this.lastActive >= IDLE_MS) {
			for (const ws of this.ctx.getWebSockets()) ws.close(4408, 'Room closed');
			this.room = null;
			await this.ctx.storage.deleteAll();
			return;
		}
		await this.schedule();
	}

	/** The next thing to wake for: a bot's move, or else the idle timeout. */
	private async schedule() {
		if (!this.room) return;
		const when = botAction(this.room) ? Date.now() + BOT_MS : this.lastActive + IDLE_MS;
		await this.ctx.storage.setAlarm(when);
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
		if (seat < 0) throw new RuleError('You are not in this room.');
		return seat;
	}

	private sendTo(ws: WebSocket, message: unknown) {
		try {
			ws.send(JSON.stringify(message));
		} catch {
			// Already gone. Its close event deals with the seat.
		}
	}

	/** Sends everyone the seat list, and their own view of the game. */
	private broadcast(except?: WebSocket) {
		if (!this.room) return;
		const seats = presence(this.room);
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === except) continue;
			const token = this.tokenOf(ws);
			if (!token) continue;
			const you = this.room.seats.findIndex((s) => s.token === token);
			this.sendTo(ws, { type: 'presence', ...seats, you });
			const view = seatView(this.room, you);
			if (view) this.sendTo(ws, { type: 'state', view, seq: this.room.seq });
		}
	}
}
