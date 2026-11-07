import { RuleError } from '../games/rng';
import { apply, newGame, viewFor, type Board, type ScrabbleAction, type ScrabbleState, type ScrabbleView } from '../games/scrabble/engine';
import type { Lexicon } from '../games/scrabble/lexicon';
import { scrabbleNote } from './notes';
import { SnapshotStore } from './store';
import type { GameSession, Seatless } from './types';

const NAMES = ['You', 'Computer'];

/** The computer's opening: BOARD across the centre, with the A on the centre square. */
function opening(): ScrabbleState {
	const board: Board = Object.fromEntries(
		[...'BOARD'].map((letter, i) => [`7,${5 + i}`, { letter, blank: false }])
	);
	return {
		...newGame({ players: 2, seed: 1 }),
		board,
		racks: [[...'TGIMELS'].map((letter, i) => ({ id: i + 1, letter })), []],
		bag: []
	};
}

/** The scripted Scrabble hand. Real rules and scoring, and it ends with the first valid play. */
export class DemoScrabbleSession implements GameSession<ScrabbleView, ScrabbleAction> {
	private state = opening();
	private lexicon: Lexicon | null = null;
	readonly ready: Promise<void>;
	private store: SnapshotStore<ScrabbleView>;
	subscribe: SnapshotStore<ScrabbleView>['subscribe'];

	constructor({ lexicon }: { lexicon: () => Promise<Lexicon> }) {
		this.store = new SnapshotStore<ScrabbleView>({
			view: this.present(false),
			names: NAMES,
			active: null,
			note: '',
			status: 'live',
			rejected: null,
			ended: null,
			canLeave: true,
			showOpponents: false,
			canRestart: false
		});
		this.subscribe = this.store.subscribe;
		this.ready = lexicon().then(
			(l) => void (this.lexicon = l),
			// Without the word list the demo still has to run, so every word counts as valid.
			() => void (this.lexicon = { has: () => true })
		);
	}

	private present(ended: boolean): ScrabbleView {
		return {
			...viewFor(this.state, 0),
			can: { place: !ended, pass: false, exchange: false }
		};
	}

	send(action: Seatless<ScrabbleAction>) {
		if (action.type !== 'place' || this.store.value.ended) return;
		void this.ready.then(() => {
			try {
				this.state = apply(this.state, { ...action, seat: 0 }, this.lexicon!);
			} catch (e) {
				if (!(e instanceof RuleError)) throw e;
				this.store.reject(e.message);
				return;
			}
			const note = scrabbleNote(this.state.last, NAMES, 0);
			const text = this.state.last?.kind === 'place'
				? `${this.state.last.word} for ${this.state.last.score} points!${this.state.last.bingo ? ' That includes the 50 point bingo.' : ''}`
				: note;
			this.store.set({ view: this.present(true), ended: { title: 'You did it', text, won: true } });
		});
	}

	close() {}
}
