/**
 * Seeded randomness that lives in game state as a plain number, so a game can be saved, sent to a
 * server and replayed exactly. Each call returns the next state rather than changing anything.
 */
export function nextInt(rng: number, below: number): { value: number; rng: number } {
	// mulberry32
	const next = (rng + 0x6d2b79f5) >>> 0;
	let t = next;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	return { value: Math.floor(unit * below), rng: next };
}

/** Fisher-Yates. Returns a new array. */
export function shuffle<T>(items: readonly T[], rng: number): { items: T[]; rng: number } {
	const out = [...items];
	let state = rng;
	for (let i = out.length - 1; i > 0; i--) {
		const r = nextInt(state, i + 1);
		state = r.rng;
		[out[i], out[r.value]] = [out[r.value], out[i]];
	}
	return { items: out, rng: state };
}

/**
 * Why an action was refused, so screens can choose what to say next without reading the words.
 * The engines, the rooms server and the sessions each add the reasons only they can give.
 */
export type RuleCode =
	// Both games
	| 'bad-setup'
	| 'game-over'
	| 'not-your-turn'
	// Uno
	| 'already-drew'
	| 'draw-first'
	| 'not-your-card'
	| 'play-drawn-card'
	| 'card-mismatch'
	| 'pick-colour'
	// Scrabble
	| 'no-tiles'
	| 'off-board'
	| 'square-taken'
	| 'not-your-tile'
	| 'tile-mismatch'
	| 'not-in-line'
	| 'has-gaps'
	| 'must-cover-centre'
	| 'not-connected'
	| 'not-a-word'
	| 'bag-too-small'
	| 'choose-exchange'
	| 'no-dictionary'
	// Rooms
	| 'bad-move'
	| 'not-running'
	| 'not-seated'
	| 'already-joined'
	| 'already-started'
	| 'room-full'
	| 'not-host'
	| 'needs-players'
	// The connection to the room
	| 'offline'
	| 'move-lost';

/** Thrown when an action breaks the rules. The message is safe to show the player. */
export class RuleError extends Error {
	override name = 'RuleError';

	constructor(
		readonly code: RuleCode,
		message: string
	) {
		super(message);
	}
}
