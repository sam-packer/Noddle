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
/** A bot that hasn't answered by now never will, so it passes and the game goes on. */
const BOT_GIVE_UP_MS = 15000;
const NO_WORDS_NOTE = "The word list didn't load, so words can't be checked yet";
const NO_WORDS = new RuleError('no-dictionary', "The word list didn't load, so that word can't be checked. Try again in a moment.");
/** Passing and exchanging never look a word up. */
const UNUSED_LEXICON: Lexicon = { has: () => false };

export type ScrabbleBot = (state: ScrabbleState, seat: number) => Promise<ScrabbleAction>;

/** A real game of Scrabble against a bot, on this device. */
export class LocalScrabbleSession implements GameSession<ScrabbleView, ScrabbleAction> {
	private state: ScrabbleState;
	private lexicon: Lexicon | null = null;
	/** Moves are handled one at a time, in order, as each may wait for the word list. */
	private turns: Promise<void>;
	private loadLexicon: () => Promise<Lexicon>;
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
		this.loadLexicon = options.lexicon;
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
		this.turns = this.words().then((words) => {
			if (!words && !this.store.value.note) this.store.set({ note: NO_WORDS_NOTE });
		});
	}

	/**
	 * The word list, trying again if it failed before. Unlike the demo, a real game never accepts a
	 * word it can't check, so without the list a play is refused with a reason.
	 */
	private async words(): Promise<Lexicon | null> {
		if (this.lexicon) return this.lexicon;
		try {
			this.lexicon = await this.loadLexicon();
		} catch {
			return null;
		}
		return this.lexicon;
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
		this.turns = this.turns
			.then(async () => {
				const lexicon = action.type === 'place' ? await this.words() : UNUSED_LEXICON;
				if (this.closed || game !== this.game || this.state.current !== ME || this.state.phase === 'over') return;
				if (!lexicon) {
					this.store.reject(NO_WORDS);
					return;
				}
				try {
					this.state = apply(this.state, { ...action, seat: ME } as ScrabbleAction, lexicon);
				} catch (e) {
					if (!(e instanceof RuleError)) throw e;
					this.store.reject(e);
					return;
				}
				this.show(this.state.phase === 'over' ? null : BOT);
				if (this.state.phase !== 'over') void this.botTurn(game);
			})
			// A bug in one move mustn't stop every move after it.
			.catch((e) => console.error(e));
	}

	private async botTurn(game: number) {
		const stale = () => this.closed || game !== this.game;
		const pass: ScrabbleAction = { type: 'pass', seat: BOT };
		const [chosen] = await Promise.all([
			Promise.race([
				this.bot(this.state, BOT).catch(() => pass),
				realWait(BOT_GIVE_UP_MS).then(() => pass)
			]),
			this.wait(BOT_MIN_MS)
		]);
		// The bot searches its own tree built from the same list, but its word is still checked here.
		const lexicon = chosen.type === 'place' ? await this.words() : UNUSED_LEXICON;
		if (stale()) return;
		try {
			this.state = apply(this.state, lexicon ? chosen : pass, lexicon ?? UNUSED_LEXICON);
		} catch {
			this.state = apply(this.state, pass, UNUSED_LEXICON);
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
