import { RuleError } from '../games/rng';
import type { ScrabbleAction } from '../games/scrabble/engine';
import { sortHand, type UnoAction } from '../games/uno/engine';
import {
	readServerMessage,
	type ClientMessage,
	type GameKind,
	type RoomPhase,
	type RoomView,
	type SeatPresence,
	type ServerMessage,
	type Views,
	type WireAction
} from '../rooms/protocol';
import { scrabbleEnded, scrabbleNote, unoEnded, unoNote } from './notes';
import { SnapshotStore, Store } from './store';
import { realWait, type Ended, type GameSession, type SessionSnapshot, type SessionStatus } from './types';

export type { GameKind } from '../rooms/protocol';

type Actions = { uno: UnoAction; scrabble: ScrabbleAction };

export type LobbyState = {
	code: string;
	status: SessionStatus;
	phase: 'connecting' | RoomPhase;
	game: GameKind | null;
	seats: SeatPresence[];
	you: number;
	isHost: boolean;
	hasView: boolean;
	/** Why this room can't be used. There's no point retrying after one of these. */
	error: string | null;
};

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 10000;
/** A socket can look open long after the network has gone, so a move must be answered by this. */
const ANSWER_MS = 5000;
const MOVE_LOST = new RuleError('move-lost', 'The connection dropped, so that move was lost. Try it again.');
const OFFLINE = new RuleError('offline', 'Not connected. Trying to get back in.');
/** The room has refused, closed or moved this seat, so reconnecting can't help. */
const FINAL_CLOSE_CODES = new Map<number, string>([
	[4001, 'This seat was opened somewhere else.'],
	[4403, 'Could not join that room.'],
	[4404, 'That room does not exist.'],
	[4408, 'That room has closed.']
]);

const tokenKey = (code: string) => `noddle.room.${code}`;

/** Whether this browser already holds a seat in a room, so it can go straight back in. */
export function hasSeatToken(storage: Pick<Storage, 'getItem'>, code: string) {
	return storage.getItem(tokenKey(code)) !== null;
}

/** Asks the rooms worker for a new room. */
export async function createRoom(baseUrl: string, game: GameKind): Promise<string> {
	const response = await fetch(`${baseUrl}/rooms`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ game })
	});
	if (!response.ok) throw new Error(`The rooms server said ${response.status}`);
	return ((await response.json()) as { code: string }).code;
}

/** How a seat is named on the game screen, so everyone can see who is away or being covered. */
function seatName(seat: SeatPresence, game: RoomView['game']) {
	if (seat.covered) return game === 'uno' ? `${seat.name} (bot)` : `${seat.name} (away)`;
	return seat.connected ? seat.name : `${seat.name} (away)`;
}

const isView = <K extends GameKind>(view: RoomView | null, kind: K): view is Views[K] => view?.game === kind;

/**
 * A seat in a room on the rooms worker. The server holds the game, so nothing here predicts: the
 * screen only changes when the server says so, and a refused move simply never appears.
 */
export class RemoteSession {
	readonly lobby: Store<LobbyState>;
	/** The game as this seat sees it. There's no view until the server sends the first one. */
	private store: SnapshotStore<RoomView | null>;
	private sessions: { [K in GameKind]: GameSession<Views[K], Actions[K]> };

	private socket: WebSocket | null = null;
	private closed = false;
	private attempts = 0;
	private seq = 0;
	/** The move still waiting for an answer from the server. */
	private awaiting: number | null = null;
	private code: string;
	private name: string;
	private baseUrl: string;
	private storage: Pick<Storage, 'getItem' | 'setItem'>;

	constructor(options: { baseUrl: string; code: string; name: string; storage: Pick<Storage, 'getItem' | 'setItem'> }) {
		this.baseUrl = options.baseUrl;
		this.code = options.code;
		this.name = options.name;
		this.storage = options.storage;
		this.lobby = new Store<LobbyState>({
			code: options.code,
			status: 'connecting',
			phase: 'connecting',
			game: null,
			seats: [],
			you: -1,
			isHost: false,
			hasView: false,
			error: null
		});
		this.store = new SnapshotStore<RoomView | null>({
			view: null,
			names: [],
			active: null,
			note: '',
			status: 'connecting',
			rejected: null,
			ended: null,
			canLeave: true,
			showOpponents: true,
			canRestart: false
		});
		this.sessions = { uno: this.sessionFor('uno'), scrabble: this.sessionFor('scrabble') };
		this.connect();
	}

	/**
	 * This room as a session for one game's screen, or null until the server has sent a view of that
	 * game. The same object comes back each time, so a screen isn't handed a new session on every update.
	 */
	as<K extends GameKind>(kind: K): GameSession<Views[K], Actions[K]> | null {
		return isView(this.store.value.view, kind) ? this.sessions[kind] : null;
	}

	private sessionFor<K extends GameKind>(kind: K): GameSession<Views[K], Actions[K]> {
		return {
			subscribe: (run) =>
				this.store.subscribe((snapshot) => {
					const { view } = snapshot;
					if (isView(view, kind)) run({ ...snapshot, view } satisfies SessionSnapshot<Views[K]>);
				}),
			send: (action) => this.send(action as WireAction),
			restart: () => this.start(),
			close: () => this.close()
		};
	}

	private connect() {
		const url = `${this.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/rooms/${this.code}/ws`;
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch {
			this.lobby.set({ error: "Can't reach the game server.", status: 'offline' });
			return;
		}
		this.socket = socket;
		socket.onopen = () => {
			this.setStatus('live');
			const token = this.storage.getItem(tokenKey(this.code)) ?? undefined;
			this.post({ type: 'join', name: this.name, token });
		};
		socket.onmessage = (e: MessageEvent) => {
			let message: ServerMessage | null = null;
			try {
				message = readServerMessage(JSON.parse(String(e.data)));
			} catch {
				// Not JSON, so not from the rooms worker.
			}
			if (message) this.receive(message);
		};
		socket.onclose = (e) => {
			if (socket === this.socket) void this.lost(e.code);
		};
		socket.onerror = () => {};
	}

	private post(message: ClientMessage) {
		this.socket?.send(JSON.stringify(message));
	}

	private setStatus(status: SessionStatus) {
		this.lobby.set({ status });
		if (this.store.value.view) this.store.set({ status });
	}

	private async lost(code: number) {
		if (this.closed || this.lobby.value.error) return;
		this.failAwaitedMove();
		const final = FINAL_CLOSE_CODES.get(code);
		if (final) {
			this.lobby.set({ error: final, status: 'offline' });
			return;
		}
		this.setStatus('offline');
		const gap = Math.min(FIRST_RETRY_MS * 2 ** this.attempts, MAX_RETRY_MS);
		this.attempts++;
		await realWait(gap);
		if (!this.closed) this.connect();
	}

	/** Reports a move that will never be answered, so the screen stops waiting for it. */
	private failAwaitedMove() {
		if (this.awaiting === null) return;
		this.awaiting = null;
		this.store.reject(MOVE_LOST);
	}

	/** Nothing came back, so this connection is dead whatever it says. Replace it. */
	private replaceSocket() {
		const dead = this.socket;
		this.socket = null;
		dead?.close();
		void this.lost(1006);
	}

	private receive(message: ServerMessage) {
		// Only the answer to this seat's own move counts. Other players' and bots' moves don't.
		if ((message.type === 'state' || message.type === 'rejected') && message.seq === this.awaiting) {
			this.awaiting = null;
		}
		switch (message.type) {
			case 'joined':
				this.attempts = 0;
				this.storage.setItem(tokenKey(this.code), message.token);
				this.lobby.set({ game: message.game, you: message.seat });
				break;
			case 'presence': {
				const { game, phase, seats, you, host } = message;
				this.lobby.set({ game, phase, seats, you, isHost: host === you });
				if (this.store.value.view) this.present(this.store.value.view);
				break;
			}
			case 'state':
				this.present(message.view);
				this.lobby.set({ hasView: true });
				break;
			case 'rejected':
				this.store.reject({ code: message.code, message: message.reason });
				break;
			case 'error':
				this.lobby.set({ error: message.reason });
				break;
		}
	}

	private present(raw: RoomView) {
		const { seats, isHost, status } = this.lobby.value;
		const names = seats.map((s) => seatName(s, raw.game));
		const over = raw.phase === 'over';
		const me = raw.me;
		let note: string;
		let ended: Ended | null;
		let view: RoomView = raw;
		if (raw.game === 'uno') {
			note = unoNote(raw.last, names, me, raw.counts);
			ended = over ? unoEnded(raw.winner, names, me) : null;
			view = { ...raw, hand: sortHand(raw.hand) };
		} else {
			note = scrabbleNote(raw.last, names, me);
			ended = over ? scrabbleEnded(raw.scores, raw.winner, names, me) : null;
		}
		const toMove = over ? null : raw.current;
		const waiting = toMove !== null && seats[toMove] && !seats[toMove].connected && !seats[toMove].covered;
		if (waiting) note = `Waiting for ${seats[toMove].name} to come back`;
		this.store.set({
			view,
			names,
			note,
			ended,
			status,
			active: toMove === me ? null : toMove,
			canRestart: over && isHost
		});
	}

	private send(action: WireAction) {
		if (this.socket?.readyState !== WebSocket.OPEN) {
			this.store.reject(OFFLINE);
			return;
		}
		const seq = ++this.seq;
		this.awaiting = seq;
		this.post({ type: 'action', action, seq });
		void realWait(ANSWER_MS).then(() => {
			if (this.awaiting === seq && !this.closed) this.replaceSocket();
		});
	}

	/** Starts the game from the lobby, or another one after it ends. */
	start() {
		if (this.socket?.readyState === WebSocket.OPEN) this.post({ type: 'start' });
	}

	/** Leaving on purpose gives the seat up at once, rather than holding it for a grace period. */
	close() {
		if (this.closed) return;
		this.closed = true;
		if (this.socket?.readyState === WebSocket.OPEN) this.post({ type: 'leave' });
		this.socket?.close();
	}
}
