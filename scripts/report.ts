/**
 * Turns a recorded play session into something readable: a timeline of what the player saw and did,
 * a list of moments worth checking, and a chart. `bun run report` reads the newest session, or
 * `bun run report <file>` a specific one. The chart is saved to .recordings/reports.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { HeadGestures } from '../src/lib/vision/gestures';
import { findCandidates, type Candidate, type Frame } from './candidates';

type Row = Record<string, any>;

const DIR = '.recordings/sessions';
/** A pick undone this soon afterwards was probably a mistake. */
const UNDONE_WITHIN_S = 3;
/** A nod this soon after the last one is suspicious. Played nods were at least 2s apart. */
const TOO_SOON_S = 1.5;
const CHART_ROW_S = 25;
/** Slower or smaller than this doesn't look like an attempt, so it isn't listed as a miss. */
const ATTEMPT_MIN_DEG = 2.5;
const ATTEMPT_MIN_SPEED = 20;
/** How far back to look for what led up to a marked mistake. */
const MISTAKE_LOOKBACK_S = 4;

function newestSession() {
	const files = readdirSync(DIR)
		.filter((f) => f.endsWith('.jsonl'))
		.map((f) => join(DIR, f))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	// Opening the page starts a session even if no face was ever tracked, so skip those.
	const played = files.find((f) => readFileSync(f, 'utf8').includes('"p":'));
	if (!played) throw new Error(`No played sessions in ${DIR}. Play on the dev server first.`);
	return played;
}

const path = process.argv[2] ?? newestSession();
const rows: Row[] = readFileSync(path, 'utf8')
	.trim()
	.split('\n')
	.map((l) => JSON.parse(l))
	.sort((a, b) => a.t - b.t);
const frames = rows.filter((r) => r.e === undefined);
const events = rows.filter((r) => r.e !== undefined);
if (!frames.length) throw new Error('This session has no tracked frames.');

const t0 = frames[0].t;
const sec = (t: number) => (t - t0) / 1000;
const stamp = (t: number) => `${sec(t).toFixed(1).padStart(6)}s`;
const frameAt = (t: number) => frames.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
const headOf = (f: Row) => ({ x: f.a ?? f.x, y: f.b ?? f.v });

/** The target nearest a point, and how many pixels outside it the point is. */
function nearest(targets: any[], p: { x: number; y: number }) {
	let id: string | null = null;
	let gap = Infinity;
	for (const [name, l, t, w, h] of targets ?? []) {
		const d = Math.hypot(Math.max(l - p.x, 0, p.x - l - w), Math.max(t - p.y, 0, p.y - t - h));
		if (d < gap) {
			gap = d;
			id = name;
		}
	}
	return { id, gap: Math.round(gap) };
}

const checks: string[] = [];
const lines: string[] = [];
const counts = { nods: 0, shakes: 0, picks: 0, missed: 0, rejected: 0, mistakes: 0 };
let lastNod: number | null = null;
let lastRejected: number | null = null;
let lastGame = '';

for (const e of events) {
	const when = stamp(e.t);
	switch (e.e) {
		case 'stage':
			lines.push(`\n=== ${e.stage} (${sec(e.t).toFixed(1)}s)`);
			break;
		case 'game': {
			const { t: _t, e: _e, says, ...state } = e;
			const text = JSON.stringify(state);
			if (text !== lastGame) lines.push(`${when}   game: ${text}${says ? `  "${says}"` : ''}`);
			lastGame = text;
			break;
		}
		case 'gesture': {
			const speed = e.speed === undefined ? '' : `, ${e.speed}°/s`;
			lines.push(`${when} ${e.kind.toUpperCase()} ${e.sizeDeg}°${speed}, began ${Math.round(e.at - e.onset)}ms before firing`);
			if (e.kind === 'nod') {
				counts.nods++;
				if (lastNod !== null && (e.at - lastNod) / 1000 < TOO_SOON_S) {
					checks.push(`${when} nod only ${((e.at - lastNod) / 1000).toFixed(1)}s after the last one`);
				}
				lastNod = e.at;
			} else counts.shakes++;
			break;
		}
		case 'confirm': {
			const head = headOf(frameAt(e.onset));
			const aim = nearest(e.targets, head);
			const near = aim.id ? `pointer nearest ${aim.id} (${aim.gap}px off)` : 'nothing could be picked';
			lines.push(`${when}   -> chose ${e.chose ?? 'nothing'}; ${near}`);
			if (!e.chose) {
				counts.missed++;
				if (e.targets?.length) checks.push(`${when} nod landed on nothing, nearest was ${aim.id} (${aim.gap}px off)`);
				break;
			}
			counts.picks++;
			if (aim.id && aim.id !== e.chose) checks.push(`${when} chose ${e.chose} but the pointer was nearest ${aim.id}`);
			const undo = events.find((x) => x.e === 'cancel' && x.t > e.t && x.t - e.t < UNDONE_WITHIN_S * 1000);
			if (undo) checks.push(`${when} chose ${e.chose}, undone by a shake ${((undo.t - e.t) / 1000).toFixed(1)}s later`);
			break;
		}
		case 'rejected':
			// One movement can be turned down on several frames in a row. Report it once.
			if (lastRejected !== null && e.t - lastRejected < 500) {
				lastRejected = e.t;
				break;
			}
			lastRejected = e.t;
			counts.rejected++;
			lines.push(`${when} turned down ${e.kind}: ${e.sizeDeg.toFixed(1)}° at ${Math.round(e.speed)}°/s, needed ${Math.round(e.needSpeed)}°/s`);
			break;
		case 'mistake':
			counts.mistakes++;
			lines.push(`${when} *** PLAYER MARKED A MISTAKE (selected ${e.selected ?? 'nothing'})`);
			checks.unshift(`${when} PLAYER MARKED A MISTAKE (selected ${e.selected ?? 'nothing'})`);
			break;
		case 'zoom':
			lines.push(`${when}   zoom on row ${e.r} column ${e.c}`);
			break;
		case 'place':
			lines.push(`${when}   placed ${e.letter} at row ${e.r} column ${e.c}`);
			break;
		case 'played':
			lines.push(`${when}   played ${e.word} for ${e.gained}`);
			break;
		case 'cancel':
			lines.push(`${when}   went back`);
			break;
		case 'away':
			lines.push(`${when}   left the game`);
			break;
		case 'back':
			lines.push(`${when}   came back`);
			break;
		case 'ignored':
			lines.push(`${when}   ignored a ${e.kind} (${e.why})`);
			break;
	}
}

/** The last value of a logged thing before a moment. */
function lastBefore(type: string, t: number) {
	return events.findLast((e) => e.e === type && e.t <= t);
}

/**
 * Replays the session through the real detector and notes what it thought on each frame, so a
 * missed gesture can be explained by the code that missed it.
 */
const verdicts: { t: number; nod: string | null; shake: string | null }[] = [];
const wouldFire: { kind: string; t: number }[] = [];
const replayed = new HeadGestures();
for (const f of frames) {
	const fired = replayed.push(f.t, f.y, f.p);
	if (fired) wouldFire.push({ kind: fired.kind, t: f.t });
	verdicts.push({
		t: f.t,
		nod: fired?.kind === 'nod' ? null : replayed.inspect('nod', f.t),
		shake: fired?.kind === 'shake' ? null : replayed.inspect('shake', f.t)
	});
}

/** What the detector was saying as this movement finished, which is when it could have fired. */
function whyNotCounted(c: Candidate) {
	const key = c.axis === 'pitch' ? 'nod' : 'shake';
	if (wouldFire.some((g) => g.kind === key && g.t >= c.start && g.t <= c.end + 300)) {
		return 'would count now with the current settings';
	}
	const seen = verdicts.filter((v) => v.t >= c.far && v.t <= c.end + 300).map((v) => v[key]);
	const words = (v: string | null) => (v ?? '').replace(/[\d.]+/g, '#');
	const counts = new Map<string, number>();
	for (const v of seen) counts.set(words(v), (counts.get(words(v)) ?? 0) + 1);
	const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
	return seen.find((v) => words(v) === top) ?? 'no frames to judge';
}

/**
 * Movements shaped like a gesture that never fired, found from the head data itself. Anything the
 * detector ignores leaves no event, so this is the only way to see a missed nod.
 */
function findMisses() {
	const gestures = events.filter((e) => e.e === 'gesture');
	const misses: { c: Candidate; selected: string | null; why: string }[] = [];
	const list = [...findCandidates(frames as Frame[], 'pitch'), ...findCandidates(frames as Frame[], 'yaw')];
	for (const c of list.sort((a, b) => a.start - b.start)) {
		if (c.sizeDeg < ATTEMPT_MIN_DEG || c.speed < ATTEMPT_MIN_SPEED) continue;
		const kind = c.axis === 'pitch' ? 'nod' : 'shake';
		if (gestures.some((g) => g.kind === kind && g.at >= c.start && g.at <= c.end + 300)) continue;
		const last = misses[misses.length - 1];
		if (last && last.c.axis === c.axis && c.start < last.c.end) continue;
		const selected = lastBefore('focus', c.start)?.id ?? null;
		// A nod with nothing selected couldn't have done anything, but a shake always can.
		if (c.axis === 'pitch' && !selected) continue;
		misses.push({ c, selected, why: whyNotCounted(c) });
	}
	return misses;
}

const misses = findMisses();

/** A move at least this big just before a pick counts as big, in degrees. */
const BIG_MOVE_DEG = 8;
const AIM_LOOKBACK_MS = 1500;
const ARRIVED_DEG_S = 15;
const ARRIVED_SPAN_FRAMES = 4;

/** How well the pointer was on target at each pick, split by how far the head had just moved. */
function aimSummary() {
	const middle = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
	const picks = events.flatMap((e) => {
		const box = e.e === 'confirm' && e.chose ? e.targets?.find((r: any[]) => r[0] === e.chose) : null;
		if (!box) return [];
		const before = frames.filter((f) => f.t >= e.onset - AIM_LOOKBACK_MS && f.t <= e.onset);
		if (before.length < 5) return [];
		const range = (k: 'y' | 'p') => Math.max(...before.map((f) => f[k])) - Math.min(...before.map((f) => f[k]));
		const head = headOf(before[before.length - 1]);
		const [, l, t, w, h] = box;
		let arrivedMs = AIM_LOOKBACK_MS;
		// Measured over a few frames, because tracking noise alone looks fast between two frames.
		for (let i = before.length - 1; i >= ARRIVED_SPAN_FRAMES; i--) {
			const [a, b] = [before[i - ARRIVED_SPAN_FRAMES], before[i]];
			if ((Math.hypot(b.y - a.y, b.p - a.p) / Math.max(b.t - a.t, 1)) * 1000 > ARRIVED_DEG_S) {
				arrivedMs = e.onset - b.t;
				break;
			}
		}
		return [
			{
				big: Math.hypot(range('y'), range('p')) >= BIG_MOVE_DEG,
				offCentre: Math.hypot(head.x - l - w / 2, head.y - t - h / 2),
				outside: nearest([box], head).gap,
				arrivedMs
			}
		];
	});
	const line = (name: string, part: typeof picks) =>
		part.length
			? `${name}: ${part.length} picks, ${Math.round(middle(part.map((p) => p.offCentre)))}px off centre, ` +
				`${Math.round(middle(part.map((p) => p.outside)))}px outside the target, ` +
				`nodded ${Math.round(middle(part.map((p) => p.arrivedMs)))}ms after arriving`
			: `${name}: no picks`;
	return [line(`After big moves (${BIG_MOVE_DEG}°+)`, picks.filter((p) => p.big)), line('After small moves', picks.filter((p) => !p.big))];
}

const aim = aimSummary();

/** What led up to a mistake the player marked. */
function mistakeContext(mark: Row) {
	const recent = events.filter(
		(e) =>
			e.t <= mark.t &&
			e.t >= mark.t - MISTAKE_LOOKBACK_S * 1000 &&
			['gesture', 'confirm', 'cancel', 'place', 'zoom'].includes(e.e)
	);
	const picks = recent.filter((e) => e.e === 'confirm').map((e) => `${stamp(e.t).trim()} chose ${e.chose ?? 'nothing'}`);
	const missed = misses.filter((m) => m.c.end <= mark.t && m.c.end >= mark.t - MISTAKE_LOOKBACK_S * 1000);
	const notes = [...picks, ...missed.map((m) => `${stamp(m.c.far).trim()} ${m.c.axis === 'pitch' ? 'nod' : 'shake'} did not count`)];
	return notes.length ? notes.join('; ') : 'nothing happened in the seconds before';
}

for (const mark of events.filter((e) => e.e === 'mistake')) {
	checks.push(`${stamp(mark.t)} leading up to that mistake: ${mistakeContext(mark)}`);
}

console.log(`Session ${basename(path)}: ${Math.round(sec(frames[frames.length - 1].t))}s, ${frames.length} frames`);
console.log(lines.join('\n'));
console.log(
	`\nTotals: ${counts.nods} nods, ${counts.shakes} shakes, ${counts.picks} picks, ${counts.missed} nods on nothing, ` +
		`${counts.rejected} turned down, ${counts.mistakes} marked mistakes`
);
console.log(`\nAim at the moment of each pick (median):\n  ${aim.join('\n  ')}`);
console.log(checks.length ? `\nWorth checking:\n  ${checks.join('\n  ')}` : '\nNothing obviously wrong.');
const missLines = misses.map(
	(m) =>
		`${stamp(m.c.far)} ${m.c.axis === 'pitch' ? 'nod' : 'shake'} ${m.c.sizeDeg.toFixed(1)}° ${Math.round(m.c.speed)}°/s` +
		`${m.selected ? ` on ${m.selected}` : ''}: ${m.why}`
);
console.log(missLines.length ? `\nLooked like a gesture but did not count:\n  ${missLines.join('\n  ')}` : '\nNo missed gestures found.');

/** Iris against head. Eyes roam during play, so the stillest stretches of head say the most. */
/** Nods keep breaking up play, and stretches between them rarely last longer than this. */
const EYE_WINDOW_S = 3;
const EYE_MAX_GAP_MS = 200;
const EYE_DRIFT_MS = 1000;

const midpoint = (values: number[]) => {
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spread = (values: number[]) => {
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
};
const range = (values: number[]) => Math.max(...values) - Math.min(...values);

/** Tracked runs without a break, leaving out blinks and the moments a nod is under way. */
function eyeRuns() {
	const open = frames.filter((f) => f.o != null).map((f) => f.o);
	const blink = open.length ? midpoint(open) * 0.6 : -Infinity;
	const runs: Row[][] = [];
	let run: Row[] = [];
	for (const f of frames) {
		const usable = f.i != null && !f.h && (f.o == null || f.o >= blink);
		if (!usable || (run.length && f.t - run[run.length - 1].t > EYE_MAX_GAP_MS)) {
			if (run.length) runs.push(run);
			run = [];
		}
		if (usable) run.push(f);
	}
	if (run.length) runs.push(run);
	return runs;
}

/** What's left of a signal once slow drift is gone. */
function eyeWobble(run: Row[], key: string) {
	return run.map((f) => {
		const near = run.filter((o) => Math.abs(o.t - f.t) <= EYE_DRIFT_MS / 2).map((o) => o[key]);
		return f[key] - midpoint(near);
	});
}

/** The strongest repeating movement between 1 and 10 Hz, and how much of that band it holds. */
function strongestHz(run: Row[], key: string) {
	const mean = run.reduce((a, f) => a + f[key], 0) / run.length;
	const span = run[run.length - 1].t - run[0].t;
	let best = { hz: 0, share: 0 };
	let peak = 0;
	let total = 0;
	for (let hz = 1; hz <= 10; hz += 0.2) {
		let re = 0;
		let im = 0;
		run.forEach((f, i) => {
			const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (f.t - run[0].t)) / span);
			re += (f[key] - mean) * w * Math.cos((2 * Math.PI * hz * f.t) / 1000);
			im += (f[key] - mean) * w * Math.sin((2 * Math.PI * hz * f.t) / 1000);
		});
		const power = re * re + im * im;
		total += power;
		if (power > peak) {
			peak = power;
			best = { hz, share: 0 };
		}
	}
	return { hz: best.hz, share: peak / (total || 1) };
}

function stillestStretches(runs: Row[][], count: number) {
	const found: { head: number; part: Row[] }[] = [];
	for (const run of runs) {
		for (let a = 0; a < run.length; a += 15) {
			let b = a;
			while (b < run.length && run[b].t - run[a].t < EYE_WINDOW_S * 1000) b++;
			if (b >= run.length) break;
			const part = run.slice(a, b);
			if (part.length < EYE_WINDOW_S * 20) continue;
			found.push({ head: spread(part.map((f) => f.y)) + spread(part.map((f) => f.p)), part });
		}
	}
	found.sort((x, y) => x.head - y.head);
	const kept: Row[][] = [];
	for (const { part } of found) {
		if (kept.every((k) => part[0].t > k[k.length - 1].t || part[part.length - 1].t < k[0].t)) kept.push(part);
		if (kept.length === count) break;
	}
	return kept;
}

const eyeLines: string[] = [];
const eyeStretches = stillestStretches(eyeRuns(), 5);
if (frames.some((f) => f.i != null)) {
	const runs = eyeRuns().filter((r) => r.length >= 60);
	const typical = (key: string) =>
		midpoint(runs.flatMap((r) => eyeWobble(r, key).map(Math.abs)));
	eyeLines.push(
		`All play, typical wobble: iris ${typical('i').toFixed(2)}° across, ${typical('j').toFixed(2)}° up and down. ` +
			`Head ${typical('y').toFixed(2)}° yaw, ${typical('p').toFixed(2)}° pitch.`
	);
	for (const part of eyeStretches) {
		const v = (key: string) => part.map((f) => f[key]);
		const hz = strongestHz(part, 'i');
		const headHz = strongestHz(part, 'y');
		eyeLines.push(
			`${stamp(part[0].t)} stillest head: iris spread ${spread(v('i')).toFixed(2)}° across, ${spread(v('j')).toFixed(2)}° up and down, ` +
				`range ${range(v('i')).toFixed(1)}° and ${range(v('j')).toFixed(1)}°. ` +
				`Head spread ${spread(v('y')).toFixed(2)}° yaw, ${spread(v('p')).toFixed(2)}° pitch. ` +
				`Strongest rhythm: iris ${hz.hz.toFixed(1)} Hz (${Math.round(hz.share * 100)}% of band), head ${headHz.hz.toFixed(1)} Hz (${Math.round(headHz.share * 100)}%).`
		);
	}
	console.log(`\nEyes against head:\n  ${eyeLines.join('\n  ')}`);
}

const esc = (s: unknown) =>
	String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** One stretch of the session: head angles, pointer height, and every gesture and pick. */
function chartRow(from: number) {
	const to = from + CHART_ROW_S;
	const fs = frames.filter((f) => sec(f.t) >= from && sec(f.t) < to);
	if (!fs.length) return '';
	const W = 1400;
	const H = 170;
	const x = (s: number) => ((s - from) / CHART_ROW_S) * W;
	const deg = (d: number) => H / 2 - d * 3.4;
	const line = (pick: (f: Row) => number | null, color: string, width = 1.5) =>
		`<polyline fill="none" stroke="${color}" stroke-width="${width}" points="${fs
			.map((f) => `${x(sec(f.t)).toFixed(1)},${(pick(f) ?? 0).toFixed(1)}`)
			.join(' ')}"/>`;
	const marks = events
		.filter((e) => sec(e.t) >= from && sec(e.t) < to)
		.map((e) => {
			const px = x(sec(e.t));
			if (e.e === 'gesture') {
				const color = e.kind === 'nod' ? '#16a34a' : '#9333ea';
				const start = Math.max(x(sec(e.onset)), 0);
				return `<rect x="${start}" y="0" width="${Math.max(px - start, 2)}" height="${H}" fill="${color}" opacity="0.2"><title>${esc(`${e.kind} ${e.sizeDeg}° ${e.speed ?? ''}°/s`)}</title></rect>`;
			}
			if (e.e === 'confirm') return `<text x="${px + 2}" y="${H - 5}" class="pick">${esc(e.chose ?? 'nothing')}</text>`;
			if (e.e === 'mistake') return `<line x1="${px}" x2="${px}" y1="0" y2="${H}" stroke="#e11d48" stroke-width="3"><title>Marked mistake</title></line>`;
			if (e.e === 'stage') return `<line x1="${px}" x2="${px}" y1="0" y2="${H}" class="stage"/><text x="${px + 3}" y="13" class="pick">${esc(e.stage)}</text>`;
			if (e.e === 'rejected') return `<circle cx="${px}" cy="12" r="4" fill="#f59e0b"><title>${esc(`turned down ${e.kind} ${e.sizeDeg.toFixed(1)}°`)}</title></circle>`;
			return '';
		})
		.join('');
	const heights = frames.map((f) => f.v ?? 0);
	const tallest = Math.max(...heights, 1);
	const missMarks = misses
		.filter((m) => sec(m.c.far) >= from && sec(m.c.far) < to)
		.map(
			(m) =>
				`<circle cx="${x(sec(m.c.far))}" cy="26" r="6" fill="none" stroke="#f59e0b" stroke-width="2.5"><title>${esc(`Did not count: ${m.why}`)}</title></circle>`
		)
		.join('');
	const irisLines =
		fs[0].i != null
			? line((f) => deg((f.j ?? fs[0].j) - fs[0].j), '#fdba74', 1) + line((f) => deg((f.i ?? fs[0].i) - fs[0].i), '#f97316', 1)
			: '';
	return `<h2>${from}–${to}s</h2><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Head movement from ${from} to ${to} seconds">
		${marks}
		${missMarks}
		${line((f) => (f.v == null ? null : (f.v / tallest) * H), 'var(--pointer)', 1)}
		${line((f) => deg(f.p - fs[0].p), '#dc2626')}
		${line((f) => deg(f.y - fs[0].y), '#2563eb')}
		${irisLines}
	</svg>`;
}

/** The head's stillest stretch up close, with iris and head on one scale. */
function eyeChart(part: Row[]) {
	const W = 1400;
	const H = 320;
	const keys: [string, string][] = [
		['j', '#fdba74'],
		['i', '#f97316'],
		['p', '#dc2626'],
		['y', '#2563eb']
	];
	const centred = (key: string) => {
		const mid = midpoint(part.map((f) => f[key]));
		return part.map((f) => f[key] - mid);
	};
	const reach = Math.max(1, ...keys.flatMap(([k]) => centred(k).map(Math.abs)));
	const paths = keys
		.map(([k, color]) => {
			const values = centred(k);
			const points = part
				.map((f, i) => `${(((f.t - part[0].t) / (EYE_WINDOW_S * 1000)) * W).toFixed(1)},${(H / 2 - (values[i] / reach) * (H / 2 - 4)).toFixed(1)}`)
				.join(' ');
			return `<polyline fill="none" stroke="${color}" stroke-width="1.8" points="${points}"/>`;
		})
		.join('');
	return `<h2>${stamp(part[0].t).trim()}: ${EYE_WINDOW_S} seconds, top to bottom is ±${reach.toFixed(1)}°</h2><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Iris and head movement during a still stretch">${paths}</svg>`;
}

const rowsHtml: string[] = [];
const end = sec(frames[frames.length - 1].t);
for (let from = 0; from < end; from += CHART_ROW_S) rowsHtml.push(chartRow(from));

const html = `<!doctype html><meta charset="utf-8"><title>Session ${esc(basename(path))}</title>
<style>
:root { --bg: #fff; --fg: #0f172a; --muted: #64748b; --pointer: #94a3b8; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #020617; --fg: #e2e8f0; --muted: #94a3b8; --pointer: #475569; } }
body { margin: 16px; background: var(--bg); color: var(--fg); font: 14px system-ui, sans-serif; }
h1 { font-size: 20px; } h2 { margin: 16px 0 2px; font-size: 13px; color: var(--muted); font-weight: 600; }
svg { display: block; width: 100%; height: auto; border: 1px solid var(--pointer); }
.pick { font-size: 11px; fill: var(--fg); } .stage { stroke: var(--fg); stroke-width: 2; }
pre { white-space: pre-wrap; } .red { color: #dc2626; } .blue { color: #2563eb; } .green { color: #16a34a; } .purple { color: #9333ea; }
</style>
<h1>Session ${esc(basename(path))}</h1>
<p><b class="red">Pitch</b> · <b class="blue">Yaw</b> · grey is pointer height · <b class="green">green</b> is a nod · <b class="purple">purple</b> is a shake · an orange dot was turned down · an orange ring looked like a gesture but did not count · a thick red line is a marked mistake</p>
<h2>Aim at the moment of each pick (median)</h2><pre>${esc(aim.join('\n'))}</pre>
${eyeLines.length ? `<h2>Eyes against head</h2><pre>${esc(eyeLines.join('\n'))}</pre><p><b style="color:#f97316">Iris across</b> · <b style="color:#fdba74">Iris up and down</b> · <b class="blue">Yaw</b> · <b class="red">Pitch</b></p>${eyeStretches.map(eyeChart).join('\n')}` : ''}
${checks.length ? `<h2>Worth checking</h2><pre>${esc(checks.join('\n'))}</pre>` : ''}
${missLines.length ? `<h2>Looked like a gesture but did not count</h2><pre>${esc(missLines.join('\n'))}</pre>` : ''}
${rowsHtml.join('\n')}
<h2>Timeline</h2><pre>${esc(lines.join('\n'))}</pre>`;

mkdirSync('.recordings/reports', { recursive: true });
const out = `.recordings/reports/${basename(path, '.jsonl')}.html`;
writeFileSync(out, html);
console.log(`\nChart saved to ${out}`);
