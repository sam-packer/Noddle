/**
 * Turns a recorded play session into something readable: a timeline of what the player saw and did,
 * a list of moments worth checking, and a chart. `bun run report` reads the newest session, or
 * `bun run report <file>` a specific one. The chart is saved to .recordings/reports.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

type Row = Record<string, any>;

const DIR = '.recordings/sessions';
/** A pick undone this soon afterwards was probably a mistake. */
const UNDONE_WITHIN_S = 3;
/** A nod this soon after the last one is suspicious. Played nods were at least 2s apart. */
const TOO_SOON_S = 1.5;
const CHART_ROW_S = 25;

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
			lines.push(`${when} turned down ${e.kind}: ${e.sizeDeg.toFixed(1)}° ${Math.round(e.speed)}°/s, needed ${e.needDeg.toFixed(1)}° ${Math.round(e.needSpeed)}°/s`);
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
	}
}

console.log(`Session ${basename(path)}: ${Math.round(sec(frames[frames.length - 1].t))}s, ${frames.length} frames`);
console.log(lines.join('\n'));
console.log(
	`\nTotals: ${counts.nods} nods, ${counts.shakes} shakes, ${counts.picks} picks, ${counts.missed} nods on nothing, ` +
		`${counts.rejected} turned down, ${counts.mistakes} marked mistakes`
);
console.log(checks.length ? `\nWorth checking:\n  ${checks.join('\n  ')}` : '\nNothing obviously wrong.');

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
	return `<h2>${from}–${to}s</h2><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Head movement from ${from} to ${to} seconds">
		${marks}
		${line((f) => (f.v == null ? null : (f.v / tallest) * H), 'var(--pointer)', 1)}
		${line((f) => deg(f.p - fs[0].p), '#dc2626')}
		${line((f) => deg(f.y - fs[0].y), '#2563eb')}
	</svg>`;
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
<p><b class="red">Pitch</b> · <b class="blue">Yaw</b> · grey is pointer height · <b class="green">green</b> is a nod · <b class="purple">purple</b> is a shake · an orange dot was turned down · a thick red line is a marked mistake</p>
${checks.length ? `<h2>Worth checking</h2><pre>${esc(checks.join('\n'))}</pre>` : ''}
${rowsHtml.join('\n')}
<h2>Timeline</h2><pre>${esc(lines.join('\n'))}</pre>`;

mkdirSync('.recordings/reports', { recursive: true });
const out = `.recordings/reports/${basename(path, '.jsonl')}.html`;
writeFileSync(out, html);
console.log(`\nChart saved to ${out}`);
