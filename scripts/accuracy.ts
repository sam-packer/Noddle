/**
 * How accurate is head pointing, in numbers someone can quote? Reads every recorded session and
 * prints plain tables: where the pointer was at each pick, what the nods that landed on nothing
 * really were, what evidence there is of wrong picks, turned-down nods, and how long a player takes
 * to nod once they reach a target. `bun run accuracy` reads them all, `bun run accuracy <file>` one.
 *
 * Nothing here knows what the player meant, except for the sessions labelled in scripts/labels.json.
 * Anything else called a wrong pick is a proxy, and the tables say so.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { hitbox } from '../src/lib/input/hitbox';

type Row = Record<string, any>;
type Rect = [string, number, number, number, number];
type Point = { x: number; y: number };

const DIR = '.recordings/sessions';
/**
 * Sessions from here on are on the newest layout (the rack 10vw apart and centred, the shorter
 * lesson, and the harder-to-hit Leave button), so their numbers are kept apart from everything before. Move this when the layout
 * changes again, or the old and new numbers get mixed.
 */
const NEWEST_LAYOUT_FROM = 1794069786457;
/** Physical width of Sam's screen, taken as the viewport's width. See the note printed at the end. */
const SCREEN_CM = 30.4;
/** A full viewport width of pointer travel is this much head turn (headRangeYawDeg on each side). */
const SCREEN_DEG = 24;
/** One aim can be logged many times as it is turned down, frame after frame. */
const REJECTED_SAME_MS = 500;
/** How long after a nod a successful nod means a turned-down nod was retried. */
const RETRY_S = 3;
/** Undoing with a shake takes no aiming. Undoing with a back button means travelling to it. */
const UNDO_SHAKE_S = 3;
const UNDO_BUTTON_S = 8;
/** A tile picked up and never placed, then a different tile picked this soon, looks like the wrong tile. */
const TILE_CHANGED_S = 25;
/** A reload while developing leaves two copies of the tracker logging at once. Frames this close are theirs. */
const DOUBLED_FRAME_MS = 8;
const DOUBLED_SHARE = 0.2;
const DOUBLED_WINDOW_MS = 2000;
/** A tile lit for less than this as the nod began means the head was still on its way. */
const IN_TRANSIT_MS = 150;
/** Marks are made by hand, and sometimes late. */
const MARK_LOOKBACK_S = 5;
/** How far from a labelled time a nod can be and still be that nod. */
const LABEL_MATCH_S = 0.7;
/** Below this many picks a percentage means nothing, so the count is shown alone. */
const MIN_FOR_PERCENT = 20;
/** The nod began this fast: same as scripts/report.ts, measured over a few frames. */
const ARRIVED_DEG_S = 15;
const ARRIVED_SPAN_FRAMES = 4;
const ARRIVED_LOOKBACK_MS = 1500;
/** How the head maps to the screen's height (headRestY and the head ranges in vision/engine). */
const HEAD_REST_Y = 0.6;
const HEAD_RANGE_UP = 11;
const HEAD_RANGE_DOWN = 5;

const KINDS: [string, RegExp][] = [
	['Lesson cards', /^(spot-.*|practice-tile)$/],
	['Uno cards', /^card-/],
	['Uno draw pile', /^(draw|keep)$/],
	['Uno colours', /^pick-(red|blue|green|yellow)$/],
	['Scrabble rack', /^rack-/],
	['Scrabble board', /^board$/],
	['Scrabble squares', /^cell-/],
	['Menu buttons', /^(menu|menu-.*|room-.*|code-.*|start|again|lesson-.*)$/]
];
const OTHER_KIND = 'Other buttons';
const KIND_ORDER = [...KINDS.map(([name]) => name), OTHER_KIND];
const kindOf = (id: string) => KINDS.find(([, test]) => test.test(id))?.[0] ?? OTHER_KIND;
/** On screen whatever is happening, so these being legal doesn't mean there was anything to pick. */
const ALWAYS_THERE = /^(leave|close|hud-close|lesson-back)$/;
/** Nodding one of these straight after a pick takes that pick back. */
const BACK_BUTTON = /^(close|pick-close|recall|lesson-back)$/;

type Session = {
	name: string;
	id: number;
	newest: boolean;
	W: number;
	H: number;
	frames: Row[];
	events: Row[];
	activeS: number;
	t0: number;
	/** Events thrown away because two copies of the tracker were running. */
	doubled: number;
};

type Pick = {
	s: Session;
	e: Row;
	id: string;
	kind: string;
	rect: Rect | null;
	pointer: Point | null;
	offScreen: boolean;
	gap: number | null;
	centre: number | null;
	dx: number | null;
	dy: number | null;
	/** The legal target the pointer was nearest, by the same measure the game selects with. */
	nearest: string | null;
	reachMs: number | null;
	settledMs: number | null;
	undone: 'shake' | 'button' | null;
	shookNoEffect: boolean;
	marked: boolean;
	/** A rack tile that was never placed before a different tile was picked. */
	tileChanged: { id: string; afterS: number; adjacent: boolean } | null;
	label: { wanted: string; ok: boolean } | null;
};

const px2cm = (s: Session, px: number) => (px * SCREEN_CM) / s.W;
const px2deg = (s: Session, px: number) => (px * SCREEN_DEG) / s.W;
const sorted = (v: number[]) => [...v].sort((a, b) => a - b);
const quantile = (v: number[], q: number) => {
	if (!v.length) return NaN;
	const s = sorted(v);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const round = (v: number, places = 0) => (Number.isFinite(v) ? Number(v.toFixed(places)) : '-');

/** A count, with a percentage only when there are enough picks for one to mean anything. */
function share(part: number, whole: number) {
	if (!whole) return '-';
	if (whole < MIN_FOR_PERCENT) return `${part}/${whole}`;
	return `${part}/${whole} (${Math.round((part / whole) * 100)}%)`;
}

/** 95% Wilson interval. Says how little a small count can show. */
function wilson(part: number, whole: number) {
	if (!whole) return '-';
	const z = 1.96;
	const p = part / whole;
	const d = 1 + (z * z) / whole;
	const mid = p + (z * z) / (2 * whole);
	const half = z * Math.sqrt((p * (1 - p)) / whole + (z * z) / (4 * whole * whole));
	return `${Math.round((100 * (mid - half)) / d)}-${Math.round((100 * (mid + half)) / d)}%`;
}

/**
 * While the game is being edited, a hot reload can leave an old tracker running beside the new one.
 * Each fires its own nods at its own copy of the game, so nothing logged then is one player's play.
 */
function findDoubled(frames: Row[]) {
	const close = [0];
	for (let i = 1; i < frames.length; i++) {
		close.push(close[i - 1] + (frames[i].t - frames[i - 1].t < DOUBLED_FRAME_MS ? 1 : 0));
	}
	return (t: number) => {
		const from = lastFrameBefore(frames, t - DOUBLED_WINDOW_MS);
		const to = lastFrameBefore(frames, t + DOUBLED_WINDOW_MS);
		const count = to - from;
		return count >= 5 && (close[to] - close[Math.max(from, 0)]) / count > DOUBLED_SHARE;
	};
}

function loadSessions(paths: string[]) {
	const sessions: Session[] = [];
	for (const path of paths) {
		const rows: Row[] = readFileSync(path, 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.sort((a, b) => a.t - b.t);
		const frames = rows.filter((r) => r.e === undefined && r.y != null);
		const allEvents = rows.filter((r) => r.e !== undefined);
		// Opening the page starts a session even if no face was ever tracked.
		if (!frames.length) continue;
		const doubledAt = findDoubled(frames);
		const events = allEvents.filter((e) => !doubledAt(e.t));
		const start = events.find((e) => e.e === 'start');
		const name = basename(path);
		let activeS = 0;
		for (let i = 1; i < frames.length; i++) {
			const d = frames[i].t - frames[i - 1].t;
			if (d < 2000) activeS += d / 1000;
		}
		const id = Number(name.replace('.jsonl', ''));
		sessions.push({
			name,
			id,
			newest: id >= NEWEST_LAYOUT_FROM,
			W: start?.viewport?.width ?? 1512,
			H: start?.viewport?.height ?? 790,
			frames,
			events,
			activeS,
			t0: frames[0].t,
			doubled: allEvents.length - events.length
		});
	}
	return sessions;
}

const gapTo = (r: Rect, p: Point) =>
	Math.hypot(Math.max(r[1] - p.x, 0, p.x - r[1] - r[3]), Math.max(r[2] - p.y, 0, p.y - r[2] - r[4]));
const centreOf = (r: Rect) => ({ x: r[1] + r[3] / 2, y: r[2] + r[4] / 2 });

function nearestTarget(targets: Rect[], p: Point) {
	let id: string | null = null;
	let gap = Infinity;
	let best = Infinity;
	for (const r of targets) {
		const g = gapTo(r, p);
		const c = centreOf(r);
		// The small centre term is what the game adds to settle targets that touch.
		const d = g + Math.hypot(c.x - p.x, c.y - p.y) * 0.05;
		if (d < best) {
			best = d;
			gap = g;
			id = r[0];
		}
	}
	return { id, gap };
}

function lastFrameBefore(frames: Row[], t: number) {
	let lo = 0;
	let hi = frames.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (frames[mid].t <= t) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found;
}

/**
 * Where the pointer was at a nod. The logged x and y are the head's own point before it is clamped
 * to the screen, so a head turned past the edge logs thousands of pixels off screen while the
 * pointer sits on the edge. Selection uses the clamped pointer, so that is what's measured.
 */
function pointerAtNod(s: Session, e: Row): { pointer: Point | null; offScreen: boolean } {
	if (e.x != null && e.y != null) {
		const pointer = { x: Math.max(0, Math.min(s.W, e.x)), y: Math.max(0, Math.min(s.H, e.y)) };
		return { pointer, offScreen: e.x < 0 || e.x > s.W || e.y < 0 || e.y > s.H };
	}
	const f = s.frames[lastFrameBefore(s.frames, e.onset)];
	if (f?.x == null || f?.v == null) return { pointer: null, offScreen: false };
	return { pointer: { x: f.x, y: f.v }, offScreen: false };
}

/** How long before the nod began the head stopped moving, as scripts/report.ts measures it. */
function settledBeforeNod(s: Session, onset: number) {
	const end = lastFrameBefore(s.frames, onset);
	if (end < ARRIVED_SPAN_FRAMES) return null;
	for (let i = end; i >= ARRIVED_SPAN_FRAMES; i--) {
		const b = s.frames[i];
		if (onset - b.t > ARRIVED_LOOKBACK_MS) return ARRIVED_LOOKBACK_MS;
		const a = s.frames[i - ARRIVED_SPAN_FRAMES];
		const speed = (Math.hypot(b.y - a.y, b.p - a.p) / Math.max(b.t - a.t, 1)) * 1000;
		if (speed > ARRIVED_DEG_S) return onset - b.t;
	}
	return null;
}

const lastEvent = (s: Session, type: string, t: number) => s.events.findLast((e) => e.e === type && e.t <= t);

function loadLabels() {
	const path = 'scripts/labels.json';
	if (!existsSync(path)) return {} as Record<string, Row>;
	return JSON.parse(readFileSync(path, 'utf8')).sessions as Record<string, Row>;
}

function readPick(s: Session, e: Row, labels: Record<string, Row>): Pick {
	const id: string = e.chose;
	const targets: Rect[] = e.targets ?? [];
	const rect = targets.find((r) => r[0] === id) ?? null;
	const { pointer, offScreen } = pointerAtNod(s, e);
	const c = rect && centreOf(rect);

	// Only if the highlight was on this target as the nod began. Otherwise it never "reached" it.
	const focusBefore = lastEvent(s, 'focus', e.onset);
	const reachMs = focusBefore?.id === id ? e.onset - focusBefore.t : null;

	const next = s.events.filter(
		(x) => x.t > e.t && (x.e === 'cancel' || x.e === 'confirm') && x.t - e.t < UNDO_BUTTON_S * 1000
	);
	const firstInput = next[0];
	let undone: Pick['undone'] = null;
	let shookNoEffect = false;
	if (firstInput?.e === 'cancel' && firstInput.t - e.t <= UNDO_SHAKE_S * 1000) {
		if (firstInput.handled === false) shookNoEffect = true;
		else undone = 'shake';
	}
	if (firstInput?.e === 'confirm' && BACK_BUTTON.test(firstInput.chose ?? '')) undone = 'button';

	let tileChanged: Pick['tileChanged'] = null;
	if (id.startsWith('rack-') && lastEvent(s, 'game', e.t)?.stage !== 'swap') {
		const after = s.events.find(
			(x) => x.t > e.t && (x.e === 'place' || (x.e === 'confirm' && String(x.chose).startsWith('rack-')))
		);
		if (after?.e === 'confirm' && after.chose !== id && after.t - e.t < TILE_CHANGED_S * 1000) {
			tileChanged = {
				id: after.chose,
				afterS: (after.t - e.t) / 1000,
				adjacent: Math.abs(Number(after.chose.split('-')[1]) - Number(id.split('-')[1])) === 1
			};
		}
	}

	const marked = s.events.some((x) => x.e === 'mistake' && x.t > e.t && x.t - e.t <= MARK_LOOKBACK_S * 1000);

	const wanted: [number, string][] = labels[s.name]?.wanted ?? [];
	const at = (e.t - s.t0) / 1000;
	const match = wanted.find(([when]) => Math.abs(when - at) <= LABEL_MATCH_S);

	return {
		s,
		e,
		id,
		kind: kindOf(id),
		rect,
		pointer,
		offScreen,
		gap: pointer && rect ? gapTo(rect, pointer) : null,
		centre: pointer && c ? Math.hypot(pointer.x - c.x, pointer.y - c.y) : null,
		dx: pointer && c ? pointer.x - c.x : null,
		dy: pointer && c ? pointer.y - c.y : null,
		nearest: pointer && targets.length ? nearestTarget(targets, pointer).id : null,
		reachMs,
		settledMs: settledBeforeNod(s, e.onset),
		undone,
		shookNoEffect,
		marked,
		tileChanged,
		label: match ? { wanted: match[1], ok: match[1] === id } : null
	};
}

/** What was going on when a nod landed on nothing: which screen, and whether it was their go. */
function situation(s: Session, e: Row) {
	const stage: string = lastEvent(s, 'stage', e.t)?.stage ?? '?';
	const game = lastEvent(s, 'game', e.t);
	if (stage === 'instructions') return 'Lesson';
	if (stage === 'menu' || stage === 'room' || stage === 'gate') return 'Menus';
	if (/uno/.test(stage)) {
		if (['play', 'pick', 'drawn', 'keep'].includes(game?.phase)) return "Uno, player's turn";
		if (game?.phase === 'over' || game?.phase === 'done') return 'Uno, game over';
		return 'Uno, not their turn';
	}
	if (/scrabble/.test(stage)) {
		if (game?.stage === 'done') return 'Scrabble, game over';
		if (game && game.current != null && game.current !== 0) return 'Scrabble, not their turn';
		return "Scrabble, player's turn";
	}
	return stage;
}

const NOTHING_CLASSES = [
	'Nothing to pick (only Leave/back on screen)',
	'No pointer at the time',
	'Head off screen (pointer stuck on an edge)',
	`Within reach (under ${hitbox.padPx}px) but not selected`,
	`Short of reach (${hitbox.padPx}-${hitbox.padPx * 2}px)`,
	`Nowhere near a target (over ${hitbox.padPx * 2}px)`
];

function classifyNothing(s: Session, e: Row) {
	const targets: Rect[] = e.targets ?? [];
	if (!targets.some((r) => !ALWAYS_THERE.test(r[0]))) return { cls: NOTHING_CLASSES[0], gap: null };
	const { pointer, offScreen } = pointerAtNod(s, e);
	if (!pointer) return { cls: NOTHING_CLASSES[1], gap: null };
	const gap = nearestTarget(targets, pointer).gap;
	if (offScreen) return { cls: NOTHING_CLASSES[2], gap };
	if (gap <= hitbox.padPx) return { cls: NOTHING_CLASSES[3], gap };
	if (gap <= hitbox.padPx * 2) return { cls: NOTHING_CLASSES[4], gap };
	return { cls: NOTHING_CLASSES[5], gap };
}

function heading(text: string) {
	console.log(`\n${text}\n${'='.repeat(text.length)}`);
}
const note = (...lines: string[]) => console.log(lines.map((l) => `  ${l}`).join('\n'));

/** Distinct sessions a set of picks rests on. */
const sessionsIn = (picks: Pick[]) => new Set(picks.map((p) => p.s.name)).size;

/** How the picks are split: older layouts, the newest, and everything. */
function eras(picks: Pick[]) {
	return [
		['Older layouts', picks.filter((p) => !p.s.newest)],
		['Newest layout', picks.filter((p) => p.s.newest)]
	] as [string, Pick[]][];
}

function distanceRow(picks: Pick[]) {
	const known = picks.filter((p) => p.gap !== null && p.centre !== null);
	const s = known[0]?.s;
	if (!s) return { picks: picks.length, sessions: sessionsIn(picks) };
	const gaps = known.map((p) => p.gap!);
	const centres = known.map((p) => p.centre!);
	const inside = known.filter((p) => p.gap === 0).length;
	return {
		picks: picks.length,
		sessions: sessionsIn(picks),
		'on target': share(inside, known.length),
		'off edge p50 px': round(quantile(gaps, 0.5)),
		'p50 cm': round(px2cm(s, quantile(gaps, 0.5)), 1),
		'off edge p90 px': round(quantile(gaps, 0.9)),
		'p90 cm': round(px2cm(s, quantile(gaps, 0.9)), 1),
		'off centre p50 px': round(quantile(centres, 0.5)),
		'centre p50 cm': round(px2cm(s, quantile(centres, 0.5)), 1),
		'centre p50 deg': round(px2deg(s, quantile(centres, 0.5)), 1),
		'head off screen': known.filter((p) => p.offScreen).length
	};
}

function printDistances(picks: Pick[]) {
	heading('Pointer distance from the target at the nod');
	note(
		'"Off edge" is how far outside the target the pointer was, zero if on it. "Off centre" is to its middle.',
		`A target selects from ${hitbox.padPx}px outside its edge, so being off the edge isn't a miss. These are real picks only.`
	);
	for (const [name, part] of eras(picks)) {
		const table: Record<string, unknown> = {};
		for (const kind of KIND_ORDER) {
			const ofKind = part.filter((p) => p.kind === kind);
			if (ofKind.length) table[kind] = distanceRow(ofKind);
		}
		table['ALL PICKS'] = distanceRow(part);
		table['ALL, head on screen'] = distanceRow(part.filter((p) => !p.offScreen));
		console.log(`\n${name}: ${part.length} picks from ${sessionsIn(part)} sessions`);
		console.table(table);
	}
}

function printNothing(sessions: Session[]) {
	const nods = sessions.flatMap((s) =>
		s.events
			.filter((e) => e.e === 'confirm' && !e.chose)
			.map((e) => ({ s, e, ...classifyNothing(s, e), where: situation(s, e) }))
	);
	const allConfirms = sessions.flatMap((s) => s.events.filter((e) => e.e === 'confirm'));
	heading('Nods that landed on nothing');
	note(
		`${nods.length} of ${allConfirms.length} nods that reached the game, across ${new Set(nods.map((n) => n.s.name)).size} sessions.`,
		'Each nod is counted once, in the first class it fits, top to bottom. Only the last two are plausibly aiming, and even then',
		'only if the player meant to pick something. The logs cannot show that.'
	);
	for (const [name, part] of [
		['Older layouts', nods.filter((n) => !n.s.newest)],
		['Newest layout', nods.filter((n) => n.s.newest)]
	] as const) {
		const places = [...new Set(part.map((n) => n.where))].sort();
		const table: Record<string, Record<string, number | string>> = {};
		for (const cls of NOTHING_CLASSES) {
			const ofClass = part.filter((n) => n.cls === cls);
			if (!ofClass.length) continue;
			const row: Record<string, number | string> = { nods: ofClass.length };
			for (const place of places) row[place] = ofClass.filter((n) => n.where === place).length || '';
			table[cls] = row;
		}
		console.log(`\n${name}: ${part.length} nods on nothing, ${new Set(part.map((n) => n.s.name)).size} sessions`);
		if (Object.keys(table).length) console.table(table);
	}
}

function printWrongPicks(picks: Pick[]) {
	heading('Evidence of wrong picks (proxies: only the labelled sessions know what the player meant)');
	note(
		`"Undone": the very next input was a shake within ${UNDO_SHAKE_S}s that did something, or a back button within ${UNDO_BUTTON_S}s. A player also undoes on purpose.`,
		`"Shook, no effect": a shake within ${UNDO_SHAKE_S}s where there was nothing to undo. Could be regret, could be a false shake.`,
		`"Marked": Sam pressed the mistake key within ${MARK_LOOKBACK_S}s after. Marks are by hand and also cover gestures that did not count.`,
		'"Pointer on another": at the nod the pointer was nearer another legal target than the one picked.'
	);
	for (const [name, part] of eras(picks)) {
		const table: Record<string, unknown> = {};
		const row = (of: Pick[]) => ({
			picks: of.length,
			sessions: sessionsIn(of),
			undone: share(of.filter((p) => p.undone).length, of.length),
			'undone 95%': wilson(of.filter((p) => p.undone).length, of.length),
			'shook, no effect': share(of.filter((p) => p.shookNoEffect).length, of.length),
			marked: share(of.filter((p) => p.marked).length, of.length),
			'pointer on another': share(of.filter((p) => p.nearest && p.nearest !== p.id).length, of.length)
		});
		for (const kind of KIND_ORDER) {
			const of = part.filter((p) => p.kind === kind);
			if (of.length) table[kind] = row(of);
		}
		table['ALL PICKS'] = row(part);
		console.log(`\n${name}`);
		console.table(table);
	}
}

function printLabels(sessions: Session[], picks: Pick[], labels: Record<string, Row>) {
	heading('Labelled sessions: what the player wanted against what the game picked');
	const labelled = sessions.filter((s) => (labels[s.name]?.wanted ?? []).length);
	note(
		`${labelled.length} sessions have hand labels from the player's own account afterwards, ${labelled.filter((s) => s.newest).length} on the newest layout.`,
		'This is the only ground truth for intent in the logs. A label with no nod near it is a nod that never fired, not a wrong pick.'
	);
	const table: Record<string, unknown> = {};
	const scored = picks.filter((p) => p.label);
	for (const kind of KIND_ORDER) {
		const of = scored.filter((p) => kindOf(p.label!.wanted) === kind);
		if (of.length) table[kind] = { labelled: of.length, right: share(of.filter((p) => p.label!.ok).length, of.length), wrong: of.filter((p) => !p.label!.ok).length };
	}
	table['ALL LABELLED PICKS'] = {
		labelled: scored.length,
		right: share(scored.filter((p) => p.label!.ok).length, scored.length),
		wrong: scored.filter((p) => !p.label!.ok).length
	};
	console.table(table);
	const wantedTotal = labelled.reduce((n, s) => n + labels[s.name].wanted.length, 0);
	const unmatched = labelled.flatMap((s) => {
		const confirms = s.events.filter((e) => e.e === 'confirm');
		return (labels[s.name].wanted as [number, string][]).filter(
			([when]) => !confirms.some((c) => Math.abs((c.t - s.t0) / 1000 - when) <= LABEL_MATCH_S)
		);
	});
	const unwanted = labelled.flatMap((s) =>
		((labels[s.name].shouldNotFire ?? []) as number[]).flatMap((when) =>
			picks.filter((p) => p.s === s && Math.abs((p.e.t - s.t0) / 1000 - when) <= LABEL_MATCH_S)
		)
	);
	note(
		`${wantedTotal} labels, ${unmatched.length} with no nod logged within ${LABEL_MATCH_S}s.`,
		`Left out of that score: ${unwanted.length} picks from nods labelled as unwanted, which picked something anyway, and nods labelled optional.`,
		'These are a handful of runs through the same scripted demo, by people who knew it, so read this as a best case.'
	);
	const wrong = scored.filter((p) => !p.label!.ok);
	for (const p of wrong) {
		note(`${p.s.name} at ${((p.e.t - p.s.t0) / 1000).toFixed(1)}s: wanted ${p.label!.wanted}, picked ${p.id}`);
	}
}

function printMarks(sessions: Session[], picks: Pick[]) {
	const marks = sessions.flatMap((s) => s.events.filter((e) => e.e === 'mistake').map((e) => ({ s, e })));
	heading('Mistake marks');
	if (!marks.length) {
		note('None in these sessions.');
		return;
	}
	const table = marks.map(({ s, e }) => {
		const before = picks.filter((p) => p.s === s && p.e.t <= e.t).at(-1);
		const ago = before ? (e.t - before.e.t) / 1000 : null;
		return {
			session: s.name.replace('.jsonl', ''),
			at: round((e.t - s.t0) / 1000, 1),
			stage: e.stage ?? '-',
			'selected then': e.selected ?? 'nothing',
			'last pick': before?.id ?? '-',
			'pick was s ago': ago === null ? '-' : round(ago, 1)
		};
	});
	console.table(table);
	note(`${marks.length} marks in ${new Set(marks.map((m) => m.s.name)).size} sessions. They are not all wrong picks: labels say some follow a nod that did not count.`);
}

function printRejected(sessions: Session[]) {
	heading('Nods and shakes the detector turned down, de-duplicated');
	note(
		`Older logs repeat one movement on many frames, so their rows under ${REJECTED_SAME_MS}ms apart count once.`,
		'Detector settings changed between builds, so older and newest are not the same test.'
	);
	const rows = (part: Session[]) => {
		let raw = 0;
		const movements: { s: Session; e: Row }[] = [];
		let ruleRefusals = 0;
		for (const s of part) {
			const last: Record<string, number> = {};
			for (const e of s.events) {
				// Newer logs report each head bump once, under its own name.
				if (e.e === 'bump-turned-down') {
					raw++;
					movements.push({ s, e });
					continue;
				}
				if (e.e !== 'rejected') continue;
				// The games use this name for a refused move. Older logs also used it for head bumps.
				if (e.kind === undefined) {
					ruleRefusals++;
					continue;
				}
				raw++;
				if (last[e.kind] === undefined || e.t - last[e.kind] >= REJECTED_SAME_MS) movements.push({ s, e });
				last[e.kind] = e.t;
			}
		}
		const nods = movements.filter((m) => m.e.kind === 'nod');
		const shakes = movements.filter((m) => m.e.kind === 'shake');
		const onTarget = nods.filter((m) => lastEvent(m.s, 'focus', m.e.t)?.id);
		const retried = onTarget.filter((m) =>
			m.s.events.some((x) => x.e === 'gesture' && x.kind === 'nod' && x.t > m.e.t && x.t - m.e.t <= RETRY_S * 1000)
		);
		const counted = part.flatMap((s) => s.events.filter((e) => e.e === 'gesture' && e.kind === 'nod')).length;
		return {
			sessions: part.length,
			'logged rows': raw,
			'nods turned down': nods.length,
			'nods counted': counted,
			'with a target selected': onTarget.length,
			[`of those, nod counted within ${RETRY_S}s`]: share(retried.length, onTarget.length),
			'shakes turned down': shakes.length,
			'moves the rules refused': ruleRefusals
		};
	};
	console.table({
		'Older layouts': rows(sessions.filter((s) => !s.newest)),
		'Newest layout': rows(sessions.filter((s) => s.newest))
	});
}

function printTiming(picks: Pick[]) {
	heading('Time from reaching a target to nodding');
	note(
		'"Highlight to nod" runs from the target lighting up to the nod beginning, for picks where it was lit as the nod began.',
		'It includes deciding, so it is not pointing speed. "Still to nod" is from when the head last moved faster than 15 deg/s.'
	);
	for (const [name, part] of eras(picks)) {
		const table: Record<string, unknown> = {};
		const row = (of: Pick[]) => {
			const reach = of.flatMap((p) => (p.reachMs === null ? [] : [p.reachMs]));
			const still = of.flatMap((p) => (p.settledMs === null ? [] : [p.settledMs]));
			return {
				picks: of.length,
				timed: reach.length,
				'highlight to nod p10 ms': round(quantile(reach, 0.1)),
				p50: round(quantile(reach, 0.5)),
				p90: round(quantile(reach, 0.9)),
				'still to nod p50 ms': round(quantile(still, 0.5)),
				'lit elsewhere as nod began': of.length - reach.length
			};
		};
		for (const kind of KIND_ORDER) {
			const of = part.filter((p) => p.kind === kind);
			if (of.length) table[kind] = row(of);
		}
		table['ALL PICKS'] = row(part);
		console.log(`\n${name}`);
		console.table(table);
	}
}

/** Everything that bears on how far apart the rack's tiles should be. */
function printRack(picks: Pick[]) {
	const rack = picks.filter((p) => p.kind === 'Scrabble rack');
	heading('Scrabble rack: spacing');
	if (!rack.length) {
		note('No rack picks here.');
		return;
	}
	/** The distance from this tile to the next legal tile each way, or null if none is in range. */
	const neighbours = (p: Pick) => {
		const tiles = (p.e.targets as Rect[]).filter((r) => r[0].startsWith('rack-'));
		const c = centreOf(p.rect!);
		const each = tiles.filter((r) => r[0] !== p.id).map((r) => centreOf(r).x - c.x);
		const right = each.filter((d) => d > 0);
		const left = each.filter((d) => d < 0).map((d) => -d);
		return {
			left: left.length ? Math.min(...left) : null,
			right: right.length ? Math.min(...right) : null
		};
	};
	const usable = rack.filter((p) => p.rect && p.dx !== null);
	const table: Record<string, unknown> = {};
	// By the spacing each pick was really played at. Used tiles leave gaps, so a pick's spacing is
	// its nearest neighbour, and a pick with no neighbour joins its session's spacing.
	const sessionPitch = new Map<unknown, number>();
	for (const p of usable) {
		const n = neighbours(p);
		const near = Math.min(n.left ?? Infinity, n.right ?? Infinity);
		if (near < Infinity) sessionPitch.set(p.s, Math.min(sessionPitch.get(p.s) ?? Infinity, near));
	}
	const bySpacing = new Map<number, Pick[]>();
	for (const p of usable) {
		const pitch = sessionPitch.get(p.s);
		if (pitch === undefined) continue;
		const key = Math.round(pitch / 10) * 10;
		bySpacing.set(key, [...(bySpacing.get(key) ?? []), p]);
	}
	for (const key of [...bySpacing.keys()].sort((x, y) => x - y)) {
		const of = bySpacing.get(key)!;
		// A selected tile grows, so the smallest width seen is its real size.
		const name = `About ${key}px apart, ${Math.round(quantile(of.map((p) => p.rect![3]), 0.1))}px tiles`;
		const pitch = quantile(of.map((p) => sessionPitch.get(p.s)!), 0.5);
		const dxs = of.map((p) => Math.abs(p.dx!));
		const dys = of.map((p) => Math.abs(p.dy!));
		const changed = of.filter((p) => p.tileChanged).length;
		const s = of[0].s;
		table[name] = {
			picks: of.length,
			sessions: sessionsIn(of),
			'centre to centre px': round(pitch),
			'as head turn deg': round(px2deg(s, pitch), 1),
			'first to last tile deg': round(px2deg(s, pitch * 6), 1),
			'across p50 px': round(quantile(dxs, 0.5)),
			'across p75': round(quantile(dxs, 0.75)),
			'across p90': round(quantile(dxs, 0.9)),
			'up/down p50 px': round(quantile(dys, 0.5)),
			undone: share(of.filter((p) => p.undone).length, of.length),
			'tile changed': share(changed, of.length),
			'changed 95%': wilson(changed, of.length),
			'labelled wrong': `${of.filter((p) => p.label && !p.label.ok).length} of ${of.filter((p) => p.label).length} labelled`
		};
	}
	console.table(table);
	note('"Across" is how far left or right of the picked tile\'s centre the pointer was at the nod.');

	const rows = usable.map((p) => ({ p, ...neighbours(p), dx: p.dx! }));
	const towardNeighbour = rows.flatMap((r) => {
		const side = r.dx > 0 ? r.right : r.left;
		return side !== null && side < 300 ? [{ ...r, side }] : [];
	});
	const towardNothing = rows.filter((r) => {
		const side = r.dx > 0 ? r.right : r.left;
		return side === null || side >= 300;
	});
	const free = towardNothing.map((r) => Math.abs(r.dx));
	const tight = towardNeighbour.map((r) => Math.abs(r.dx));
	console.table({
		'Toward a tile under 300px away': {
			picks: tight.length,
			p50: round(quantile(tight, 0.5)),
			p75: round(quantile(tight, 0.75)),
			p90: round(quantile(tight, 0.9)),
			p95: round(quantile(tight, 0.95))
		},
		'Toward nothing (rack end, or a gap left by a used tile)': {
			picks: free.length,
			p50: round(quantile(free, 0.5)),
			p75: round(quantile(free, 0.75)),
			p90: round(quantile(free, 0.9)),
			p95: round(quantile(free, 0.95))
		}
	});
	note(
		'The first row is cut off by the neighbouring tile taking over, so it reads low. The second has no neighbour to stop it, and the',
		'player has no reason to be careful there, so it reads high. The real need sits between the two.'
	);

	console.table(
		Object.fromEntries(
			[128, 144, 151, 160, 176, 191].map((pitch) => [
				`${pitch}px apart (${round(px2deg(rack[0].s, pitch), 1)} deg)`,
				{
					'half that px': pitch / 2,
					'picks toward nothing inside it': share(free.filter((d) => d <= pitch / 2).length, free.length),
					'95%': wilson(free.filter((d) => d <= pitch / 2).length, free.length)
				}
			])
		)
	);
	note(
		'Of picks whose pointer sat toward no neighbour, the share close enough to the tile that a neighbour at that spacing would not',
		'have taken over, if the player aimed the same. They would not: they stop when the right tile lights. So this is a rough guide.'
	);

	console.log('\nTile lit for how long as the nod began, all layouts ("tile changed" is explained below):');
	const bands: [string, (ms: number | null) => boolean][] = [
		[`Not lit, or under ${IN_TRANSIT_MS}ms: head still travelling`, (ms) => ms === null || ms < IN_TRANSIT_MS],
		[`${IN_TRANSIT_MS}-400ms`, (ms) => ms !== null && ms >= IN_TRANSIT_MS && ms < 400],
		['400ms or more', (ms) => ms !== null && ms >= 400]
	];
	console.table(
		Object.fromEntries(
			bands.map(([name, test]) => {
				const of = rack.filter((p) => test(p.reachMs));
				const changed = of.filter((p) => p.tileChanged).length;
				return [name, { picks: of.length, 'tile changed': share(changed, of.length), '95%': wilson(changed, of.length) }];
			})
		)
	);

	const changes = rack.filter((p) => p.tileChanged);
	console.log(
		`\nTile changed: picked up, never placed, and a different tile picked within ${TILE_CHANGED_S}s (a proxy: it can also be a change of mind):`
	);
	console.table(
		changes.map((p) => ({
			session: p.s.name.replace('.jsonl', ''),
			layout: p.s.newest ? 'newest' : 'older',
			at: round((p.e.t - p.s.t0) / 1000, 1),
			picked: p.id,
			then: p.tileChanged!.id,
			'seconds later': round(p.tileChanged!.afterS, 1),
			neighbour: p.tileChanged!.adjacent ? 'yes' : 'no',
			'pointer across px': p.dx === null ? '-' : round(p.dx),
			'lit for ms': p.reachMs === null ? '-' : round(p.reachMs)
		}))
	);
	const newest = rack.filter((p) => p.s.newest);
	if (newest.length) {
		console.log('\nEvery rack pick on the newest layout:');
		console.table(
			newest.map((p) => ({
				session: p.s.name.replace('.jsonl', ''),
				at: round((p.e.t - p.s.t0) / 1000, 1),
				picked: p.id,
				'across px': p.dx === null ? '-' : round(p.dx),
				'up/down px': p.dy === null ? '-' : round(p.dy),
				'lit for ms': p.reachMs === null ? '-' : round(p.reachMs),
				'tile changed to': p.tileChanged?.id ?? '-'
			}))
		);
	}
}

/**
 * Losing the face and finding it again takes the centre of the screen from wherever the head is at
 * that moment. If that isn't where the player normally rests, the whole pointer is shifted until the
 * next time, so it's worth seeing beside the nods that landed on nothing.
 */
function printStretches(sessions: Session[]) {
	const newest = sessions.filter((s) => s.newest);
	if (!newest.length) return;
	heading('Newest layout: each unbroken stretch of tracking, and the centre it took');
	note(
		'Yaw and pitch are the head angles that the pointer treats as the middle of the screen, worked back from the logged head point.',
		'They should stay about the same for one player in one seat. A big jump means the head was not at rest when the centre was taken.'
	);
	const table: Record<string, unknown>[] = [];
	for (const s of newest) {
		const restY = s.H * HEAD_REST_Y;
		let from = 0;
		for (let i = 1; i <= s.frames.length; i++) {
			if (i < s.frames.length && s.frames[i].t - s.frames[i - 1].t < 2000) continue;
			const part = s.frames.slice(from, i);
			const a = part[0].t;
			const b = part.at(-1)!.t;
			from = i;
			const moved = part.filter((f) => f.a != null && f.b != null);
			if (b - a < 3000 || moved.length < 10) continue;
			// The first moments are before the centre is taken, when the point sits still in the middle.
			const settled = moved.filter((f) => f.t - a > 1000);
			const yaw = settled.map((f) => f.y - ((f.a - s.W / 2) / (-s.W / 2)) * (SCREEN_DEG / 2));
			const pitch = settled.map((f) => {
				const fromRest = f.b <= restY ? ((restY - f.b) / restY) * HEAD_RANGE_UP : -((f.b - restY) / (s.H - restY)) * HEAD_RANGE_DOWN;
				return f.p - fromRest;
			});
			const confirms = s.events.filter((e) => e.e === 'confirm' && e.t >= a && e.t <= b);
			const off = confirms.filter((e) => e.x != null && (e.x < 0 || e.x > s.W || e.y < 0 || e.y > s.H));
			table.push({
				session: s.name.replace('.jsonl', ''),
				'from s': round((a - s.t0) / 1000),
				'long s': round((b - a) / 1000),
				'centre yaw': round(quantile(yaw, 0.5), 1),
				'centre pitch': round(quantile(pitch, 0.5), 1),
				picks: confirms.filter((e) => e.chose).length,
				'on nothing': confirms.filter((e) => !e.chose).length,
				'head off screen at nod': off.length
			});
		}
	}
	console.table(table);
}

function printSessions(sessions: Session[], picks: Pick[]) {
	heading('Sessions');
	note(
		'"Events dropped": logged while a hot reload left two trackers running, so they are not one player\'s play and are not counted anywhere.',
		'Sessions with no tracked frames are skipped.'
	);
	const table = sessions.map((s) => {
		const mine = picks.filter((p) => p.s === s);
		const confirms = s.events.filter((e) => e.e === 'confirm');
		const racks = mine.filter((p) => p.kind === 'Scrabble rack' && p.rect);
		const stops = s.events.filter((e) => e.e === 'away').length;
		return {
			session: s.name.replace('.jsonl', ''),
			layout: s.newest ? 'newest' : 'older',
			viewport: `${s.W}x${s.H}`,
			'tracked s': round(s.activeS),
			'lost or away s': round(Math.max(0, (s.frames.at(-1)!.t - s.t0) / 1000 - s.activeS)),
			'went away': stops,
			picks: mine.length,
			'on nothing': confirms.length - mine.length,
			'rack picks': racks.length,
			labelled: mine.filter((p) => p.label).length,
			'events dropped': s.doubled
		};
	});
	console.table(table);
}

const arg = process.argv[2];
const paths = arg
	? [arg]
	: readdirSync(DIR)
			.filter((f) => f.endsWith('.jsonl'))
			.sort()
			.map((f) => join(DIR, f));
const sessions = loadSessions(paths);
if (!sessions.length) {
	console.log('No sessions with tracked frames.');
	process.exit(0);
}
const labels = loadLabels();
const picks = sessions.flatMap((s) =>
	s.events.filter((e) => e.e === 'confirm' && e.chose).map((e) => readPick(s, e, labels))
);

printSessions(sessions, picks);
printDistances(picks);
printNothing(sessions);
printWrongPicks(picks);
printLabels(sessions, picks, labels);
printMarks(sessions, picks);
printRejected(sessions);
printTiming(picks);
printStretches(sessions);
printRack(picks);

heading("What these numbers can't show");
note(
	'Intent: outside the labelled sessions nothing records what the player wanted, so "wrong" is a proxy everywhere else.',
	'Players: the logs have no player id. Some sessions are other people, and nothing here separates them.',
	'Attention: a nod while talking or looking away looks like any other. Tracked time is not play time.',
	'Physical size: cm assumes the viewport is 30.4 cm wide. The logs report a 1680px screen against a 1512px viewport, so cm could read',
	'up to 10% high. Degrees come from how the head maps to the viewport (24 deg across), so they do not depend on this.',
	'Build: tile layout, reach, smoothing and nod thresholds all changed during the day. "Older" is many builds, not one.',
	'Practice: the newest sessions come after a day of play, and most games are the same scripted demo, so layout and practice are tangled.',
	'Angles: degrees are what the face tracker reports and how the code maps them, not measured with anything else.'
);
