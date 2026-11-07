/**
 * Replays saved recordings through the real gesture detector and scores it, so a change to the
 * detector can be checked against what players actually did. `bun run replay`
 *
 * `bun run replay --sweep` tries a range of settings and shows which match the labels best, and how
 * wide that range is. Prefer a setting in the middle of a wide range over the single best score.
 *
 * Labels live in scripts/labels.json. The recordings themselves stay in .recordings, unshared.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gestureConfig, HeadGestures } from '../src/lib/vision/gestures';

const DIR = '.recordings';
const labels = JSON.parse(readFileSync('scripts/labels.json', 'utf8'));
const MATCH_S = 0.6;
const SWEEP: Partial<Record<keyof typeof gestureConfig, number[]>> = {
	holdMs: [300, 450, 650, 800],
	maxMs: [1000, 1300, 1500],
	sharpMs: [500, 700, 900],
	crossShare: [0.5, 0.7, 1],
	nodRefractoryMs: [1000, 1250, 1500]
};

const files = new Map<string, string>();
function read(path: string) {
	if (!files.has(path)) files.set(path, readFileSync(path, 'utf8'));
	return files.get(path)!;
}

/** Scores the detector against every label, and returns how many things differ. */
function score(say: (line: string) => void) {
	let problems = 0;

	for (const [name, want] of Object.entries<Record<string, [number, number]>>(labels.recordings)) {
		const path = `${DIR}/${name}`;
		if (!existsSync(path)) continue;
		const d = JSON.parse(read(path));
		const frames = d.frames.filter((f: { yaw?: number }) => f.yaw !== undefined);
		const stepAt = (t: number) => d.marks.findLast((m: { t: number }) => t >= m.t)?.id;
		const got: Record<string, [number, number]> = {};
		const g = new HeadGestures();
		for (const f of frames) {
			const e = g.push(f.t, f.yaw, f.pitch);
			if (!e) continue;
			(got[stepAt(f.t)] ??= [0, 0])[e.kind === 'nod' ? 0 : 1]++;
		}
		say(`\n${name}`);
		for (const [step, [wantNods, wantShakes]] of Object.entries(want)) {
			const [nods, shakes] = got[step] ?? [0, 0];
			const ok = nods === wantNods && shakes === wantShakes;
			if (!ok) problems++;
			say(`  ${ok ? 'ok  ' : 'DIFF'} ${step.padEnd(14)} wanted ${wantNods}n ${wantShakes}s, got ${nods}n ${shakes}s`);
		}
	}

	type Row = Record<string, any>;
	for (const [name, want] of Object.entries<Row>(labels.sessions)) {
		const path = `${DIR}/sessions/${name}`;
		if (!existsSync(path)) continue;
		const rows: Row[] = read(path).trim().split('\n').map((l) => JSON.parse(l));
		rows.sort((a, b) => a.t - b.t);
		const frames = rows.filter((r) => r.e === undefined);
		const confirms = rows.filter((r) => r.e === 'confirm');
		const t0 = frames[0].t;
		const seconds = (t: number) => (t - t0) / 1000;

		/** The target nearest the pointer at a moment, from the layout logged at the closest pick. */
		const aimedAt = (at: number, onset: number, target: string) => {
			// Each pick logged the layout at that moment, so use one that had this target on screen.
			const layouts = confirms.filter((c) => c.targets?.some((r: any[]) => r[0] === target));
			const c = (layouts.length ? layouts : confirms).reduce((a, b) =>
				Math.abs(b.t - at) < Math.abs(a.t - at) ? b : a
			);
			const nearestFrame = (time: number) =>
				frames.reduce((a, b) => (Math.abs(b.t - time) < Math.abs(a.t - time) ? b : a));
			const nearestTarget = (f: Row) => {
				const headX = f.a ?? f.x;
				const headY = f.b ?? f.v;
				let best = '-';
				let bestGap = Infinity;
				for (const [id, l, t, w, h] of c.targets ?? []) {
					const gap = Math.hypot(Math.max(l - headX, 0, headX - l - w), Math.max(t - headY, 0, headY - t - h));
					if (gap < bestGap) {
						bestGap = gap;
						best = id;
					}
				}
				return { id: best, gap: Math.round(bestGap) };
			};
			const start = nearestFrame(onset);
			const end = nearestFrame(at);
			const began = nearestTarget(start);
			const arrived = nearestTarget(end);
			// As in the game: still sweeping along a row of one kind means the neighbour was meant.
			const sameKind = began.id.split('-')[0] === arrived.id.split('-')[0] && !arrived.id.startsWith('cell-');
			const sideways = Math.abs((end.a ?? end.x) - (start.a ?? start.x));
			return sameKind && sideways >= 100 ? arrived : began;
		};

		const fired: { s: number; onset: number; at: number; size: number; speed: number }[] = [];
		const shakes: number[] = [];
		const g = new HeadGestures();
		for (const f of frames) {
			const e = g.push(f.t, f.y, f.p);
			if (e?.kind === 'nod') fired.push({ s: seconds(f.t), onset: e.onset, at: f.t, size: e.sizeDeg, speed: e.speed });
			if (e?.kind === 'shake') shakes.push(seconds(f.t));
		}

		say(`\n${name}`);
		const used = new Set<number>();
		for (const [s, target] of want.wanted as [number, string][]) {
			const i = fired.findIndex((n, j) => !used.has(j) && Math.abs(n.s - s) <= MATCH_S);
			if (i < 0) {
				problems++;
				say(`  MISS  ${s.toFixed(1).padStart(5)}s wanted ${target}, no nod detected`);
				continue;
			}
			used.add(i);
			const n = fired[i];
			const aim = aimedAt(n.at, n.onset, target);
			const ok = aim.id === target;
			if (!ok) problems++;
			say(`  ${ok ? 'ok   ' : 'WRONG'} ${s.toFixed(1).padStart(5)}s wanted ${target.padEnd(12)} aimed ${aim.id} (${aim.gap}px off) ${n.size.toFixed(1)}° ${Math.round(n.speed)}°/s, ${Math.round(n.at - n.onset)}ms before firing`);
		}
		for (const s of (want.optional ?? []) as number[]) {
			const i = fired.findIndex((n, j) => !used.has(j) && Math.abs(n.s - s) <= MATCH_S);
			if (i >= 0) used.add(i);
		}
		for (const s of (want.shouldShake ?? []) as number[]) {
			const shook = shakes.some((t) => Math.abs(t - s) <= MATCH_S);
			if (!shook) problems++;
			say(`  ${shook ? 'ok   ' : 'MISS '} ${s.toFixed(1).padStart(5)}s should shake`);
		}
		for (const s of (want.shouldNotShake ?? []) as number[]) {
			const shook = shakes.some((t) => Math.abs(t - s) <= MATCH_S);
			if (shook) problems++;
			say(`  ${shook ? 'FALSE' : 'ok   '} ${s.toFixed(1).padStart(5)}s should not shake`);
		}
		for (const s of want.shouldNotFire as number[]) {
			const i = fired.findIndex((n, j) => !used.has(j) && Math.abs(n.s - s) <= MATCH_S);
			if (i >= 0) {
				used.add(i);
				problems++;
			}
			say(`  ${i >= 0 ? 'FALSE' : 'ok   '} ${s.toFixed(1).padStart(5)}s should not fire${i >= 0 ? `, fired ${fired[i].size.toFixed(1)}°` : ''}`);
		}
		fired.forEach((n, j) => {
			if (used.has(j)) return;
			say(`  extra ${n.s.toFixed(1).padStart(5)}s nod ${n.size.toFixed(1)}° ${Math.round(n.speed)}°/s (not labelled)`);
		});
	}
	return problems;
}

if (process.argv.includes('--sweep')) {
	const keys = Object.keys(SWEEP) as (keyof typeof gestureConfig)[];
	const start = { ...gestureConfig };
	const results: { settings: Record<string, number>; problems: number }[] = [];
	const walk = (i: number, settings: Record<string, number>) => {
		if (i === keys.length) {
			Object.assign(gestureConfig, settings);
			results.push({ settings, problems: score(() => {}) });
			return;
		}
		for (const v of SWEEP[keys[i]]!) walk(i + 1, { ...settings, [keys[i]]: v });
	};
	walk(0, {});
	Object.assign(gestureConfig, start);
	results.sort((a, b) => a.problems - b.problems);
	const fewest = results[0].problems;
	const best = results.filter((r) => r.problems <= fewest);
	console.log(`Tried ${results.length} settings. Current settings: ${score(() => {})} differences. Fewest: ${fewest}, reached by ${best.length}.`);
	console.table(best.slice(0, 10).map((r) => ({ ...r.settings, problems: r.problems })));
	console.log('How often each value appears among the best:');
	for (const k of keys) {
		const counts: Record<string, number> = {};
		for (const r of best) counts[r.settings[k]] = (counts[r.settings[k]] ?? 0) + 1;
		console.log(`  ${k}: ${JSON.stringify(counts)}`);
	}
} else {
	const problems = score(console.log);
	console.log(problems ? `\n${problems} difference(s) from the labels` : '\nAll labels matched');
}
