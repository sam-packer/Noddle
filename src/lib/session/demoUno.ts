import {
	demoApply,
	demoFinished,
	demoLegal,
	demoOpponentTurn,
	newDemoUno,
	type DemoAction,
	type DemoUno
} from '../games/uno/demo';
import { RuleError } from '../games/rng';
import { viewFor, type UnoAction, type UnoView } from '../games/uno/engine';
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
const UNO_MS = 3500;
const NO_MOVES = { cards: [], draw: false, keep: false };

/** The scripted Uno run. Whatever the player does, it reaches UNO! and moves on to Scrabble. */
export class DemoUnoSession implements GameSession<UnoView, UnoAction> {
	private demo: DemoUno = newDemoUno();
	private busy = false;
	private closed = false;
	private wait: Wait;
	private store: SnapshotStore<UnoView>;
	subscribe: SnapshotStore<UnoView>['subscribe'];

	constructor({ wait = realWait }: { wait?: Wait } = {}) {
		this.wait = wait;
		this.store = new SnapshotStore<UnoView>({
			view: this.present(),
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
	}

	private present(): UnoView {
		const legal = this.busy || demoFinished(this.demo) ? NO_MOVES : demoLegal(this.demo);
		return { ...viewFor(this.demo.state, 0), legal };
	}

	send(action: Seatless<UnoAction>) {
		if (this.busy || this.closed || this.store.value.ended) return;
		try {
			this.demo = demoApply(this.demo, action as DemoAction);
		} catch (e) {
			if (!(e instanceof RuleError)) throw e;
			this.store.reject(e);
			return;
		}
		this.busy = true;
		this.store.set({ view: this.present() });
		if (demoFinished(this.demo)) {
			this.store.set({ ended: { title: 'UNO!', text: 'One card from winning. Ready for something harder?', advanceMs: UNO_MS, won: true } });
			return;
		}
		void this.opponents();
	}

	private async opponents() {
		await this.wait(CARD_MS);
		for (const step of demoOpponentTurn(this.demo)) {
			if (this.closed) return;
			this.store.set({ active: step.seat });
			await this.wait(BEFORE_MOVE_MS);
			if (this.closed) return;
			this.demo = step();
			this.store.set({ view: this.present(), note: step.draws ? `${NAMES[step.seat]} draws` : '' });
			await this.wait(AFTER_MOVE_MS);
		}
		if (this.closed) return;
		this.busy = false;
		this.store.set({ view: this.present(), active: null, note: '' });
	}

	close() {
		this.closed = true;
	}
}
