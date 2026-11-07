/**
 * The regression check: fails if the detector does worse than the saved baseline, on self-labelling
 * test runs or on games a player described. Run after any change to tracking.
 * `bun run gate`, or `bun run gate --update` to accept the current results as the new baseline.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadRuns, scoreRuns } from './trials';

const PATH = 'scripts/baseline.json';
const replay = spawnSync('bun', ['scripts/replay.ts'], { encoding: 'utf8' });
const match = replay.stdout.match(/(\d+) difference\(s\)/);
const now = {
	labelDifferences: match ? Number(match[1]) : 0,
	testRuns: loadRuns().map((r) => [r.name, scoreRuns([r]).value] as const)
};

if (process.argv.includes('--update') || !existsSync(PATH)) {
	writeFileSync(PATH, `${JSON.stringify(now, null, '\t')}\n`);
	console.log('Baseline saved:', now);
	process.exit(0);
}

const base = JSON.parse(readFileSync(PATH, 'utf8'));
const problems: string[] = [];
if (now.labelDifferences > base.labelDifferences) {
	problems.push(`labelled games: ${base.labelDifferences} differences, now ${now.labelDifferences}`);
}
for (const [name, value] of now.testRuns) {
	const before = base.testRuns.find((r: [string, number]) => r[0] === name);
	if (before && value < before[1]) problems.push(`test run ${name}: score ${before[1]}, now ${value}`);
}
if (problems.length) {
	console.log(`Worse than the baseline:\n  ${problems.join('\n  ')}`);
	process.exit(1);
}
console.log('Nothing got worse than the baseline.', now);
