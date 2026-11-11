import type { RuleCode } from '../games/rng';
import type { PlaceTile, ScrabbleAction, ScrabbleView } from '../games/scrabble/engine';
import { COLORS, type Color, type UnoAction, type UnoView } from '../games/uno/engine';
import type { Seatless } from '../session/types';

/**
 * Everything the app and the rooms worker say to each other, in one place, so both sides are
 * checked against the same types. The app and the worker must be deployed together when this changes.
 */

export const GAME_KINDS = ['uno', 'scrabble'] as const;
export type GameKind = (typeof GAME_KINDS)[number];
export const isGameKind = (value: unknown): value is GameKind => GAME_KINDS.includes(value as GameKind);

export type RoomPhase = 'lobby' | 'playing' | 'over';

/** What everyone may know about a seat. Never the token. */
export type SeatPresence = {
	name: string;
	bot: boolean;
	connected: boolean;
	/** Gone long enough that a stand-in moves for them: a bot in Uno, a pass in Scrabble. */
	covered: boolean;
};

export type Presence = {
	game: GameKind;
	phase: RoomPhase;
	/** The host's seat, or -1 while there's nobody to be host. */
	host: number;
	seats: SeatPresence[];
};

export type Views = { uno: UnoView; scrabble: ScrabbleView };
export type RoomView = Views[GameKind];

/** A move as a client sends it. The server takes the seat from the connection. */
export type WireAction = Seatless<UnoAction> | Seatless<ScrabbleAction>;

export type ClientMessage =
	| { type: 'join'; name?: string; token?: string }
	| { type: 'start' }
	/** seq is the client's own count, echoed back with the answer to this move. */
	| { type: 'action'; seq: number; action: WireAction }
	/** Leaving on purpose, so the seat is given up now rather than after a grace period. */
	| { type: 'leave' };

export type ServerMessage =
	| { type: 'joined'; seat: number; token: string; code: string; game: GameKind }
	| ({ type: 'presence'; you: number } & Presence)
	/** version counts every change to the game. seq is set only for the player whose move this answers. */
	| { type: 'state'; view: RoomView; version: number; seq?: number }
	| { type: 'rejected'; code: RuleCode; reason: string; seq: number | null }
	/** The room can't be used. The socket closes after this. */
	| { type: 'error'; reason: string };

export const MAX_NAME = 20;
export const MAX_TILES = 7;
export const MIN_TOKEN = 16;
export const MAX_TOKEN = 64;

type Shape = Record<string, unknown>;
const isObject = (value: unknown): value is Shape => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number => Number.isInteger(value);
const isIntList = (value: unknown): value is number[] =>
	Array.isArray(value) && value.length <= MAX_TILES && value.every(isInt);

function readTile(raw: unknown): PlaceTile | null {
	if (!isObject(raw)) return null;
	const { r, c, tileId, letter } = raw;
	if (!isInt(r) || !isInt(c) || !isInt(tileId) || typeof letter !== 'string' || letter.length !== 1) return null;
	return { r, c, tileId, letter };
}

/** Rebuilds a move from only the parts that are checked, so nothing else the client sent survives. */
export function readAction(raw: unknown): WireAction | null {
	if (!isObject(raw)) return null;
	switch (raw.type) {
		case 'pass':
			return { type: 'pass' };
		case 'draw':
			return { type: 'draw' };
		case 'play': {
			if (!isInt(raw.cardId)) return null;
			if (raw.color === undefined) return { type: 'play', cardId: raw.cardId };
			if (!COLORS.includes(raw.color as Color)) return null;
			return { type: 'play', cardId: raw.cardId, color: raw.color as Color };
		}
		case 'place': {
			if (!Array.isArray(raw.tiles) || raw.tiles.length > MAX_TILES) return null;
			const tiles = raw.tiles.map(readTile);
			return tiles.every((t) => t !== null) ? { type: 'place', tiles: tiles as PlaceTile[] } : null;
		}
		case 'exchange':
			return isIntList(raw.tileIds) ? { type: 'exchange', tileIds: raw.tileIds } : null;
		default:
			return null;
	}
}

/**
 * Narrows anything that arrived on the socket to a message the server understands. A move it can't
 * read still gives back its seq, so the sender can be told it was refused.
 */
export function readClientMessage(raw: unknown): { message: ClientMessage } | { message: null; seq: number | null } {
	if (!isObject(raw)) return { message: null, seq: null };
	switch (raw.type) {
		case 'join': {
			const name = typeof raw.name === 'string' ? raw.name : undefined;
			const token =
				typeof raw.token === 'string' && raw.token.length >= MIN_TOKEN && raw.token.length <= MAX_TOKEN
					? raw.token
					: undefined;
			return { message: { type: 'join', name, token } };
		}
		case 'start':
			return { message: { type: 'start' } };
		case 'leave':
			return { message: { type: 'leave' } };
		case 'action': {
			const seq = isInt(raw.seq) ? raw.seq : null;
			const action = readAction(raw.action);
			if (seq === null || !action) return { message: null, seq };
			return { message: { type: 'action', seq, action } };
		}
		default:
			return { message: null, seq: null };
	}
}

const isSeat = (raw: unknown): raw is SeatPresence =>
	isObject(raw) &&
	typeof raw.name === 'string' &&
	typeof raw.bot === 'boolean' &&
	typeof raw.connected === 'boolean' &&
	typeof raw.covered === 'boolean';

/**
 * Narrows what the client receives. The server is trusted for the game views themselves, so only
 * the parts the client branches on are checked.
 */
export function readServerMessage(raw: unknown): ServerMessage | null {
	if (!isObject(raw)) return null;
	switch (raw.type) {
		case 'joined':
			return isInt(raw.seat) && typeof raw.token === 'string' && typeof raw.code === 'string' && isGameKind(raw.game)
				? { type: 'joined', seat: raw.seat, token: raw.token, code: raw.code, game: raw.game }
				: null;
		case 'presence':
			return isInt(raw.you) &&
				isInt(raw.host) &&
				isGameKind(raw.game) &&
				(raw.phase === 'lobby' || raw.phase === 'playing' || raw.phase === 'over') &&
				Array.isArray(raw.seats) &&
				raw.seats.every(isSeat)
				? { type: 'presence', you: raw.you, host: raw.host, game: raw.game, phase: raw.phase, seats: raw.seats }
				: null;
		case 'state':
			return isObject(raw.view) && isGameKind(raw.view.game) && isInt(raw.version)
				? {
						type: 'state',
						view: raw.view as RoomView,
						version: raw.version,
						seq: isInt(raw.seq) ? raw.seq : undefined
					}
				: null;
		case 'rejected':
			return typeof raw.reason === 'string' && typeof raw.code === 'string'
				? {
						type: 'rejected',
						code: raw.code as RuleCode,
						reason: raw.reason,
						seq: isInt(raw.seq) ? raw.seq : null
					}
				: null;
		case 'error':
			return typeof raw.reason === 'string' ? { type: 'error', reason: raw.reason } : null;
		default:
			return null;
	}
}
