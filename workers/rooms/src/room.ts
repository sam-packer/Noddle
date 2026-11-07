import { RuleError } from '../../../src/lib/games/rng';
import {
	apply as applyScrabble,
	newGame as newScrabble,
	viewFor as scrabbleView,
	type ScrabbleAction,
	type ScrabbleState,
	type ScrabbleView
} from '../../../src/lib/games/scrabble/engine';
import type { Lexicon } from '../../../src/lib/games/scrabble/lexicon';
import { chooseAction as unoBot } from '../../../src/lib/games/uno/bot';
import {
	apply as applyUno,
	newGame as newUno,
	viewFor as unoView,
	type UnoAction,
	type UnoState,
	type UnoView
} from '../../../src/lib/games/uno/engine';

/**
 * A room as pure data and pure functions. The Durable Object only adds sockets and storage, so all
 * of this is tested without a server. Nothing here returns another seat's cards, tiles or token.
 */
export type GameKind = 'uno' | 'scrabble';

export type Seat = {
	name: string;
	/** Proves who someone is when they reconnect. Bots have none. Never sent to other players. */
	token: string | null;
	bot: boolean;
	connected: boolean;
};

export type Room = {
	code: string;
	kind: GameKind;
	phase: 'lobby' | 'playing' | 'over';
	seats: Seat[];
	host: number;
	game: UnoState | ScrabbleState | null;
	seq: number;
	/** Whether this game has been written to the results table. */
	recorded: boolean;
};

export type Presence = {
	game: GameKind;
	phase: Room['phase'];
	host: number;
	seats: { name: string; bot: boolean; connected: boolean }[];
};

const MAX_SEATS: Record<GameKind, number> = { uno: 4, scrabble: 2 };
const BOT_NAMES = ['Ana', 'Ben', 'Cy'];
const MAX_NAME = 20;
const MAX_TILES = 7;

export function cleanName(name: unknown) {
	if (typeof name !== 'string') return 'Player';
	const tidy = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
	return tidy || 'Player';
}

export function createRoom(code: string, kind: GameKind): Room {
	return { code, kind, phase: 'lobby', seats: [], host: 0, game: null, seq: 0, recorded: false };
}

/** Puts someone in the room: their old seat if the token matches, otherwise the next free one. */
export function joinRoom(room: Room, { token, name }: { token: string; name: unknown }) {
	const existing = room.seats.findIndex((s) => s.token === token);
	if (existing >= 0) {
		const seats = room.seats.map((s, i) =>
			i === existing ? { ...s, connected: true, name: cleanName(name) } : s
		);
		return { room: { ...room, seats }, seat: existing };
	}
	if (room.phase !== 'lobby') throw new RuleError('That game has already started.');
	if (room.seats.length >= MAX_SEATS[room.kind]) throw new RuleError('That room is full.');
	const seat: Seat = { name: cleanName(name), token, bot: false, connected: true };
	return { room: { ...room, seats: [...room.seats, seat] }, seat: room.seats.length };
}

/**
 * Before the game starts, leaving frees the seat. Once it has started the seat is kept for the
 * player's return, and the game waits, because a bot never takes a person's seat.
 */
export function setConnected(room: Room, seat: number, connected: boolean): Room {
	if (room.phase === 'lobby' && !connected) {
		const seats = room.seats.filter((_, i) => i !== seat);
		const host = seat === room.host ? 0 : seat < room.host ? room.host - 1 : room.host;
		return { ...room, seats, host };
	}
	return { ...room, seats: room.seats.map((s, i) => (i === seat ? { ...s, connected } : s)) };
}

export function startRoom(room: Room, seat: number, seed: number): Room {
	if (seat !== room.host) throw new RuleError('Only the host can start the game.');
	if (room.phase === 'playing') throw new RuleError('The game has already started.');
	let seats = room.seats;
	if (room.kind === 'scrabble') {
		if (seats.length !== MAX_SEATS.scrabble) throw new RuleError('Scrabble needs 2 players.');
	} else if (!seats.length) {
		throw new RuleError('Nobody is here yet.');
	} else {
		const bots: Seat[] = BOT_NAMES.slice(0, MAX_SEATS.uno - seats.length).map((name) => ({
			name,
			token: null,
			bot: true,
			connected: true
		}));
		seats = [...seats, ...bots];
	}
	const players = seats.length;
	const game = room.kind === 'uno' ? newUno({ players, seed }) : newScrabble({ players, seed });
	return { ...room, seats, game, phase: 'playing', seq: room.seq + 1, recorded: false };
}

/** Rebuilds what the client sent from the checked parts, with the seat from the connection. */
function readAction(kind: GameKind, seat: number, raw: unknown): UnoAction | ScrabbleAction {
	if (!raw || typeof raw !== 'object') throw new RuleError("That move isn't allowed.");
	const a = raw as Record<string, unknown>;
	if (a.type === 'pass') return { type: 'pass', seat };
	if (kind === 'uno') {
		if (a.type === 'draw') return { type: 'draw', seat };
		if (a.type === 'play' && typeof a.cardId === 'number') {
			return { type: 'play', seat, cardId: a.cardId, color: a.color as UnoState['activeColor'] | undefined };
		}
	} else {
		if (a.type === 'place' && Array.isArray(a.tiles) && a.tiles.length <= MAX_TILES) {
			const tiles = a.tiles.map((t) => {
				const { r, c, tileId, letter } = (t ?? {}) as Record<string, unknown>;
				if (typeof letter !== 'string') throw new RuleError("That move isn't allowed.");
				return { r: Number(r), c: Number(c), tileId: Number(tileId), letter };
			});
			return { type: 'place', seat, tiles };
		}
		if (a.type === 'exchange' && Array.isArray(a.tileIds)) {
			return { type: 'exchange', seat, tileIds: a.tileIds.map(Number) };
		}
	}
	throw new RuleError("That move isn't allowed.");
}

function advance(room: Room, game: UnoState | ScrabbleState): Room {
	return { ...room, game, phase: game.phase === 'over' ? 'over' : 'playing', seq: room.seq + 1 };
}

/** A player's move. The seat comes from their connection, so nobody can move for anyone else. */
export function applyAction(room: Room, seat: number, raw: unknown, lexicon: Lexicon): Room {
	if (room.phase !== 'playing' || !room.game) throw new RuleError("The game isn't running.");
	const action = readAction(room.kind, seat, raw);
	const game =
		room.game.game === 'uno'
			? applyUno(room.game, action as UnoAction)
			: applyScrabble(room.game, action as ScrabbleAction, lexicon);
	return advance(room, game);
}

/** The move a bot would make now, or null if it isn't a bot's turn. */
export function botAction(room: Room): UnoAction | null {
	if (room.phase !== 'playing' || room.game?.game !== 'uno') return null;
	const seat = room.game.current;
	return room.seats[seat]?.bot ? unoBot(room.game, seat) : null;
}

export function stepBot(room: Room): Room {
	const action = botAction(room);
	if (!action) return room;
	return advance(room, applyUno(room.game as UnoState, action));
}

export function seatView(room: Room, seat: number): UnoView | ScrabbleView | null {
	if (!room.game || seat < 0) return null;
	return room.game.game === 'uno' ? unoView(room.game, seat) : scrabbleView(room.game, seat);
}

export function presence(room: Room): Presence {
	return {
		game: room.kind,
		phase: room.phase,
		host: room.host,
		seats: room.seats.map(({ name, bot, connected }) => ({ name, bot, connected }))
	};
}

/** What to write to the results table, once a game has ended. */
export function gameResult(room: Room) {
	if (room.phase !== 'over' || !room.game) return null;
	return { game: room.kind, players: room.seats.length, winnerSeat: room.game.winner };
}
