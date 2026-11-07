/**
 * Replays saved recordings through the real gesture detector and scores it, so a change to the
 * detector can be checked against what players actually did. `bun run replay`
 *
 * Labels live in scripts/labels.json. The recordings themselves stay in .recordings, unshared.
 */
import { existsSync, readFileSync } from 'node:fs';
import { HeadGestures } from '../src/lib/vision/gestures';

const DIR = '.recordings';
const labels = JSON.parse(readFileSync('scripts/labels.json', 'utf8'));
const MATCH_S = 0.45;
let problems = 0;

for (const [name, want] of Object.entries<Record<string, [number, number]>>(labels.recordings)) {
	const path = `${DIR}/${name}`;
	if (!existsSync(path)) continue;
	const d = JSON.parse(readFileSync(path, 'utf8'));
	const frames = d.frames.filter((f: { yaw?: number }) => f.yaw !== undefined);
	const stepAt = (t: number) => d.marks.findLast((m: { t: number }) => t >= m.t)?.id;
	const got: Record<string, [number, number]> = {};
	const g = new HeadGestures();
	for (const f of frames) {
		const e = g.push(f.t, f.yaw, f.pitch);
		if (!e) continue;
		(got[stepAt(f.t)] ??= [0, 0])[e.kind === 'nod' ? 0 : 1]++;
	}
	console.log(`\n${name}`);
	for (const [step, [wantNods, wantShakes]] of Object.entries(want)) {
		const [nods, shakes] = got[step] ?? [0, 0];
		const ok = nods === wantNods && shakes === wantShakes;
		if (!ok) problems++;
		console.log(`  ${ok ? 'ok  ' : 'DIFF'} ${step.padEnd(14)} wanted ${wantNods}n ${wantShakes}s, got ${nods}n ${shakes}s`);
	}
}

type Row = Record<string, any>;
for (const [name, want] of Object.entries<Row>(labels.sessions)) {
	const path = `${DIR}/sessions/${name}`;
	if (!existsSync(path)) continue;
	const rows: Row[] = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	rows.sort((a, b) => a.t - b.t);
	const frames = rows.filter((r) => r.e === undefined);
	const confirms = rows.filter((r) => r.e === 'confirm');
	const t0 = frames[0].t;
	const seconds = (t: number) => (t - t0) / 1000;

	/** The target nearest the pointer at a moment, from the layout logged at the closest pick. */
	const aimedAt = (at: number, onset: number) => {
		const c = confirms.reduce((a, b) => (Math.abs(b.t - at) < Math.abs(a.t - at) ? b : a));
		const f = frames.reduce((a, b) => (Math.abs(b.t - onset) < Math.abs(a.t - onset) ? b : a));
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

	const fired: { s: number; onset: number; at: number; size: number; speed: number }[] = [];
	const g = new HeadGestures();
	for (const f of frames) {
		const e = g.push(f.t, f.y, f.p);
		if (e?.kind === 'nod') fired.push({ s: seconds(f.t), onset: e.onset, at: f.t, size: e.sizeDeg, speed: e.speed });
	}

	console.log(`\n${name}`);
	const used = new Set<number>();
	for (const [s, target] of want.wanted as [number, string][]) {
		const i = fired.findIndex((n, j) => !used.has(j) && Math.abs(n.s - s) <= MATCH_S);
		if (i < 0) {
			problems++;
			console.log(`  MISS  ${s.toFixed(1).padStart(5)}s wanted ${target}, no nod detected`);
			continue;
		}
		used.add(i);
		const n = fired[i];
		const aim = aimedAt(n.at, n.onset);
		const ok = aim.id === target;
		if (!ok) problems++;
		console.log(`  ${ok ? 'ok   ' : 'WRONG'} ${s.toFixed(1).padStart(5)}s wanted ${target.padEnd(12)} aimed ${aim.id} (${aim.gap}px off) ${n.size.toFixed(1)}° ${Math.round(n.speed)}°/s, ${Math.round(n.at - n.onset)}ms before firing`);
	}
	for (const s of want.shouldNotFire as number[]) {
		const i = fired.findIndex((n, j) => !used.has(j) && Math.abs(n.s - s) <= MATCH_S);
		if (i >= 0) {
			used.add(i);
			problems++;
		}
		console.log(`  ${i >= 0 ? 'FALSE' : 'ok   '} ${s.toFixed(1).padStart(5)}s should not fire${i >= 0 ? `, fired ${fired[i].size.toFixed(1)}°` : ''}`);
	}
	fired.forEach((n, j) => {
		if (used.has(j)) return;
		console.log(`  extra ${n.s.toFixed(1).padStart(5)}s nod ${n.size.toFixed(1)}° ${Math.round(n.speed)}°/s (not labelled)`);
	});
}

console.log(problems ? `\n${problems} difference(s) from the labels` : '\nAll labels matched');
