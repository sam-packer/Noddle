import { RuleError } from '../../../src/lib/games/rng';
import {
	apply as applyScrabble,
	newGame as newScrabble,
	viewFor as scrabbleView,
	type ScrabbleAction,
	type ScrabbleState
} from '../../../src/lib/games/scrabble/engine';
import type { Lexicon } from '../../../src/lib/games/scrabble/lexicon';
import { chooseAction as unoBot } from '../../../src/lib/games/uno/bot';
import { apply as applyUno, newGame as newUno, viewFor as unoView, type UnoAction, type UnoState } from '../../../src/lib/games/uno/engine';
import {
	MAX_NAME,
	type GameKind,
	type Presence,
	type RoomPhase,
	type RoomView,
	type WireAction
} from '../../../src/lib/rooms/protocol';

/**
 * A room as pure data and pure functions. The Durable Object only adds sockets, storage and the
 * clock, which comes in as `now`. Nothing here returns another seat's cards, tiles or token.
 */

export type Seat = {
	name: string;
	/** Proves who someone is when they reconnect. Bots have none. Never sent to other players. */
	token: string | null;
	bot: boolean;
	connected: boolean;
	/** When this player lost their connection, or null while they have one. */
	awaySince: number | null;
	/** Away for longer than the grace period, so a stand-in moves for them until they're back. */
	covered: boolean;
};

export type Room = {
	code: string;
	kind: GameKind;
	phase: RoomPhase;
	seats: Seat[];
	/** The host's token, not their seat, so a reconnect or someone else leaving never moves it. */
	hostToken: string | null;
	game: UnoState | ScrabbleState | null;
	/** Counts every change to the game. */
	version: number;
	/** When the game last changed, which paces bots and stand-ins. */
	movedAt: number;
	/** Whether this game has been written to the results table. */
	recorded: boolean;
};

export type Timing = {
	/** A lobby seat is kept this long after its connection drops, then freed. */
	lobbyGraceMs: number;
	/** In a game, after this long away a stand-in moves for the player, and the host moves on. */
	gameGraceMs: number;
	/** How long each bot or stand-in takes, so people can follow the game. */
	botMs: number;
};

const MAX_SEATS: Record<GameKind, number> = { uno: 4, scrabble: 2 };
const BOT_NAMES = ['Ana', 'Ben', 'Cy'];
const NOT_ALLOWED = "That move isn't allowed.";

export function cleanName(name: unknown) {
	if (typeof name !== 'string') return 'Player';
	const tidy = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
	return tidy || 'Player';
}

export function createRoom(code: string, kind: GameKind, now: number): Room {
	return { code, kind, phase: 'lobby', seats: [], hostToken: null, game: null, version: 0, movedAt: now, recorded: false };
}

/** Adds a number if someone else already has this name, so people can tell who moved. */
function distinctName(name: string, others: Seat[]) {
	const taken = new Set(others.map((s) => s.name));
	if (!taken.has(name)) return name;
	let n = 2;
	while (taken.has(`${name} ${n}`)) n++;
	return `${name} ${n}`;
}

const updateSeat = (room: Room, seat: number, change: Partial<Seat>): Room => ({
	...room,
	seats: room.seats.map((s, i) => (i === seat ? { ...s, ...change } : s))
});

/**
 * Keeps the host while they're here or still inside their grace period. Otherwise it passes to the
 * first person who is connected, so somebody can always start the next game.
 */
function settleHost(room: Room): Room {
	const people = room.seats.filter((s) => !s.bot);
	const host = people.find((s) => s.token === room.hostToken);
	if (host && !host.covered) return room;
	const next = people.find((s) => s.connected) ?? host ?? people.find((s) => !s.covered) ?? null;
	const hostToken = next?.token ?? null;
	return hostToken === room.hostToken ? room : { ...room, hostToken };
}

/** Puts someone in the room: their old seat if the token matches, otherwise the next free one. */
export function joinRoom(room: Room, { token, name }: { token: string; name: unknown }) {
	const existing = room.seats.findIndex((s) => s.token === token);
	if (existing >= 0) {
		const others = room.seats.filter((_, i) => i !== existing);
		const back = updateSeat(room, existing, {
			connected: true,
			awaySince: null,
			covered: false,
			name: distinctName(cleanName(name), others)
		});
		return { room: settleHost(back), seat: existing };
	}
	if (room.phase !== 'lobby') throw new RuleError('already-started', 'That game has already started.');
	if (room.seats.length >= MAX_SEATS[room.kind]) throw new RuleError('room-full', 'That room is full.');
	const seat: Seat = {
		name: distinctName(cleanName(name), room.seats),
		token,
		bot: false,
		connected: true,
		awaySince: null,
		covered: false
	};
	return { room: settleHost({ ...room, seats: [...room.seats, seat] }), seat: room.seats.length };
}

/**
 * A connection dropped. The seat is kept for a grace period, because most drops are a blip or a
 * reload and the same token comes straight back. `expire` deals with anyone who doesn't.
 */
export function dropSeat(room: Room, seat: number, now: number): Room {
	const s = room.seats[seat];
	if (!s || s.bot || !s.connected) return room;
	return updateSeat(room, seat, { connected: false, awaySince: now });
}

/** Leaving on purpose skips the grace period: a lobby seat is freed, a game seat covered, at once. */
export function leaveSeat(room: Room, seat: number, now: number): Room {
	const s = room.seats[seat];
	if (!s || s.bot) return room;
	if (room.phase === 'lobby') return settleHost({ ...room, seats: room.seats.filter((_, i) => i !== seat) });
	return settleHost(updateSeat(room, seat, { connected: false, awaySince: s.awaySince ?? now, covered: true }));
}

const graceFor = (room: Room, timing: Timing) => (room.phase === 'lobby' ? timing.lobbyGraceMs : timing.gameGraceMs);

/** When each absent player's grace period ends, for the seats still waiting on one. */
function graceEnds(room: Room, timing: Timing) {
	const grace = graceFor(room, timing);
	return room.seats.flatMap((s, seat) =>
		!s.connected && !s.covered && s.awaySince !== null ? [{ seat, at: s.awaySince + grace }] : []
	);
}

/** The next time `expire` will have something to do, or null. */
export function nextExpiry(room: Room, timing: Timing): number | null {
	const ends = graceEnds(room, timing).map((e) => e.at);
	return ends.length ? Math.min(...ends) : null;
}

/**
 * Ends the grace periods that have run out: frees those lobby seats, and covers those game seats.
 * Returns the same room when nothing changed.
 */
export function expire(room: Room, now: number, timing: Timing): Room {
	const over = new Set(graceEnds(room, timing).flatMap((e) => (e.at <= now ? [e.seat] : [])));
	if (!over.size) return room;
	const seats =
		room.phase === 'lobby'
			? room.seats.filter((_, i) => !over.has(i))
			: room.seats.map((s, i) => (over.has(i) ? { ...s, covered: true } : s));
	return settleHost({ ...room, seats });
}

export function startRoom(room: Room, seat: number, seed: number, now: number): Room {
	if (room.seats[seat]?.token !== room.hostToken) throw new RuleError('not-host', 'Only the host can start the game.');
	if (room.phase === 'playing') throw new RuleError('already-started', 'The game has already started.');
	let seats = room.seats;
	if (room.kind === 'scrabble') {
		if (seats.length !== MAX_SEATS.scrabble) throw new RuleError('needs-players', 'Scrabble needs 2 players.');
	} else if (!seats.length) {
		throw new RuleError('needs-players', 'Nobody is here yet.');
	} else {
		for (const name of BOT_NAMES.slice(0, MAX_SEATS.uno - seats.length)) {
			const bot: Seat = {
				name: distinctName(name, seats),
				token: null,
				bot: true,
				connected: true,
				awaySince: null,
				covered: false
			};
			seats = [...seats, bot];
		}
	}
	const players = seats.length;
	const game = room.kind === 'uno' ? newUno({ players, seed }) : newScrabble({ players, seed });
	return { ...room, seats, game, phase: 'playing', version: room.version + 1, movedAt: now, recorded: false };
}

/** Puts the seat from the connection on a move, if it's a move for this room's game. */
function seated(kind: GameKind, seat: number, action: WireAction): UnoAction | ScrabbleAction {
	if (kind === 'uno') {
		if (action.type === 'play' || action.type === 'draw' || action.type === 'pass') return { ...action, seat };
	} else if (action.type === 'place' || action.type === 'exchange' || action.type === 'pass') {
		return { ...action, seat };
	}
	throw new RuleError('bad-move', NOT_ALLOWED);
}

function advance(room: Room, game: UnoState | ScrabbleState, now: number): Room {
	return { ...room, game, phase: game.phase === 'over' ? 'over' : 'playing', version: room.version + 1, movedAt: now };
}

function play(game: UnoState | ScrabbleState, action: UnoAction | ScrabbleAction, lexicon: Lexicon) {
	return game.game === 'uno'
		? applyUno(game, action as UnoAction)
		: applyScrabble(game, action as ScrabbleAction, lexicon);
}

/** A player's move. The seat comes from their connection, so nobody can move for anyone else. */
export function applyAction(room: Room, seat: number, action: WireAction, lexicon: Lexicon, now: number): Room {
	if (room.phase !== 'playing' || !room.game) throw new RuleError('not-running', "The game isn't running.");
	return advance(room, play(room.game, seated(room.kind, seat, action), lexicon), now);
}

/**
 * The move a bot, or the stand-in for a covered player, would make now, or null if it's someone
 * else's turn. In Uno a covered player's hand is played by the bot. In Scrabble they pass, because
 * the server can't afford to search for words, and a pass never takes points from anyone.
 * Nothing moves while no person is connected, so an abandoned room can't play itself out.
 */
export function standInAction(room: Room): UnoAction | ScrabbleAction | null {
	if (room.phase !== 'playing' || !room.game) return null;
	if (!room.seats.some((s) => !s.bot && s.connected)) return null;
	const seat = room.game.current;
	const s = room.seats[seat];
	if (!s || !(s.bot || s.covered)) return null;
	return room.game.game === 'uno' ? unoBot(room.game, seat) : { type: 'pass', seat };
}

/** When the next bot or stand-in move is due, or null if none is. */
export function standInDue(room: Room, timing: Timing): number | null {
	return standInAction(room) ? room.movedAt + timing.botMs : null;
}

export function stepStandIn(room: Room, lexicon: Lexicon, now: number): Room {
	const action = standInAction(room);
	if (!action || !room.game) return room;
	return advance(room, play(room.game, action, lexicon), now);
}

export function seatView(room: Room, seat: number): RoomView | null {
	if (!room.game || seat < 0) return null;
	return room.game.game === 'uno' ? unoView(room.game, seat) : scrabbleView(room.game, seat);
}

export function presence(room: Room): Presence {
	return {
		game: room.kind,
		phase: room.phase,
		host: room.seats.findIndex((s) => s.token !== null && s.token === room.hostToken),
		seats: room.seats.map(({ name, bot, connected, covered }) => ({ name, bot, connected, covered }))
	};
}

/** What to write to the results table, once a game has ended. */
export function gameResult(room: Room) {
	if (room.phase !== 'over' || !room.game) return null;
	return { game: room.kind, players: room.seats.length, winnerSeat: room.game.winner };
}
