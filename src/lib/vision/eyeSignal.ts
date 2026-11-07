/**
 * Compares how much the eyes and the head wobble over the same seconds, from the same camera.
 * Both signals are raw, with none of the pointer's smoothing, and both are measured as the distance
 * they would move a pointer on this screen.
 */
export type EyeFrame = {
	/** Ms since the run began. */
	t: number;
	/** Iris turn inside the eye, in degrees. */
	ex: number;
	ey: number;
	/** Head angles, in degrees. */
	yaw: number;
	pitch: number;
	open: number;
	dist: number;
};

/** Cm on screen for each degree of head turn, as the pointer maps it. */
export type HeadGains = { x: number; up: number; down: number };

export type TracePoint = { t: number; eye: number; head: number };

export type EyeScore = {
	eyeCm: number;
	headCm: number;
	/** Share of frames kept, once blinks and the first moments are gone. */
	usable: number;
	/** Side to side wobble over time, in cm, for drawing. */
	trace: TracePoint[];
};

const SKIP_MS = 500;
const BLINK_PAD_MS = 100;
/** Slower movement than this is the person drifting, which isn't what's being compared. */
const DRIFT_WINDOW_MS = 1000;

function median(values: number[]) {
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** What's left of each value after removing the slow drift around it. */
function wobble(times: number[], values: number[]) {
	return values.map((v, i) => {
		const near: number[] = [];
		for (let j = 0; j < values.length; j++) {
			if (Math.abs(times[j] - times[i]) <= DRIFT_WINDOW_MS / 2) near.push(values[j]);
		}
		return v - median(near);
	});
}

function rms(a: number[], b: number[]) {
	if (!a.length) return 0;
	return Math.sqrt(a.reduce((sum, v, i) => sum + v * v + b[i] * b[i], 0) / a.length);
}

export function scoreRun(frames: EyeFrame[], gains: HeadGains): EyeScore {
	const empty = { eyeCm: 0, headCm: 0, usable: 0, trace: [] };
	if (!frames.length) return empty;
	const threshold = median(frames.map((f) => f.open)) * 0.6;
	const blinks = frames.filter((f) => f.open < threshold).map((f) => f.t);
	const good = frames.filter(
		(f) => f.t >= SKIP_MS && !blinks.some((b) => Math.abs(b - f.t) <= BLINK_PAD_MS)
	);
	if (!good.length) return empty;

	const times = good.map((f) => f.t);
	const dist = median(good.map((f) => f.dist));
	const toCm = (deg: number) => dist * Math.tan((deg * Math.PI) / 180);
	const restYaw = median(good.map((f) => f.yaw));
	const restPitch = median(good.map((f) => f.pitch));

	const eyeX = wobble(times, good.map((f) => toCm(f.ex)));
	const eyeY = wobble(times, good.map((f) => toCm(f.ey)));
	const headX = wobble(times, good.map((f) => (f.yaw - restYaw) * gains.x));
	const headY = wobble(
		times,
		good.map((f) => {
			const d = f.pitch - restPitch;
			return d * (d >= 0 ? gains.up : gains.down);
		})
	);

	return {
		eyeCm: rms(eyeX, eyeY),
		headCm: rms(headX, headY),
		usable: good.length / frames.length,
		trace: good.map((f, i) => ({ t: f.t, eye: eyeX[i], head: headX[i] }))
	};
}
