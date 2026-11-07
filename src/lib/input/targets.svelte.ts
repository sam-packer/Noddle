import { session } from '../session';
import { hitbox } from './hitbox';
import { engine } from '../vision/engine.svelte';
import type { Point } from '../vision/math';

export type ConfirmContext = { point: Point | null; via: 'gaze' | 'mouse' | 'key' };

export type TargetDef = {
	id: string;
	legal: boolean;
	/** The player's choice tells us where they were looking, so it can calibrate the models. */
	calib?: boolean;
	/** Packed edge to edge, like board squares, so only the one under the pointer can be selected. */
	exact?: boolean;
	/** Costly to hit by accident, so the pointer must really go there and already be there as the nod starts. */
	deliberate?: boolean;
	confirm: (ctx: ConfirmContext) => void;
};

type Entry = { el: HTMLElement; def: TargetDef };

/** Another target must be this much nearer than the selected one to take over. */
const SWITCH_RATIO = 1.3;
/** It must stay nearer this long, so a shaky pointer doesn't flicker between two targets. */
const SWITCH_MS = 100;
const EXACT_RELEASE_PX = 30;
/** The pointer stops at the screen's edge, so this is just enough to reach a corner button from there. */
const DELIBERATE_SELECT_PX = 45;
/**
 * Squares touch, and a head drifts a little as a nod begins, so the pointer must be this far into
 * the next square before it takes over. Otherwise the tile lands one square off.
 */
const EXACT_SWITCH_PX = 24;
const HOLD_NO_GAZE_MS = 1000;
/** The pointer only leans toward targets up to this wide. */
const MAGNET_MAX_WIDTH_PX = 320;
/** It doesn't lean when another target is this close, because exactly where it is matters then. */
const MAGNET_CLEAR_PX = 260;
const MOUSE_PRIORITY_MS = 1500;
/**
 * A nod moves the head up and down. This much sideways after it began means the player was still
 * arriving, so the neighbour they arrived at is what they meant, and not the one they passed.
 */
const STILL_ARRIVING_PX = 100;

/** How far the pointer is outside a target. Zero when it is on the target. */
function rectGap(r: DOMRect, p: Point) {
	const dx = Math.max(r.left - p.x, 0, p.x - r.right);
	const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
	return Math.hypot(dx, dy);
}

function rectDistance(r: DOMRect, p: Point) {
	const inside = rectGap(r, p);
	// Small centre term so overlapping or adjacent targets resolve sensibly.
	const centre = Math.hypot(r.left + r.width / 2 - p.x, r.top + r.height / 2 - p.y);
	return inside + centre * 0.05;
}

/** Tiles, cards and colours sit in a row of their kind, named like `rack-3`. */
const kindOf = (id: string) => id.split('-')[0];

function centreOf(el: HTMLElement): Point {
	const r = el.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

class Targets {
	focused = $state<string | null>(null);
	/** Centre of the focused target, so the pointer can lean toward it. */
	focusCentre = $state<Point | null>(null);
	enabled = $state(true);
	/** Nods that landed on nothing, so a stage can tell the player where to point. */
	missedNods = $state(0);
	onCancel: (() => void) | null = null;

	private entries = new Map<string, Entry>();
	private pendingSwitch: { id: string; since: number } | null = null;
	private lastGaze = 0;
	private inputPriorityUntil = 0;
	private history: { t: number; id: string | null }[] = [];

	/**
	 * Sets what a shake does, and returns how to give that up. A new stage starts before the old
	 * one is destroyed, so the old one must only clear the handler if it is still its own.
	 */
	claimCancel(handler: () => void) {
		this.onCancel = handler;
		return () => {
			if (this.onCancel === handler) this.onCancel = null;
		};
	}

	register(el: HTMLElement, def: TargetDef) {
		this.entries.set(def.id, { el, def });
	}

	update(el: HTMLElement, def: TargetDef) {
		const e = this.entries.get(def.id);
		if (e) e.def = def;
		else this.entries.set(def.id, { el, def });
		if (this.focused === def.id && !def.legal) this.setFocus(null);
	}

	unregister(id: string) {
		this.entries.delete(id);
		if (this.focused === id) this.setFocus(null);
	}

	private setFocus(id: string | null) {
		if (this.focused === id) return;
		this.focused = id;
		const p = engine.pointer;
		session.event('focus', { id, x: p && Math.round(p.x), y: p && Math.round(p.y) });
		this.history.push({ t: performance.now(), id });
		if (this.history.length > 40) this.history.shift();
	}

	private legalAt(p: Point | null) {
		if (!p) return undefined;
		return this.legalEntries().find((e) => {
			const r = e.el.getBoundingClientRect();
			const inset = e.def.exact ? EXACT_SWITCH_PX : 0;
			return (
				p.x >= r.left + inset &&
				p.x <= r.right - inset &&
				p.y >= r.top + inset &&
				p.y <= r.bottom - inset
			);
		});
	}

	private legalEntries() {
		return [...this.entries.values()].filter((e) => e.def.legal);
	}

		/** How far outside a target the pointer can be and still select it, then keep it selected. */
	private reach(e: Entry) {
		if (e.def.exact) return { select: 0, keep: EXACT_RELEASE_PX };
		if (e.def.deliberate) return { select: DELIBERATE_SELECT_PX, keep: hitbox.releasePx };
		return { select: hitbox.padPx, keep: hitbox.releasePx };
	}

	/**
	 * Called every camera frame. The nearest legal target within reach is selected, so the highlight
	 * always follows the pointer. Pointing away from everything selects nothing, so a nod there
	 * does nothing.
	 */
	updateGaze(p: Point | null, t: number, held = false) {
		if (!this.enabled || t < this.inputPriorityUntil) return;
		if (this.focused && !this.entries.get(this.focused)?.def.legal) this.setFocus(null);
		this.updateFocusCentre();

		// A possible nod keeps what is selected, but must not stop something being selected.
		if (held && this.focused) return;
		if (!p) {
			if (t - this.lastGaze > HOLD_NO_GAZE_MS) this.setFocus(null);
			return;
		}
		this.lastGaze = t;

		let best: string | null = null;
		let bestD = Infinity;
		let currentD = Infinity;
		let staysOnSquare = false;
		for (const e of this.legalEntries()) {
			const rect = e.el.getBoundingClientRect();
			const gap = rectGap(rect, p);
			const d = rectDistance(rect, p);
			const { select, keep } = this.reach(e);
			if (e.def.id === this.focused) {
				currentD = d;
				staysOnSquare = !!e.def.exact && gap < EXACT_SWITCH_PX;
				if (gap > keep) this.setFocus(null);
			}
			if (gap <= select && d < bestD) {
				bestD = d;
				best = e.def.id;
			}
		}
		if (staysOnSquare && this.focused) {
			this.pendingSwitch = null;
			return;
		}
		if (!best || !this.focused || best === this.focused || bestD * SWITCH_RATIO >= currentD) {
			this.pendingSwitch = null;
			if (best && !this.focused) this.setFocus(best);
			return;
		}
		if (this.pendingSwitch?.id !== best) {
			this.pendingSwitch = { id: best, since: t };
		} else if (t - this.pendingSwitch.since >= SWITCH_MS) {
			this.setFocus(best);
			this.pendingSwitch = null;
		}
	}

	private updateFocusCentre() {
		const el = this.focused ? this.entries.get(this.focused)?.el : null;
		// On something large, like the board, where exactly the player points still matters.
		const small = el && el.getBoundingClientRect().width <= MAGNET_MAX_WIDTH_PX;
		const centre = small ? centreOf(el) : null;
		const crowded =
			centre &&
			this.legalEntries().some((e) => {
				if (e.el === el) return false;
				const c = centreOf(e.el);
				return Math.hypot(c.x - centre.x, c.y - centre.y) < MAGNET_CLEAR_PX;
			});
		const next = crowded ? null : centre;
		if (next?.x !== this.focusCentre?.x || next?.y !== this.focusCentre?.y) this.focusCentre = next;
	}

	/** A nod. The head moves during it, so use what was focused just before it began. */
	confirmGaze(onset: number) {
		if (!this.enabled) return;
		let id = this.focused;
		for (let i = this.history.length - 1; i >= 0; i--) {
			if (this.history[i].t <= onset) {
				id = this.history[i].id;
				break;
			}
		}
		let entry = id ? this.entries.get(id) : undefined;
		if (!entry?.def.legal) entry = this.focused ? this.entries.get(this.focused) : undefined;
		// The highlight trails the pointer slightly. If the pointer was already on something when
		// the nod began, that is what the player meant, whatever was still highlighted.
		const under = this.legalAt(engine.pointerAt(onset));
		if (under) entry = under;
		const arrived = this.arrivedAt(entry, onset);
		if (arrived) entry = arrived;
		if (entry?.def.deliberate && entry.def.id !== id && entry !== under) entry = undefined;
		const point = engine.pointAt(onset);
		session.event('confirm', {
			chose: entry?.def.legal ? entry.def.id : null,
			wasAtOnset: id,
			arrived: !!arrived,
			selectedNow: this.focused,
			onset,
			x: point && Math.round(point.x),
			y: point && Math.round(point.y),
			targets: this.legalEntries().map((e) => {
				const r = e.el.getBoundingClientRect();
				return [e.def.id, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
			})
		});
		if (!entry?.def.legal) {
			this.missedNods += 1;
			return;
		}
		if (entry.def.calib) engine.addSample(centreOf(entry.el), onset);
		entry.def.confirm({ point, via: 'gaze' });
	}

	/**
	 * The neighbour to use instead, if the head was still sweeping along a row when the nod began.
	 * Only ever another of the same kind: a big nod can drop the pointer onto Play or Leave by the
	 * time it fires, and board squares are close enough that the start of the nod must decide.
	 */
	private arrivedAt(entry: Entry | undefined, onset: number) {
		const now = this.focused ? this.entries.get(this.focused) : undefined;
		if (!entry || !now?.def.legal || now === entry || now.def.exact) return null;
		if (kindOf(now.def.id) !== kindOf(entry.def.id)) return null;
		const from = engine.pointerAt(onset);
		const to = engine.pointerNow();
		return from && to && Math.abs(to.x - from.x) >= STILL_ARRIVING_PX ? now : null;
	}

	cancel() {
		session.event('cancel', { handled: this.enabled && !!this.onCancel });
		if (this.enabled) this.onCancel?.();
	}

	mouseEnter(id: string) {
		this.inputPriorityUntil = performance.now() + MOUSE_PRIORITY_MS;
		if (this.entries.get(id)?.def.legal) this.setFocus(id);
	}

	mouseMoved() {
		this.inputPriorityUntil = performance.now() + MOUSE_PRIORITY_MS;
	}

	click(id: string, point: Point) {
		const e = this.entries.get(id);
		if (e?.def.legal) e.def.confirm({ point, via: 'mouse' });
	}

	move(dx: number, dy: number) {
		this.inputPriorityUntil = performance.now() + MOUSE_PRIORITY_MS * 4;
		const legal = this.legalEntries();
		if (legal.length === 0) return;
		const current = this.focused ? this.entries.get(this.focused) : undefined;
		if (!current) {
			this.setFocus(legal[0].def.id);
			return;
		}
		const from = centreOf(current.el);
		let best: Entry | null = null;
		let bestScore = Infinity;
		for (const e of legal) {
			if (e === current) continue;
			const c = centreOf(e.el);
			const vx = c.x - from.x;
			const vy = c.y - from.y;
			const forward = vx * dx + vy * dy;
			if (forward <= 0) continue;
			const sideways = Math.abs(vx * dy) + Math.abs(vy * dx);
			const score = forward + sideways * 2;
			if (score < bestScore) {
				bestScore = score;
				best = e;
			}
		}
		if (best) this.setFocus(best.def.id);
	}

	confirmKey() {
		if (!this.enabled) return;
		const legal = this.legalEntries();
		const e = this.focused
			? this.entries.get(this.focused)
			: legal.length === 1
				? legal[0]
				: undefined;
		if (e?.def.legal) e.def.confirm({ point: centreOf(e.el), via: 'key' });
	}
}

export const targets = new Targets();

/** Svelte action: makes an element something the player can look at and confirm. */
export function target(el: HTMLElement, def: TargetDef) {
	let current = def;
	targets.register(el, def);
	const onEnter = () => targets.mouseEnter(current.id);
	const onClick = (e: MouseEvent) => targets.click(current.id, { x: e.clientX, y: e.clientY });
	el.addEventListener('mouseenter', onEnter);
	el.addEventListener('click', onClick);
	return {
		update(next: TargetDef) {
			if (next.id !== current.id) {
				targets.unregister(current.id);
				targets.register(el, next);
			} else {
				targets.update(el, next);
			}
			current = next;
		},
		destroy() {
			targets.unregister(current.id);
			el.removeEventListener('mouseenter', onEnter);
			el.removeEventListener('click', onClick);
		}
	};
}
