/**
 * Scores test runs from the B key: what actually happened on each trial, overall, by layout and for
 * each setting tried, so settings can be compared without anyone describing how it felt.
 * `bun run benchmark`
 */
import { loadRuns, percent, type Run, type Trial } from './trials';

const runs = loadRuns();
if (!runs.length) {
	console.log('No test runs yet. Press B in the game on the dev server, then run this again.');
	process.exit(0);
}

const middle = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : 0);

function summarise(run: Run, trials: Trial[]) {
	const picks = trials.filter((t) => t.kind === 'pick');
	const shakes = trials.filter((t) => t.kind === 'shake');
	const follows = trials.filter((t) => t.kind === 'follow');
	const count = (r: string) => picks.filter((t) => t.result === r).length;
	const gesturesIn = (list: Trial[], kind: string) =>
		list.reduce((sum, t) => sum + run.events.filter((e) => e.e === 'gesture' && e.kind === kind && e.at >= t.start && e.at <= t.end).length, 0);
	return {
		picks: picks.length,
		hit: percent(count('hit'), picks.length),
		wrongTarget: percent(count('wrong'), picks.length),
		missed: percent(count('miss'), picks.length),
		medianMs: Math.round(middle(picks.filter((t) => t.result === 'hit').map((t) => t.end - t.start))),
		shakesCaught: `${shakes.filter((t) => t.result === 'hit').length}/${shakes.length}`,
		falseNodsWhileFollowing: gesturesIn(follows, 'nod'),
		falseShakesOnPicks: gesturesIn(picks, 'shake')
	};
}

for (const run of runs) {
	console.log(`\nTest run ${run.name}, ${run.trials.length} trials`);
	const rows: Record<string, unknown> = { everything: summarise(run, run.trials) };
	for (const variant of new Set(run.trials.map((t) => t.variant))) {
		rows[`setting: ${variant}`] = summarise(run, run.trials.filter((t) => t.variant === variant));
	}
	for (const layout of new Set(run.trials.filter((t) => t.kind === 'pick').map((t) => t.layout))) {
		rows[`layout: ${layout}`] = summarise(run, run.trials.filter((t) => t.layout === layout));
	}
	console.table(rows);
}
