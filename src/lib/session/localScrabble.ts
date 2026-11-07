import { RuleError } from '../games/rng';
import { apply, newGame, viewFor, type ScrabbleAction, type ScrabbleState, type ScrabbleView } from '../games/scrabble/engine';
import type { Lexicon } from '../games/scrabble/lexicon';
import { scrabbleEnded, scrabbleNote } from './notes';
import { SnapshotStore } from './store';
import { realWait, type GameSession, type Seatless, type Wait } from './types';

const NAMES = ['You', 'Ana'];
const ME = 0;
const BOT = 1;
/** Gives the player time to see the board settle, however quickly the bot decides. */
const BOT_MIN_MS = 1200;

export type ScrabbleBot = (state: ScrabbleState, seat: number) => Promise<ScrabbleAction>;

/** A real game of Scrabble against a bot, on this device. */
export class LocalScrabbleSession implements GameSession<ScrabbleView, ScrabbleAction> {
	private state: ScrabbleState;
	private lexicon: Lexicon | null = null;
	readonly ready: Promise<void>;
	private closed = false;
	private game = 0;
	private seed: number;
	private wait: Wait;
	private bot: ScrabbleBot;
	private onClose?: () => void;
	private store: SnapshotStore<ScrabbleView>;
	subscribe: SnapshotStore<ScrabbleView>['subscribe'];

	constructor(options: {
		seed?: number;
		wait?: Wait;
		lexicon: () => Promise<Lexicon>;
		bot: ScrabbleBot;
		onClose?: () => void;
	}) {
		this.seed = options.seed ?? Date.now();
		this.wait = options.wait ?? realWait;
		this.bot = options.bot;
		this.onClose = options.onClose;
		this.state = newGame({ players: NAMES.length, seed: this.seed });
		this.store = new SnapshotStore<ScrabbleView>({
			view: viewFor(this.state, ME),
			names: NAMES,
			active: null,
			note: '',
			status: 'live',
			rejected: null,
			ended: null,
			canLeave: true,
			showOpponents: true,
			canRestart: true
		});
		this.subscribe = this.store.subscribe;
		this.ready = options.lexicon().then(
			(l) => void (this.lexicon = l),
			() => void (this.lexicon = { has: () => true })
		);
	}

	private show(active: number | null) {
		const { last, phase, scores, winner } = this.state;
		const ended = phase === 'over' ? scrabbleEnded(scores, winner, NAMES, ME) : null;
		this.store.set({
			view: viewFor(this.state, ME),
			active: ended ? null : active,
			note: scrabbleNote(last, NAMES, ME),
			ended
		});
	}

	send(action: Seatless<ScrabbleAction>) {
		const game = this.game;
		void this.ready.then(() => {
			if (this.closed || game !== this.game || this.state.current !== ME || this.state.phase === 'over') return;
			try {
				this.state = apply(this.state, { ...action, seat: ME } as ScrabbleAction, this.lexicon!);
			} catch (e) {
				if (!(e instanceof RuleError)) throw e;
				this.store.reject(e.message);
				return;
			}
			this.show(this.state.phase === 'over' ? null : BOT);
			if (this.state.phase !== 'over') void this.botTurn(game);
		});
	}

	private async botTurn(game: number) {
		const stale = () => this.closed || game !== this.game;
		const [action] = await Promise.all([
			this.bot(this.state, BOT).catch(() => ({ type: 'pass', seat: BOT }) as ScrabbleAction),
			this.wait(BOT_MIN_MS)
		]);
		if (stale()) return;
		try {
			this.state = apply(this.state, action, this.lexicon!);
		} catch {
			this.state = apply(this.state, { type: 'pass', seat: BOT }, this.lexicon!);
		}
		this.show(null);
	}

	restart() {
		this.game++;
		this.seed = (this.seed + 1) >>> 0;
		this.state = newGame({ players: NAMES.length, seed: this.seed });
		this.store.set({ view: viewFor(this.state, ME), active: null, note: '', ended: null, rejected: null });
	}

	close() {
		this.closed = true;
		this.onClose?.();
	}
}
