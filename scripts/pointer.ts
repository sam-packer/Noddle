/**
 * Replays recorded head movement through the pointer's smoothing and measures the trade-off that
 * decides how it feels: how long it takes to catch up after a big move, and how much it shakes when
 * the head is still. `bun run pointer` Only the smoothing is tested, so no browser is needed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { HeadSmoother, smootherConfig } from './headSmoother';
import { OneEuro } from '../src/lib/vision/math';

type Sample = { t: number; yaw: number; pitch: number };
type Smoother = (s: Sample) => { yaw: number; pitch: number };

const DIR = '.recordings/sessions';
/** Screen pixels per degree of head turn, with the default head range. */
const PX_PER_DEG = 63;
/** A move at least this big counts as a big head movement, in degrees. */
const BIG_MOVE_DEG = 6;
const MOVING_DEG_S = 40;
const STOPPED_DEG_S = 12;
/** Caught up means within this many pixels of where the head really is. */
const CAUGHT_UP_PX = 30;
const STILL_WINDOW_MS = 1000;
const STILL_RANGE_DEG = 1.5;

function sessions(): Sample[][] {
	return readdirSync(DIR)
		.filter((f) => f.endsWith('.jsonl'))
		.map((f) =>
			readFileSync(`${DIR}/${f}`, 'utf8')
				.trim()
				.split('\n')
				.map((l) => JSON.parse(l))
				.filter((r) => r.e === undefined && r.p != null)
				.sort((a, b) => a.t - b.t)
				.map((r) => ({ t: r.t, yaw: r.y, pitch: r.p }))
		)
		.filter((s) => s.length > 300);
}

/** The pointer's old chain: two filters, a dead zone, a median window, then another filter. */
function oldChain(): Smoother {
	const fy = new OneEuro(1.5, 0.02);
	const fp = new OneEuro(1.5, 0.02);
	const sy = new OneEuro(1.2, 0.01 * PX_PER_DEG);
	const sp = new OneEuro(1.2, 0.01 * PX_PER_DEG);
	let heldY: number | null = null;
	let heldP: number | null = null;
	const recent: { t: number; y: number; p: number }[] = [];
	const drag = (held: number | null, v: number) => {
		if (held === null) return v;
		const d = v - held;
		return Math.abs(d) <= 0.6 ? held : v - Math.sign(d) * 0.6;
	};
	const mid = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
	return ({ t, yaw, pitch }) => {
		heldY = drag(heldY, fy.filter(yaw, t));
		heldP = drag(heldP, fp.filter(pitch, t));
		recent.push({ t, y: heldY, p: heldP });
		while (t - recent[0].t > 100) recent.shift();
		return {
			yaw: sy.filter(mid(recent.map((r) => r.y)), t),
			pitch: sp.filter(mid(recent.map((r) => r.p)), t)
		};
	};
}

/** How long until the smoothed pointer catches up after each big move, in ms. */
function catchUps(frames: Sample[], out: { yaw: number; pitch: number }[]) {
	const times: number[] = [];
	const speed = (i: number) => {
		const j = Math.max(i - 2, 0);
		return (Math.hypot(frames[i].yaw - frames[j].yaw, frames[i].pitch - frames[j].pitch) / Math.max(frames[i].t - frames[j].t, 1)) * 1000;
	};
	let i = 3;
	while (i < frames.length) {
		if (speed(i) < MOVING_DEG_S) {
			i++;
			continue;
		}
		const from = frames[Math.max(i - 3, 0)];
		let j = i;
		while (j < frames.length && speed(j) > STOPPED_DEG_S) j++;
		if (j >= frames.length) break;
		const stop = frames[j];
		if (Math.hypot(stop.yaw - from.yaw, stop.pitch - from.pitch) >= BIG_MOVE_DEG) {
			let k = j;
			const offPx = (n: number) => Math.hypot(out[n].yaw - frames[n].yaw, out[n].pitch - frames[n].pitch) * PX_PER_DEG;
			while (k < frames.length && frames[k].t - stop.t < 1200 && offPx(k) > CAUGHT_UP_PX) k++;
			times.push(frames[k]?.t - stop.t);
		}
		i = j + 1;
	}
	return times;
}

/** How far the pointer travels each second while the head is still, in pixels. */
function shake(frames: Sample[], out: { yaw: number; pitch: number }[]) {
	const rates: number[] = [];
	for (let i = 0; i < frames.length; ) {
		let j = i;
		while (j < frames.length && frames[j].t - frames[i].t < STILL_WINDOW_MS) j++;
		if (j >= frames.length) break;
		const part = frames.slice(i, j);
		const range = (k: 'yaw' | 'pitch') => Math.max(...part.map((f) => f[k])) - Math.min(...part.map((f) => f[k]));
		if (range('yaw') < STILL_RANGE_DEG && range('pitch') < STILL_RANGE_DEG) {
			let path = 0;
			for (let k = i + 1; k < j; k++) path += Math.hypot(out[k].yaw - out[k - 1].yaw, out[k].pitch - out[k - 1].pitch) * PX_PER_DEG;
			rates.push((path / (frames[j - 1].t - frames[i].t)) * 1000);
		}
		i = j;
	}
	return rates;
}

const middle = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : 0);
const high = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.9)] : 0);

function measure(make: () => Smoother) {
	const catches: number[] = [];
	const shakes: number[] = [];
	for (const frames of sessions()) {
		const smoother = make();
		const out = frames.map((f) => smoother(f));
		catches.push(...catchUps(frames, out));
		shakes.push(...shake(frames, out));
	}
	return { catchUpMs: Math.round(middle(catches)), worstMs: Math.round(high(catches)), shakePxS: Math.round(middle(shakes)), moves: catches.length, stills: shakes.length };
}

/** The app's real smoother, with whatever settings are current. */
function current(): Smoother {
	const smoother = new HeadSmoother();
	return ({ t, yaw, pitch }) => smoother.push(t, yaw, pitch);
}

console.log('Old stacked filters:', measure(oldChain));
console.log('Current settings:', { ...smootherConfig }, measure(current));

const rows = [];
for (const minCutoff of [0.5, 0.8, 1.2])
	for (const beta of [0.1, 0.2, 0.4])
		for (const deadbandDeg of [0, 0.15, 0.25, 0.35, 0.5]) {
			Object.assign(smootherConfig, { minCutoff, beta, deadbandDeg });
			rows.push({ minCutoff, beta, deadbandDeg, ...measure(current) });
		}
console.log('Fast to catch up and steady when still is what to look for:');
console.table(rows.sort((a, b) => a.shakePxS - b.shakePxS).map(({ moves: _m, stills: _s, ...r }) => r));
