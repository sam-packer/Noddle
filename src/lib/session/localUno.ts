import { chooseAction } from '../games/uno/bot';
import { apply, newGame, viewFor, type Card, type UnoAction, type UnoState, type UnoView } from '../games/uno/engine';
import { RuleError } from '../games/rng';
import { unoEnded, unoNote } from './notes';
import { SnapshotStore } from './store';
import {
	AFTER_MOVE_MS,
	BEFORE_MOVE_MS,
	CARD_MS,
	realWait,
	type GameSession,
	type Seatless,
	type Wait
} from './types';

const NAMES = ['You', 'Ana', 'Ben', 'Cy'];
const ME = 0;
const NO_MOVES = { cards: [], draw: false, keep: false };

const COLOR_ORDER: Card['color'][] = ['red', 'blue', 'green', 'yellow', 'wild'];

/** Groups a hand by colour, so a long one is easy to page through. */
export function sortHand(hand: Card[]) {
	return [...hand].sort(
		(a, b) => COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) || a.value.localeCompare(b.value) || a.id - b.id
	);
}

/** A real game of Uno against three bots, on this device. */
export class LocalUnoSession implements GameSession<UnoView, UnoAction> {
	private state: UnoState;
	private busy = false;
	private closed = false;
	private game = 0;
	private seed: number;
	private wait: Wait;
	private store: SnapshotStore<UnoView>;
	subscribe: SnapshotStore<UnoView>['subscribe'];

	constructor({ seed = Date.now(), wait = realWait }: { seed?: number; wait?: Wait } = {}) {
		this.seed = seed;
		this.wait = wait;
		this.state = newGame({ players: NAMES.length, seed });
		this.store = new SnapshotStore<UnoView>({
			view: this.present(),
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
	}

	private present(): UnoView {
		const view = viewFor(this.state, ME);
		return { ...view, hand: sortHand(view.hand), legal: this.busy ? NO_MOVES : view.legal };
	}

	private show(active: number | null) {
		const { last, hands, phase, winner } = this.state;
		const note = unoNote(last, NAMES, ME, hands.map((h) => h.length));
		const ended = phase === 'over' ? unoEnded(winner, NAMES, ME) : null;
		this.store.set({ view: this.present(), active: ended ? null : active, note, ended });
	}

	send(action: Seatless<UnoAction>) {
		if (this.busy || this.closed || this.state.phase === 'over') return;
		try {
			this.state = apply(this.state, { ...action, seat: ME } as UnoAction);
		} catch (e) {
			if (!(e instanceof RuleError)) throw e;
			this.store.reject(e.message);
			return;
		}
		if (this.state.current === ME && this.state.phase !== 'over' && this.state.phase !== 'play') {
			// Drew a card that can be played, so it's still this player's choice.
			this.show(null);
			return;
		}
		this.busy = this.state.phase !== 'over';
		this.show(null);
		if (this.busy) void this.bots(this.game);
	}

	private async bots(game: number) {
		const stale = () => this.closed || game !== this.game;
		await this.wait(CARD_MS);
		while (!stale() && this.state.phase !== 'over' && this.state.current !== ME) {
			const seat = this.state.current;
			this.store.set({ active: seat });
			await this.wait(BEFORE_MOVE_MS);
			if (stale()) return;
			this.state = apply(this.state, chooseAction(this.state, seat));
			this.show(seat);
			await this.wait(AFTER_MOVE_MS);
		}
		if (stale()) return;
		this.busy = false;
		this.show(null);
	}

	restart() {
		this.game++;
		this.busy = false;
		this.seed = (this.seed + 1) >>> 0;
		this.state = newGame({ players: NAMES.length, seed: this.seed });
		this.store.set({ view: this.present(), active: null, note: '', ended: null, rejected: null });
	}

	close() {
		this.closed = true;
	}
}
