/**
 * Finds every movement in a recording that looks like a nod or shake, without asking the detector.
 * Comparing these with what the detector did is how a missed gesture gets found: anything it
 * ignored leaves no event in the log, but the head movement is still there in the frames.
 */
export type Frame = { t: number; y: number; p: number } & Record<string, any>;
export type Candidate = {
	axis: 'pitch' | 'yaw';
	start: number;
	far: number;
	end: number;
	sizeDeg: number;
	backDeg: number;
	speed: number;
};

/** Deliberately looser than the detector, so a near miss still shows up. */
const TURN_DEG = 1;
const MIN_SIZE_DEG = 2;
const MIN_RETURN = 0.4;
const MAX_MS = 1500;
const SMOOTH_FRAMES = 1;

function smooth(values: number[]) {
	return values.map((_, i) => {
		const part = values.slice(Math.max(0, i - SMOOTH_FRAMES), i + SMOOTH_FRAMES + 1);
		return part.reduce((a, b) => a + b, 0) / part.length;
	});
}

/** Where the head changed direction, ignoring wobbles smaller than TURN_DEG. */
function turningPoints(values: number[]) {
	const points = [0];
	let direction = 0;
	let extreme = 0;
	for (let i = 1; i < values.length; i++) {
		if (direction >= 0 && values[i] > values[extreme]) extreme = i;
		if (direction <= 0 && values[i] < values[extreme]) extreme = i;
		const moved = values[i] - values[extreme];
		if (direction === 0 && Math.abs(values[i] - values[0]) >= TURN_DEG) {
			direction = Math.sign(values[i] - values[0]);
			extreme = i;
		} else if (direction > 0 && moved <= -TURN_DEG) {
			points.push(extreme);
			direction = -1;
			extreme = i;
		} else if (direction < 0 && moved >= TURN_DEG) {
			points.push(extreme);
			direction = 1;
			extreme = i;
		}
	}
	points.push(extreme);
	return points;
}

function fastest(times: number[], values: number[], from: number, to: number) {
	let top = 0;
	for (let i = from + 2; i <= to; i++) {
		top = Math.max(top, (Math.abs(values[i] - values[i - 2]) / Math.max(times[i] - times[i - 2], 1)) * 1000);
	}
	return top;
}

export function findCandidates(frames: Frame[], axis: Candidate['axis']): Candidate[] {
	const times = frames.map((f) => f.t);
	const values = smooth(frames.map((f) => (axis === 'pitch' ? f.p : f.y)));
	const points = turningPoints(values);
	const found: Candidate[] = [];
	for (let i = 0; i + 2 < points.length; i++) {
		const [a, b, c] = [points[i], points[i + 1], points[i + 2]];
		const sizeDeg = Math.abs(values[b] - values[a]);
		const backDeg = Math.abs(values[c] - values[b]);
		if (sizeDeg < MIN_SIZE_DEG || backDeg < MIN_RETURN * sizeDeg) continue;
		if (times[c] - times[a] > MAX_MS) continue;
		found.push({
			axis,
			start: times[a],
			far: times[b],
			end: times[c],
			sizeDeg,
			backDeg,
			speed: Math.max(fastest(times, values, a, b), fastest(times, values, b, c))
		});
	}
	return found;
}
