import type { ScrabbleAction, ScrabbleView } from '../games/scrabble/engine';
import type { UnoAction, UnoView } from '../games/uno/engine';
import { sortHand } from './localUno';
import { scrabbleEnded, scrabbleNote, unoEnded, unoNote } from './notes';
import { SnapshotStore } from './store';
import { realWait, type GameSession, type Seatless, type SessionStatus, type Wait } from './types';

export type RemoteView = UnoView | ScrabbleView;
export type RemoteAction = UnoAction | ScrabbleAction;
export type GameKind = 'uno' | 'scrabble';
export type RoomSeat = { name: string; bot: boolean; connected: boolean };

export type RoomSocket = {
	readyState: number;
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onmessage: ((e: { data: string }) => void) | null;
	onclose: ((e: { code: number }) => void) | null;
	onerror: (() => void) | null;
};

export type LobbyState = {
	code: string;
	status: SessionStatus;
	phase: 'connecting' | 'lobby' | 'playing' | 'over';
	game: GameKind | null;
	seats: RoomSeat[];
	you: number;
	isHost: boolean;
	hasView: boolean;
	/** Why this room can't be used. There's no point retrying after one of these. */
	error: string | null;
};

const OPEN = 1;
const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 10000;
/** A socket can look open long after the network has gone, so a move must be answered by this. */
const ANSWER_MS = 5000;
const LOST_MOVE = 'The connection dropped, so that move was lost. Try it again.';
/** The room has refused, closed or moved this seat, so reconnecting can't help. */
const FINAL_CLOSE_CODES = new Map<number, string>([
	[4001, 'This seat was opened somewhere else.'],
	[4403, 'Could not join that room.'],
	[4404, 'That room does not exist.'],
	[4408, 'That room has closed.']
]);

/** A value that tells subscribers when it changes. A Svelte store. */
class Value<T> {
	private listeners = new Set<(value: T) => void>();
	constructor(public value: T) {}
	subscribe = (run: (value: T) => void) => {
		this.listeners.add(run);
		run(this.value);
		return () => void this.listeners.delete(run);
	};
	set(change: Partial<T>) {
		this.value = { ...this.value, ...change };
		for (const run of this.listeners) run(this.value);
	}
}

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

/**
 * A seat in a room on the rooms worker. The server holds the game, so nothing here predicts: the
 * screen only changes when the server says so, and a refused move simply never appears.
 */
export class RemoteSession implements GameSession<RemoteView, RemoteAction> {
	readonly lobby: Value<LobbyState>;
	private store: SnapshotStore<RemoteView>;
	subscribe: SnapshotStore<RemoteView>['subscribe'];

	private socket: RoomSocket | null = null;
	private closed = false;
	private attempts = 0;
	private seq = 0;
	/** The move still waiting for an answer from the server. */
	private awaiting: number | null = null;
	private view: RemoteView | null = null;
	private code: string;
	private name: string;
	private baseUrl: string;
	private storage: Pick<Storage, 'getItem' | 'setItem'>;
	private createSocket: (url: string) => RoomSocket;
	private wait: Wait;

	constructor(options: {
		baseUrl: string;
		code: string;
		name: string;
		storage: Pick<Storage, 'getItem' | 'setItem'>;
		createSocket?: (url: string) => RoomSocket;
		wait?: Wait;
	}) {
		this.baseUrl = options.baseUrl;
		this.code = options.code;
		this.name = options.name;
		this.storage = options.storage;
		this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as RoomSocket);
		this.wait = options.wait ?? realWait;
		this.lobby = new Value<LobbyState>({
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
		this.store = new SnapshotStore<RemoteView>({
			// Screens only subscribe once the lobby says there's a view.
			view: null as unknown as RemoteView,
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
		this.subscribe = this.store.subscribe;
		this.connect();
	}

	private connect() {
		const url = `${this.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/rooms/${this.code}/ws`;
		let socket: RoomSocket;
		try {
			socket = this.createSocket(url);
		} catch {
			this.lobby.set({ error: "Can't reach the game server.", status: 'offline' });
			return;
		}
		this.socket = socket;
		socket.onopen = () => {
			this.setStatus('live');
			const token = this.storage.getItem(tokenKey(this.code)) ?? undefined;
			socket.send(JSON.stringify({ type: 'join', code: this.code, name: this.name, token }));
		};
		socket.onmessage = (e) => this.receive(JSON.parse(e.data));
		socket.onclose = (e) => {
			if (socket === this.socket) void this.lost(e.code);
		};
		socket.onerror = () => {};
	}

	private setStatus(status: SessionStatus) {
		this.lobby.set({ status });
		if (this.view) this.store.set({ status });
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
		await this.wait(gap);
		if (!this.closed) this.connect();
	}

	/** Reports a move that will never be answered, so the screen stops waiting for it. */
	private failAwaitedMove() {
		if (this.awaiting === null) return;
		this.awaiting = null;
		this.store.reject(LOST_MOVE);
	}

	/** Nothing came back, so this connection is dead whatever it says. Replace it. */
	private replaceSocket() {
		const dead = this.socket;
		this.socket = null;
		dead?.close();
		void this.lost(1006);
	}

	private receive(message: Record<string, unknown>) {
		if (message.type === 'state' || message.type === 'rejected') this.awaiting = null;
		switch (message.type) {
			case 'joined':
				this.attempts = 0;
				this.storage.setItem(tokenKey(this.code), message.token as string);
				this.lobby.set({ game: message.game as GameKind, you: message.seat as number });
				break;
			case 'presence': {
				const you = message.you as number;
				this.lobby.set({
					game: message.game as GameKind,
					phase: message.phase as LobbyState['phase'],
					seats: message.seats as RoomSeat[],
					you,
					isHost: message.host === you
				});
				if (this.view) this.present();
				break;
			}
			case 'state':
				this.view = message.view as RemoteView;
				this.present();
				this.lobby.set({ hasView: true });
				break;
			case 'rejected':
				this.store.reject(message.reason as string);
				break;
			case 'error':
				this.lobby.set({ error: message.reason as string });
				break;
		}
	}

	private present() {
		const raw = this.view!;
		const { seats, isHost, status } = this.lobby.value;
		const names = seats.map((s) => s.name);
		const over = raw.phase === 'over';
		const me = raw.me;
		let note: string;
		let ended: { title: string; text: string } | null;
		let view = raw;
		if (raw.game === 'uno') {
			note = unoNote(raw.last, names, me, raw.counts);
			ended = over ? unoEnded(raw.winner, names, me) : null;
			view = { ...raw, hand: sortHand(raw.hand) };
		} else {
			note = scrabbleNote(raw.last, names, me);
			ended = over ? scrabbleEnded(raw.scores, raw.winner, names, me) : null;
		}
		const toMove = over ? null : raw.current;
		const absent = toMove !== null && seats[toMove] && !seats[toMove].connected;
		if (absent) note = `Waiting for ${names[toMove]} to come back`;
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

	send(action: Seatless<RemoteAction>) {
		if (this.socket?.readyState !== OPEN) {
			this.store.reject('Not connected. Trying to get back in.');
			return;
		}
		const seq = ++this.seq;
		this.awaiting = seq;
		this.socket.send(JSON.stringify({ type: 'action', action, seq }));
		void this.wait(ANSWER_MS).then(() => {
			if (this.awaiting === seq && !this.closed) this.replaceSocket();
		});
	}

	/** Starts the game from the lobby, or another one after it ends. */
	start() {
		if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify({ type: 'start' }));
	}

	restart() {
		this.start();
	}

	close() {
		this.closed = true;
		this.socket?.close();
	}
}
