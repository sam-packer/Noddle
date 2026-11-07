/**
 * Reads the self-labelling test runs (the B key). The game knows what it asked for on every trial,
 * so these need nobody to explain what they meant. Replays them through the real detector and
 * scores it, which is what `bun run tune` and `bun run gate` both rely on.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { hitbox } from '../src/lib/input/hitbox';
import { HeadGestures } from '../src/lib/vision/gestures';

type Row = Record<string, any>;
export type Trial = {
	session: string;
	n: number;
	kind: 'pick' | 'shake' | 'follow';
	layout: string;
	want: string | null;
	variant: string;
	rects: [string, number, number, number, number][];
	start: number;
	end: number;
	result: string;
	chose: string | null;
};
export type Run = { name: string; frames: Row[]; events: Row[]; trials: Trial[] };

export function loadRuns(dir = process.env.SESSIONS_DIR ?? '.recordings/sessions'): Run[] {
	const runs: Run[] = [];
	for (const name of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
		const text = readFileSync(`${dir}/${name}`, 'utf8');
		if (!text.includes('"e":"trial"')) continue;
		const rows: Row[] = text.trim().split('\n').map((l) => JSON.parse(l));
		rows.sort((a, b) => a.t - b.t);
		const events = rows.filter((r) => r.e !== undefined);
		const frames = rows.filter((r) => r.e === undefined && r.p != null);
		const trials: Trial[] = [];
		for (const e of events.filter((x) => x.e === 'trial')) {
			const done = events.find((x) => x.e === 'trialEnd' && x.n === e.n && x.t > e.t);
			if (!done) continue;
			trials.push({
				session: name,
				n: e.n,
				kind: e.kind,
				layout: e.layout,
				want: e.want,
				variant: e.variant,
				rects: e.rects,
				start: e.t,
				end: done.t,
				result: done.result,
				chose: done.chose
			});
		}
		if (trials.length && frames.length) runs.push({ name, frames, events, trials });
	}
	return runs;
}

export type Score = {
	picks: number;
	correct: number;
	wrong: number;
	missed: number;
	shakes: number;
	shakesCaught: number;
	falseNods: number;
	falseShakes: number;
	/** Higher is better. A false gesture does more harm than a nod that needs repeating. */
	value: number;
};

const GRACE_MS = 250;

function pointerAt(frames: Row[], t: number) {
	let best = frames[0];
	for (const f of frames) {
		if (Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
		if (f.t > t + 50) break;
	}
	return { x: best.a ?? best.x, y: best.b ?? best.v };
}

function choose(trial: Trial, p: { x: number; y: number }) {
	const padPx = trial.layout === 'grid' ? 0 : hitbox.padPx;
	let best: string | null = null;
	let bestGap = Infinity;
	for (const [id, l, t, w, h] of trial.rects) {
		const gap = Math.hypot(Math.max(l - p.x, 0, p.x - l - w), Math.max(t - p.y, 0, p.y - t - h));
		if (gap <= padPx && gap < bestGap) {
			bestGap = gap;
			best = id;
		}
	}
	return best;
}

/** Scores the detector with its current settings. `keep` chooses which trials count. */
export function scoreRuns(runs: Run[], keep: (t: Trial) => boolean = () => true): Score {
	const s: Score = { picks: 0, correct: 0, wrong: 0, missed: 0, shakes: 0, shakesCaught: 0, falseNods: 0, falseShakes: 0, value: 0 };
	for (const run of runs) {
		const detector = new HeadGestures();
		const fired: { kind: string; t: number; onset: number }[] = [];
		for (const f of run.frames) {
			const g = detector.push(f.t, f.y, f.p);
			if (g) fired.push({ kind: g.kind, t: f.t, onset: g.onset });
		}
		for (const trial of run.trials.filter(keep)) {
			const during = fired.filter((g) => g.t >= trial.start + GRACE_MS && g.t <= trial.end + GRACE_MS);
			const nods = during.filter((g) => g.kind === 'nod');
			const shakes = during.filter((g) => g.kind === 'shake');
			if (trial.kind === 'pick') {
				s.picks++;
				s.falseShakes += shakes.length;
				if (!nods.length) s.missed++;
				else if (choose(trial, pointerAt(run.frames, nods[0].onset)) === trial.want) s.correct++;
				else s.wrong++;
				s.falseNods += Math.max(0, nods.length - 1);
			} else if (trial.kind === 'shake') {
				s.shakes++;
				if (shakes.length) s.shakesCaught++;
				s.falseNods += nods.length;
			} else {
				s.falseNods += nods.length;
				s.falseShakes += shakes.length;
			}
		}
	}
	s.value = s.correct + s.shakesCaught - s.wrong - 2 * (s.falseNods + s.falseShakes);
	return s;
}

export const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '-');
