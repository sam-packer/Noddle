import { OneEuro } from './math';

export type Gesture = {
	kind: 'nod' | 'shake';
	/** When the player was last settled, before the gesture moved their head. */
	onset: number;
	t: number;
	/** How far the head went, in degrees. */
	sizeDeg: number;
	/** The fastest the head moved during it, in degrees a second. */
	speed: number;
};

/** A bump that had the right shape but was small or slow for this person. */
export type RejectedBump = Gesture & { needDeg: number; needSpeed: number };

/**
 * A nod and a shake are the same movement on different axes: the head goes out and comes back.
 * Recordings of gentle gestures show no fast dip and no zigzag, only that one bump, and it can go
 * either way first. Big bobbing nods have the same shape, so this works for both. Pointing at
 * something is different because the head stays there.
 */
export const gestureConfig = {
	/** The smallest gesture that counts. It only rises from here, for someone who nods big. */
	nodDeg: 2.5,
	shakeDeg: 2.5,
	/** Once someone's gestures are known, this share of their usual size is the smallest that counts. */
	personalShare: 0.5,
	/** And this share of their usual speed. Their real nods are sharp, and aiming around isn't. */
	personalSpeedShare: 0.45,
	/** Share of the way back the head must come for the bump to count. */
	returnShare: 0.5,
	/** Out and back has to fit in this long. Anything slower is looking around. */
	maxMs: 1000,
	/** Staying near the far end for this long means the player is looking there. */
	holdMs: 300,
	/** Movement on the other axis can only be this share of the bump, so a diagonal move isn't one. */
	crossShare: 0.7,
	/** Nothing counts this soon after a nod, while the head returns to rest. */
	refractoryMs: 300,
	/**
	 * Another nod can't count for this long. Moving on to the next thing can look like a nod, but a
	 * shake to undo a mistake must still work straight away. Played nods were at least 2s apart.
	 */
	nodRefractoryMs: 1500,
	/** A shake can swing back and forth for a while, and one shake must only count once. */
	shakeRefractoryMs: 1200
};

/** How far back to look for where the head was before a bump began, in ms. */
const BEFORE_MS = 300;
/** Where the head was this long ago stands in for its resting place, for the on-screen press. */
const REST_FROM_MS = 600;
const REST_TO_MS = 300;
/** Head this far from rest, and still moving, may be a nod starting. */
const STARTING_DEG = 1;
/** Head pitch falls when the head tips forward. Only a sharp fall holds the selection, because */
/** the head also moves up and down to aim, and that has to be able to change what is selected. */
const STARTING_FALL_DEG_S = 25;
const MOVING_SPAN_MS = 100;
/**
 * If the head came back this much faster than it went out, going out was aiming and only coming
 * back was the nod. Reaching for something high then nodding looks like one big bump otherwise.
 */
const AIMING_RATIO = 1.5;
/** A sharp nod straight after a big move only shows up when looking back this short a time. */
const SHARP_MS = 500;
const HISTORY_MS = 1800;
/** Gestures to see before trusting someone's usual size, and how many to remember. */
const PERSONAL_MIN_SEEN = 3;
const PERSONAL_MAX_SEEN = 7;

type S = { t: number; yaw: number; pitch: number };
type Axis = 'yaw' | 'pitch';
type Bump = { onset: number; sizeDeg: number; speed: number };

function middle(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

/** Looks back from now for a movement out and back on one axis, finishing on this frame. */
function findBump(buf: S[], axis: Axis, minDeg: number, lookBackMs: number): Bump | null {
	const cfg = gestureConfig;
	const other: Axis = axis === 'yaw' ? 'pitch' : 'yaw';
	const now = buf[buf.length - 1];
	const first = buf.findIndex((s) => now.t - s.t <= lookBackMs);

	// The far end of the bump is whatever is furthest from where the head is now.
	let peakI = first;
	for (let i = first; i < buf.length; i++) {
		if (Math.abs(buf[i][axis] - now[axis]) > Math.abs(buf[peakI][axis] - now[axis])) peakI = i;
	}
	if (peakI === first) return null;
	const peak = buf[peakI][axis];

	// It began wherever the head was furthest from that, before getting there.
	let startI = first;
	for (let i = first; i < peakI; i++) {
		if (Math.abs(buf[i][axis] - peak) > Math.abs(buf[startI][axis] - peak)) startI = i;
	}
	const start = buf[startI];
	const sizeDeg = Math.abs(peak - start[axis]);
	if (sizeDeg < minDeg) return null;
	if (Math.abs(peak - now[axis]) < cfg.returnShare * sizeDeg) return null;

	// If the head was further back still, this is the middle of a long move and not a bump.
	const before = buf.filter((s) => s.t < start.t && start.t - s.t <= BEFORE_MS).map((s) => s[axis]);
	if (before.length) {
		const earlier = Math.abs(middle(before) - peak);
		if (earlier > sizeDeg * 1.25) return null;
	}

	const during = buf.slice(startI);
	const near = during.filter((s) => Math.abs(s[axis] - peak) <= 0.3 * sizeDeg);
	if (near.length && near[near.length - 1].t - near[0].t > cfg.holdMs) return null;

	const across = during.map((s) => s[other]);
	if (Math.max(...across) - Math.min(...across) > cfg.crossShare * sizeDeg) return null;

	// Which target was meant is decided by where the head was when it set off, so this has to be
	// that moment. The furthest point can be well before it, while the player was still aiming.
	let leftI = startI;
	for (let i = startI; i < peakI; i++) {
		if (Math.abs(buf[i][axis] - start[axis]) <= 0.25 * sizeDeg) leftI = i;
	}
	const outSpeed = fastest(buf, axis, startI, peakI);
	const backSpeed = fastest(buf, axis, peakI, buf.length - 1);
	const aiming = backSpeed >= AIMING_RATIO * outSpeed;
	return {
		onset: aiming ? buf[peakI].t : buf[leftI].t,
		sizeDeg,
		speed: Math.max(outSpeed, backSpeed)
	};
}

/** The fastest the head moved between two samples, in degrees a second. */
function fastest(buf: S[], axis: Axis, from: number, to: number) {
	let top = 0;
	for (let i = from + 2; i <= to; i++) {
		const dt = Math.max(buf[i].t - buf[i - 2].t, 1);
		top = Math.max(top, (Math.abs(buf[i][axis] - buf[i - 2][axis]) / dt) * 1000);
	}
	return top;
}

type Seen = { sizes: number[]; speeds: number[] };

function remember(seen: Seen, bump: Bump) {
	seen.sizes.push(bump.sizeDeg);
	seen.speeds.push(bump.speed);
	if (seen.sizes.length > PERSONAL_MAX_SEEN) {
		seen.sizes.shift();
		seen.speeds.shift();
	}
}

/** Detects a nod or shake from one tracked face's head angles. */
export class HeadGestures {
	private buf: S[] = [];
	private blockedUntil = 0;
	private nodBlockedUntil = 0;
	private fy = new OneEuro(4, 0.02);
	private fp = new OneEuro(4, 0.02);
	private nods: Seen = { sizes: [], speeds: [] };
	private shakes: Seen = { sizes: [], speeds: [] };
	/** The last bump turned down for being too small or slow, for the session log. */
	rejected: RejectedBump | null = null;

	/** The smallest and slowest gesture that counts for this person. Big nodders need more. */
	private needs(base: number, seen: Seen) {
		const cfg = gestureConfig;
		if (seen.sizes.length < PERSONAL_MIN_SEEN) return { deg: base, speed: 0 };
		return {
			deg: Math.max(base, cfg.personalShare * middle(seen.sizes)),
			speed: cfg.personalSpeedShare * middle(seen.speeds)
		};
	}

	/** Looks for this axis's gesture, checking it against what this person usually does. */
	private check(kind: Gesture['kind'], axis: Axis, base: number, seen: Seen, t: number) {
		const need = this.needs(base, seen);
		const found =
			findBump(this.buf, axis, base, gestureConfig.maxMs) ??
			findBump(this.buf, axis, base, SHARP_MS);
		if (!found) return null;
		if (found.sizeDeg < need.deg || found.speed < need.speed) {
			this.rejected = { kind, t, ...found, needDeg: need.deg, needSpeed: need.speed };
			return null;
		}
		return found;
	}

	/** How far the head has pitched from where it was resting, in degrees. */
	private get pitchAway() {
		const last = this.buf[this.buf.length - 1];
		if (!last || last.t < this.nodBlockedUntil) return 0;
		const rest = this.buf
			.filter((s) => last.t - s.t >= REST_TO_MS && last.t - s.t <= REST_FROM_MS)
			.map((s) => s.pitch);
		return rest.length ? Math.abs(last.pitch - middle(rest)) : 0;
	}

	/** How far through a possible nod the head is, from 0 to 1. */
	get nodProgress() {
		return Math.min(1, this.pitchAway / gestureConfig.nodDeg);
	}

	/** True while the head may be partway through a nod. */
	get nodInProgress() {
		const last = this.buf[this.buf.length - 1];
		if (!last || this.pitchAway < STARTING_DEG) return false;
		const earlier = this.buf.findLast((s) => last.t - s.t >= MOVING_SPAN_MS);
		if (!earlier) return false;
		const falling = ((earlier.pitch - last.pitch) / Math.max(last.t - earlier.t, 1)) * 1000;
		return falling >= STARTING_FALL_DEG_S;
	}

	push(t: number, yawRaw: number, pitchRaw: number): Gesture | null {
		const yaw = this.fy.filter(yawRaw, t);
		const pitch = this.fp.filter(pitchRaw, t);
		this.buf.push({ t, yaw, pitch });
		while (this.buf.length && t - this.buf[0].t > HISTORY_MS) this.buf.shift();
		if (t < this.blockedUntil || this.buf.length < 4) return null;

		const cfg = gestureConfig;
		const nod =
			t < this.nodBlockedUntil ? null : this.check('nod', 'pitch', cfg.nodDeg, this.nods, t);
		const shake = nod ? null : this.check('shake', 'yaw', cfg.shakeDeg, this.shakes, t);
		const found = nod ?? shake;
		if (!found) return null;
		remember(shake ? this.shakes : this.nods, found);

		this.blockedUntil = t + (shake ? cfg.shakeRefractoryMs : cfg.refractoryMs);
		this.nodBlockedUntil = t + (shake ? cfg.shakeRefractoryMs : cfg.nodRefractoryMs);
		this.buf = [];
		return { kind: shake ? 'shake' : 'nod', t, ...found };
	}
}
