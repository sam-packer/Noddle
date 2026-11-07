/**
 * How close the pointer must be to a target. Plain numbers in their own file so `bun run tune` can
 * test them against recorded aiming without a browser.
 */
export const hitbox = {
	/** The pointer selects a target from this far outside its edge, in pixels. */
	padPx: 110,
	/** Once selected, a target holds on out to here, so a shaky pointer doesn't flicker on the edge. */
	releasePx: 170
};
