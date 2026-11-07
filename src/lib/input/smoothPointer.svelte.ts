import { engine } from '../vision/engine.svelte';
import { targets } from './targets.svelte';

/** How closely the dot follows, in ms. Longer drags more, shorter feels more direct. */
const FOLLOW_MS = 90;
/** How far the dot leans toward what is selected. Too much and it looks like it is snapping. */
const LEAN = 0.2;
/** Frames longer than this are a stalled tab, not movement to animate. */
const MAX_FRAME_MS = 100;

/**
 * The dot the player sees. Selection uses the real pointer, which arrives at camera speed and can
 * jump after a nod, so this glides after it every screen frame. It never decides anything.
 */
class SmoothPointer {
	x = $state(0);
	y = $state(0);
	visible = $state(false);

	start() {
		let last = performance.now();
		let frame = 0;
		const tick = (now: number) => {
			const dt = Math.min(now - last, MAX_FRAME_MS);
			last = now;
			this.follow(dt);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}

	private follow(dt: number) {
		const p = engine.pointer;
		if (!p || engine.headCalibrating) {
			this.visible = false;
			return;
		}
		const c = targets.focusCentre;
		const goalX = c ? p.x + (c.x - p.x) * LEAN : p.x;
		const goalY = c ? p.y + (c.y - p.y) * LEAN : p.y;
		if (!this.visible) {
			this.x = goalX;
			this.y = goalY;
			this.visible = true;
			return;
		}
		const blend = 1 - Math.exp(-dt / FOLLOW_MS);
		this.x += (goalX - this.x) * blend;
		this.y += (goalY - this.y) * blend;
	}
}

export const smoothPointer = new SmoothPointer();
