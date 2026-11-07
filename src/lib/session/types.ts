/** A game is over, or the script has finished. With advanceMs, the app moves on by itself. */
export type Ended = { title: string; text: string; advanceMs?: number };

export type SessionStatus = 'live' | 'connecting' | 'offline';

export type SessionSnapshot<V> = {
	view: V;
	names: string[];
	/** Who to highlight as moving, or null when nobody is. */
	active: number | null;
	/** What just happened, in words. */
	note: string;
	status: SessionStatus;
	/** The last action refused, numbered so the same reason twice is still noticed. */
	rejected: { reason: string; n: number } | null;
	ended: Ended | null;
	/** Whether the player may walk away from this game. */
	canLeave: boolean;
	/** Whether to show rivals' scores and the options that only matter against them. */
	showOpponents: boolean;
	canRestart: boolean;
};

export type Seatless<A> = A extends unknown ? Omit<A, 'seat'> : never;

/**
 * The only thing game screens talk to. A Svelte store, so `$session` works. Screens never learn
 * whether this is the demo script, a local bot or a room on the server.
 */
export interface GameSession<V, A> {
	subscribe(run: (snapshot: SessionSnapshot<V>) => void): () => void;
	send(action: Seatless<A>): void;
	restart?(): void;
	close(): void;
}

export type Wait = (ms: number) => Promise<void>;
export const realWait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a played card takes to land. */
export const CARD_MS = 450;
/** An opponent is highlighted this long before moving. */
export const BEFORE_MOVE_MS = 350;
/** Then this long passes before the next one, so each move can be followed. */
export const AFTER_MOVE_MS = CARD_MS + 150;
