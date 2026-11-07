<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { targets } from '../input/targets.svelte';
	import { engine, SOURCES, type SourceId } from '../vision/engine.svelte';
	import { median, type Point } from '../vision/math';
	import { testLog } from './testlog.svelte';

	let { train, onClose }: { train: boolean; onClose: () => void } = $props();

	const SETTLE_MS = 900;
	const READ_MS = 700;
	const xs = [0.08, 0.5, 0.92];
	const ys = [0.1, 0.5, 0.9];
	const dots = ys.flatMap((y) => xs.map((x) => ({ x, y })));

	let index = $state(0);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const readings: Record<SourceId, { target: Point; p: Point }[]> = {
		free: [],
		calibrated: [],
		head: []
	};

	function next() {
		timer = setTimeout(() => {
			timer = setTimeout(() => {
				read();
				index += 1;
				if (index >= dots.length) finish();
				else next();
			}, READ_MS);
		}, SETTLE_MS);
	}

	function read() {
		const dot = dots[index];
		const target = { x: dot.x * innerWidth, y: dot.y * innerHeight };
		for (const s of SOURCES) {
			const p = engine.sourcePointNow(s, READ_MS);
			if (p) readings[s].push({ target, p });
		}
		if (train) engine.addSample(target, performance.now());
	}

	function finish() {
		const k = engine.pxPerCm();
		const errorCm = {} as Record<SourceId, number | null>;
		const biasCm = {} as Record<SourceId, { x: number; y: number } | null>;
		for (const s of SOURCES) {
			const r = readings[s];
			if (r.length === 0) {
				errorCm[s] = null;
				biasCm[s] = null;
				continue;
			}
			errorCm[s] = median(r.map((o) => Math.hypot(o.p.x - o.target.x, o.p.y - o.target.y) / k));
			biasCm[s] = {
				x: median(r.map((o) => (o.p.x - o.target.x) / k)),
				y: median(r.map((o) => (o.p.y - o.target.y) / k))
			};
		}
		testLog.add({
			at: new Date().toISOString(),
			label: testLog.label,
			trained: train,
			distanceCm: Math.round(engine.distanceCm),
			yaw: Math.round(engine.yaw),
			pitch: Math.round(engine.pitch),
			faces: engine.faceCount,
			resolution: engine.resolution,
			fps: engine.fps,
			errorCm,
			biasCm
		});
		onClose();
	}

	onMount(() => {
		targets.enabled = false;
		next();
	});

	onDestroy(() => {
		targets.enabled = true;
		clearTimeout(timer);
	});
</script>

<div class="fixed inset-0 z-40 bg-slate-950">
	<p class="absolute top-[38%] w-full text-center text-3xl text-slate-300">
		{train ? 'Calibration pass' : 'Accuracy test'}: look at the red dot and point your head at it
		({Math.min(index + 1, dots.length)}/{dots.length})
	</p>
	{#if index < dots.length}
		<div
			class="absolute h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500 ring-8 ring-red-500/30"
			style:left="{dots[index].x * 100}%"
			style:top="{dots[index].y * 100}%"
		></div>
	{/if}
</div>
