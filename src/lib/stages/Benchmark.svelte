<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { target, targets } from '../input/targets.svelte';
	import { session } from '../session';
	import { setup } from '../vision/engine.svelte';

	let { onClose }: { onClose: () => void } = $props();

	type Rect = { id: string; x: number; y: number; w: number; h: number };
	type Trial = { kind: 'pick' | 'shake' | 'follow'; layout: Layout; want: string | null; variant: string };
	type Layout = 'rack' | 'cards' | 'grid' | 'none';

	const TRIAL_TIMEOUT_MS = 6000;
	const SHAKE_TIMEOUT_MS = 5000;
	const FOLLOW_DOTS = 4;
	const DOT_MS = 1500;
	const REST_MS = 500;
	/**
	 * Each setting runs twice, in the order A B B A, so getting better with practice evens out.
	 * Normal is whatever the settings were when the run began.
	 */
	const VARIANTS = [
		{ name: 'normal', yaw: setup.headRangeYawDeg, up: setup.headRangePitchDeg, down: setup.headRangeDownDeg },
		{ name: 'steadier', yaw: 16, up: 15, down: 7 }
	];
	const BLOCK_ORDER = [0, 1, 1, 0];
	const PER_BLOCK: [Trial['kind'], Layout, number][] = [
		['pick', 'rack', 4],
		['pick', 'cards', 3],
		['pick', 'grid', 4],
		['shake', 'none', 2],
		['follow', 'none', 1]
	];

	function layoutOf(layout: Layout): Rect[] {
		const W = innerWidth;
		const H = innerHeight;
		if (layout === 'rack') {
			const [size, gap] = [104, 24];
			const left = (W - (7 * size + 6 * gap)) / 2;
			return Array.from({ length: 7 }, (_, i) => ({ id: `t-${i}`, x: left + i * (size + gap), y: H * 0.1, w: size, h: size }));
		}
		if (layout === 'cards') {
			const [w, h, gap] = [112, 168, 18];
			const left = (W - (7 * w + 6 * gap)) / 2;
			return Array.from({ length: 7 }, (_, i) => ({ id: `c-${i}`, x: left + i * (w + gap), y: H * 0.54, w, h }));
		}
		if (layout === 'grid') {
			const size = 110;
			const [left, top] = [(W - 5 * size) / 2 - 100, H - 5 * size - 16];
			return Array.from({ length: 25 }, (_, i) => ({
				id: `g-${i}`,
				x: left + (i % 5) * size,
				y: top + Math.floor(i / 5) * size,
				w: size,
				h: size
			}));
		}
		return [];
	}

	function shuffled<T>(items: T[]) {
		const out = [...items];
		for (let i = out.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[out[i], out[j]] = [out[j], out[i]];
		}
		return out;
	}

	function buildTrials() {
		let last = '';
		return BLOCK_ORDER.flatMap((v) => {
			const block = PER_BLOCK.flatMap(([kind, layout, count]) =>
				Array.from({ length: count }, () => ({ kind, layout, variant: VARIANTS[v].name }))
			);
			return shuffled(block).map((t): Trial => {
				if (t.kind !== 'pick') return { ...t, want: null };
				const choices = layoutOf(t.layout).filter((r) => r.id !== last);
				last = choices[Math.floor(Math.random() * choices.length)].id;
				return { ...t, want: last };
			});
		});
	}

	const trials = buildTrials();
	let index = $state(-1);
	let rects = $state<Rect[]>([]);
	let active = $state(false);
	let dot = $state<{ x: number; y: number } | null>(null);
	let feedback = $state<'hit' | 'wrong' | 'miss' | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dotTimer: ReturnType<typeof setInterval> | undefined;
	let startedAt = 0;
	let hits = $state(0);

	const trial = $derived(index >= 0 && index < trials.length ? trials[index] : null);
	const finished = $derived(index >= trials.length);

	/** The settings this run last put in place. */
	let applied: (typeof VARIANTS)[number] | null = null;

	function useVariant(name: string) {
		const v = VARIANTS.find((x) => x.name === name)!;
		setup.headRangeYawDeg = v.yaw;
		setup.headRangePitchDeg = v.up;
		setup.headRangeDownDeg = v.down;
		applied = v;
	}

	/** Puts the settings back, unless something else, like the HUD, changed them since. */
	function restore() {
		const v = applied;
		if (v && setup.headRangeYawDeg === v.yaw && setup.headRangePitchDeg === v.up && setup.headRangeDownDeg === v.down) {
			useVariant('normal');
		}
		applied = null;
	}

	function begin(n: number) {
		index = n;
		feedback = null;
		if (n >= trials.length) {
			session.event('benchmarkEnd', {});
			useVariant('normal');
			return;
		}
		const t = trials[n];
		useVariant(t.variant);
		rects = layoutOf(t.layout);
		active = true;
		startedAt = performance.now();
		session.event('trial', {
			n,
			kind: t.kind,
			layout: t.layout,
			want: t.want,
			variant: t.variant,
			rects: rects.map((r) => [r.id, Math.round(r.x), Math.round(r.y), r.w, r.h])
		});
		if (t.kind === 'follow') {
			let shown = 0;
			const jump = () => {
				shown += 1;
				if (shown > FOLLOW_DOTS) return finish('hit', null);
				const side = shown % 2 === 0;
				dot = { x: (side ? 0.12 : 0.88) * innerWidth, y: (shown % 4 < 2 ? 0.2 : 0.75) * innerHeight };
			};
			jump();
			dotTimer = setInterval(jump, DOT_MS);
		} else {
			timer = setTimeout(() => finish('miss', null), t.kind === 'shake' ? SHAKE_TIMEOUT_MS : TRIAL_TIMEOUT_MS);
		}
	}

	function finish(result: 'hit' | 'wrong' | 'miss', chose: string | null) {
		if (!active) return;
		active = false;
		clearTimeout(timer);
		clearInterval(dotTimer);
		dot = null;
		session.event('trialEnd', { n: index, result, chose, ms: Math.round(performance.now() - startedAt) });
		if (result === 'hit') hits += 1;
		feedback = result;
		rects = [];
		timer = setTimeout(() => begin(index + 1), REST_MS);
	}

	const releaseCancel = targets.claimCancel(() => {
		if (finished) onClose();
		else if (trial?.kind === 'shake') finish('hit', null);
	});

	function leave() {
		session.event('benchmarkLeft', { n: index });
		onClose();
	}

	onMount(() => {
		session.event('benchmarkStart', { trials: trials.length });
		timer = setTimeout(() => begin(0), 1200);
	});

	onDestroy(() => {
		clearTimeout(timer);
		clearInterval(dotTimer);
		releaseCancel();
		restore();
	});

	const prompt = $derived(
		finished
			? 'Done. Thank you!'
			: !trial
				? 'Get ready'
				: trial.kind === 'pick'
					? 'Point at the glowing one and nod'
					: trial.kind === 'shake'
						? 'Shake your head, the way you would to undo something'
						: 'Follow the dot with your head. No nodding, no shaking'
	);
</script>

<div class="fixed inset-0 z-40 bg-slate-950 text-white">
	<p class="absolute inset-x-0 top-1 text-center text-2xl font-semibold">
		{prompt}
		{#if !finished}<span class="ml-3 text-base text-slate-400">{Math.max(index + 1, 0)} of {trials.length}</span>{/if}
	</p>

	{#if finished}
		<div class="absolute inset-0 flex flex-col items-center justify-center gap-6">
			<p class="text-5xl font-bold text-emerald-300">{hits} of {trials.length} went as asked</p>
			<p class="text-2xl text-slate-300">Saved. Tell Claude it is done.</p>
			<button
				use:target={{ id: 'bench-close', legal: true, confirm: onClose }}
				class="close"
				class:focused={targets.focused === 'bench-close'}
			>
				Close
			</button>
		</div>
	{:else}
		<button
			use:target={{ id: 'bench-leave', legal: true, confirm: leave }}
			class="leave"
			class:focused={targets.focused === 'bench-leave'}
		>
			✕<span>Leave</span>
		</button>
	{/if}

	{#each rects as r (r.id)}
		<button
			use:target={{
				id: r.id,
				// Each layout's pieces form one row, so a drifting nod can still land on its neighbour.
				group: r.id.split('-')[0],
				legal: active && trial?.kind === 'pick',
				exact: trial?.layout === 'grid',
				confirm: () => finish(r.id === trial?.want ? 'hit' : 'wrong', r.id)
			}}
			class="piece"
			class:want={r.id === trial?.want}
			class:focused={targets.focused === r.id}
			style:left="{r.x}px"
			style:top="{r.y}px"
			style:width="{r.w}px"
			style:height="{r.h}px"
			aria-label={r.id === trial?.want ? 'Target' : 'Other'}
		></button>
	{/each}

	{#if dot}
		<div class="dot" style:left="{dot.x}px" style:top="{dot.y}px"></div>
	{/if}

	{#if feedback}
		<div class="flash" class:good={feedback === 'hit'}>
			{feedback === 'hit' ? 'Yes' : feedback === 'wrong' ? 'Wrong one' : 'Missed'}
		</div>
	{/if}
</div>

<style>
	.close {
		height: 6rem;
		width: 22rem;
		border-radius: 1rem;
		border: 4px solid #94a3b8;
		background: #334155;
		font-size: 2rem;
		font-weight: 800;
	}
	.leave {
		position: absolute;
		right: 2rem;
		top: 1.5rem;
		display: flex;
		height: 6rem;
		width: 7rem;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		border-radius: 1rem;
		border: 4px solid #94a3b8;
		background: #334155;
		font-size: 2rem;
		font-weight: 800;
		line-height: 1;
	}
	.leave span {
		margin-top: 0.3rem;
		font-size: 1rem;
	}
	.piece {
		position: absolute;
		border-radius: 0.5rem;
		border: 2px solid #475569;
		background: #1e293b;
	}
	.want {
		background: #f59e0b;
		border-color: #fde68a;
		box-shadow: 0 0 30px 6px rgb(251 191 36 / 0.6);
	}
	.focused {
		outline: 5px solid white;
		z-index: 1;
	}
	.dot {
		position: absolute;
		height: 3.5rem;
		width: 3.5rem;
		translate: -50% -50%;
		border-radius: 50%;
		background: #ef4444;
	}
	.flash {
		position: absolute;
		left: 50%;
		top: 3rem;
		translate: -50% 0;
		border-radius: 0.5rem;
		background: #b91c1c;
		padding: 0.25rem 1.25rem;
		font-size: 1.5rem;
		font-weight: 700;
	}
	.flash.good {
		background: #047857;
	}
</style>
