/**
 * Searches for better detector and hitbox settings using test runs (the B key), without needing the
 * player. It tunes on half the trials and checks on the other half, because a setting that only
 * looks good on what it was tuned on hasn't really improved anything. `bun run tune`
 */
import { hitbox } from '../src/lib/input/hitbox';
import { gestureConfig } from '../src/lib/vision/gestures';
import { loadRuns, scoreRuns, type Trial } from './trials';

const SEARCH: Record<string, number[]> = {
	nodDeg: [2, 2.5, 3, 3.5, 4],
	shakeDeg: [2.5, 3, 4, 5],
	shakeMinSpeed: [15, 20, 30, 40],
	returnShare: [0.4, 0.5, 0.6, 0.7],
	shakeReturnShare: [0.5, 0.6, 0.7, 0.8],
	maxMs: [800, 1000, 1300],
	holdMs: [300, 450, 650],
	crossShare: [0.5, 0.7, 1],
	nodRefractoryMs: [1000, 1250, 1500],
	personalSpeedShare: [0.35, 0.45, 0.55, 0.65],
	padPx: [30, 50, 70, 90, 110]
};
const TRIES = Number(process.argv[2] ?? 400);

const runs = loadRuns();
if (!runs.length) {
	console.log('No test runs yet. Press B in the game on the dev server, then run this again.');
	process.exit(0);
}

const tuning = (t: Trial) => t.n % 2 === 0;
const checking = (t: Trial) => t.n % 2 === 1;

function apply(settings: Record<string, number>) {
	for (const [k, v] of Object.entries(settings)) {
		if (k === 'padPx') hitbox.padPx = v;
		else (gestureConfig as Record<string, number>)[k] = v;
	}
}
const pick = (values: number[]) => values[Math.floor(Math.random() * values.length)];
const current = Object.fromEntries(
	Object.keys(SEARCH).map((k) => [k, k === 'padPx' ? hitbox.padPx : (gestureConfig as Record<string, number>)[k]])
);

let best = current;
let bestValue = scoreRuns(runs, tuning).value;
for (let i = 0; i < TRIES; i++) {
	// Half the tries change one thing about the best so far, half explore anywhere.
	const candidate =
		i % 2
			? Object.fromEntries(Object.entries(SEARCH).map(([k, v]) => [k, pick(v)]))
			: (() => {
					const k = pick(Object.keys(SEARCH).map((_, j) => j));
					const name = Object.keys(SEARCH)[k];
					return { ...best, [name]: pick(SEARCH[name]) };
				})();
	apply(candidate);
	const value = scoreRuns(runs, tuning).value;
	if (value > bestValue) {
		bestValue = value;
		best = candidate;
	}
}

apply(current);
const before = { tuned: scoreRuns(runs, tuning), checked: scoreRuns(runs, checking) };
apply(best);
const after = { tuned: scoreRuns(runs, tuning), checked: scoreRuns(runs, checking) };
apply(current);

console.table({
	'current, tuning half': before.tuned,
	'best found, tuning half': after.tuned,
	'current, checking half': before.checked,
	'best found, checking half': after.checked
});
const changes = Object.keys(best).filter((k) => best[k] !== current[k]);
if (after.checked.value > before.checked.value && changes.length) {
	console.log('Better on trials it was not tuned on. Worth applying, then run: bun run gate');
	for (const k of changes) console.log(`  ${k}: ${current[k]} -> ${best[k]}`);
} else {
	console.log('Nothing beat the current settings on the checking half, so keep them.');
}
