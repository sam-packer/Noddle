<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { targets } from '../input/targets.svelte';
	import { engine, setup, type DataFrame } from '../vision/engine.svelte';
	import { scoreRun, type EyeFrame, type HeadGains, type TracePoint } from '../vision/eyeSignal';
	import { deleteRun, loadRuns, putRun, saveRunToDisk, type EyeRun } from './eyeRuns';
	import ToolLeave, { toolInput } from './ToolLeave.svelte';

	let { onClose, measuring = $bindable(false) }: { onClose: () => void; measuring?: boolean } = $props();

	type ShownRun = EyeRun & { url: string };
	type Phase = 'ready' | 'settle' | 'capture' | 'results';

	/** The head is still finishing the nod that started the run. */
	const SETTLE_MS = 1500;
	const CAPTURE_MS = 10000;
	const CLIP_W = 1280;
	const CLIP_H = 427;
	/** Below this the camera has too few pixels on the iris to see small movement. */
	const CLOSE_ENOUGH_IRIS_PX = 28;
	/** Keeps the clip steady on the face without following fast movement, so the eyes' own movement stays. */
	const STEADY = 0.08;
	const TRACE_W = 600;
	const TRACE_H = 160;

	let phase = $state<Phase>('ready');
	let runs = $state.raw<ShownRun[]>([]);
	let leftId = $state<string | null>(null);
	let rightId = $state<string | null>(null);
	let notice = $state('');
	let tooFar = $state(false);
	let playhead = $state(0);
	let canvas = $state<HTMLCanvasElement>();
	let videos = $state<(HTMLVideoElement | undefined)[]>([]);

	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let recorder: MediaRecorder | null = null;
	let frames: EyeFrame[] = [];
	let irisSizes: number[] = [];
	let captureStart = 0;
	let steady: { cx: number; cy: number; len: number; angle: number } | null = null;

	const shown = $derived(
		[leftId, rightId]
			.filter((id, i, all) => id && all.indexOf(id) === i)
			.map((id) => runs.find((r) => r.id === id))
			.filter((r): r is ShownRun => !!r)
	);
	/** One scale for every line on screen, so a flat line and a scribble can be compared honestly. */
	const traceScale = $derived(
		Math.max(0.5, ...shown.flatMap((r) => r.score.trace.flatMap((p) => [Math.abs(p.eye), Math.abs(p.head)])))
	);

	$effect(() => {
		measuring = phase === 'settle' || phase === 'capture';
	});

	function headGains(): HeadGains {
		const heightCm = setup.screenWidthCm * (innerHeight / innerWidth);
		return {
			x: setup.screenWidthCm / 2 / setup.headRangeYawDeg,
			up: (setup.headRestY * heightCm) / setup.headRangePitchDeg,
			down: ((1 - setup.headRestY) * heightCm) / setup.headRangeDownDeg
		};
	}

	function drawEyes(f: DataFrame) {
		const ctx = canvas?.getContext('2d');
		if (!ctx || !canvas) return;
		const ax = f.lm[33].x * f.W;
		const ay = f.lm[33].y * f.H;
		const bx = f.lm[263].x * f.W;
		const by = f.lm[263].y * f.H;
		const now = {
			cx: (ax + bx) / 2,
			cy: (ay + by) / 2,
			len: Math.hypot(bx - ax, by - ay),
			angle: Math.atan2(by - ay, bx - ax)
		};
		if (!steady) steady = now;
		else {
			steady.cx += (now.cx - steady.cx) * STEADY;
			steady.cy += (now.cy - steady.cy) * STEADY;
			steady.len += (now.len - steady.len) * STEADY;
			steady.angle += (now.angle - steady.angle) * STEADY;
		}
		const scale = canvas.width / (steady.len * 1.3);
		ctx.save();
		ctx.imageSmoothingQuality = 'high';
		ctx.translate(canvas.width / 2, canvas.height / 2);
		ctx.scale(-scale, scale);
		ctx.rotate(-steady.angle);
		ctx.translate(-steady.cx, -steady.cy);
		ctx.drawImage(f.video, 0, 0);
		ctx.restore();
	}

	function onFrame(f: DataFrame) {
		if (phase === 'results') return;
		drawEyes(f);
		const irisSize =
			(Math.hypot((f.lm[469].x - f.lm[471].x) * f.W, (f.lm[469].y - f.lm[471].y) * f.H) +
				Math.hypot((f.lm[474].x - f.lm[476].x) * f.W, (f.lm[474].y - f.lm[476].y) * f.H)) /
			2;
		if (phase === 'ready') tooFar = irisSize < CLOSE_ENOUGH_IRIS_PX;
		if (phase !== 'capture') return;
		irisSizes.push(irisSize);
		frames.push({
			t: Math.round((f.ts - captureStart) * 10) / 10,
			ex: f.iris.x,
			ey: f.iris.y,
			yaw: f.yaw,
			pitch: f.pitch,
			open: f.iris.open,
			dist: f.distance
		});
	}

	function startRun() {
		notice = '';
		phase = 'settle';
		timer = setTimeout(beginCapture, SETTLE_MS);
	}

	function beginCapture() {
		frames = [];
		irisSizes = [];
		const type = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) =>
			MediaRecorder.isTypeSupported(t)
		);
		recorder = new MediaRecorder(canvas!.captureStream(30), {
			mimeType: type,
			videoBitsPerSecond: 6_000_000
		});
		recorder.start();
		captureStart = performance.now();
		phase = 'capture';
		timer = setTimeout(endCapture, CAPTURE_MS);
	}

	function stopRecorder() {
		return new Promise<Blob>((resolve) => {
			const r = recorder!;
			const chunks: Blob[] = [];
			r.ondataavailable = (e) => chunks.push(e.data);
			r.onstop = () => {
				r.stream.getTracks().forEach((t) => t.stop());
				resolve(new Blob(chunks, { type: r.mimeType }));
			};
			r.stop();
			recorder = null;
		});
	}

	async function endCapture() {
		const clip = await stopRecorder();
		if (closed) return;
		const score = scoreRun(frames, headGains());
		const expected = (CAPTURE_MS / 1000) * 15;
		if (frames.length < expected || score.usable < 0.6) {
			notice = "Couldn't see your eyes clearly enough. Nod to try again.";
			phase = 'ready';
			return;
		}
		const number = Math.max(0, ...runs.map((r) => Number(/\d+$/.exec(r.label)?.[0] ?? 0))) + 1;
		const sorted = [...irisSizes].sort((a, b) => a - b);
		const run: EyeRun = {
			id: String(Date.now()),
			label: `Person ${number}`,
			at: new Date().toISOString(),
			irisPx: Math.round(sorted[sorted.length >> 1] * 10) / 10,
			resolution: engine.resolution,
			fps: engine.fps,
			score,
			frames,
			clip
		};
		runs = [...runs, { ...run, url: URL.createObjectURL(clip) }];
		if (!leftId) leftId = run.id;
		else rightId = run.id;
		phase = 'results';
		saveRunToDisk(run, true);
		await putRun(run);
	}

	function advance() {
		if (phase === 'results') {
			steady = null;
			phase = 'ready';
		} else if (phase === 'ready') startRun();
	}

	function step(slot: 'left' | 'right', by: number) {
		if (!runs.length) return;
		const id = slot === 'left' ? leftId : rightId;
		const at = runs.findIndex((r) => r.id === id);
		const next = runs[(at + by + runs.length) % runs.length].id;
		if (slot === 'left') leftId = next;
		else rightId = next;
	}

	function rename(run: ShownRun, label: string) {
		runs = runs.map((r) => (r.id === run.id ? { ...r, label } : r));
		const { url: _, ...saved } = { ...run, label };
		putRun(saved);
		saveRunToDisk(saved, false);
	}

	function remove(run: ShownRun) {
		URL.revokeObjectURL(run.url);
		runs = runs.filter((r) => r.id !== run.id);
		deleteRun(run.id);
		if (leftId === run.id) {
			leftId = rightId;
			rightId = null;
		} else if (rightId === run.id) rightId = null;
		if (!runs.length) advance();
	}

	function restartClips() {
		for (const v of videos) {
			if (!v) continue;
			v.currentTime = 0;
			v.play().catch(() => {});
		}
	}

	$effect(() => {
		if (phase !== 'results' || !shown.length) return;
		let frame = 0;
		const update = () => {
			playhead = videos.find(Boolean)?.currentTime ?? 0;
			frame = requestAnimationFrame(update);
		};
		tick().then(restartClips);
		update();
		return () => cancelAnimationFrame(frame);
	});

	function tracePath(points: TracePoint[], key: 'eye' | 'head') {
		let d = '';
		let last = -Infinity;
		for (const p of points) {
			const x = (p.t / CAPTURE_MS) * TRACE_W;
			const y = TRACE_H / 2 - (p[key] / traceScale) * (TRACE_H / 2);
			d += `${p.t - last > 150 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
			last = p.t;
		}
		return d;
	}

	onMount(() => {
		targets.enabled = false;
		engine.dataTap = onFrame;
		// ToolLeave has already claimed nods. A nod aimed at it leaves, and any other moves things on.
		const leaveNod = toolInput.nod;
		toolInput.nod = (onset) => {
			leaveNod?.(onset);
			if (!closed) advance();
		};
		loadRuns()
			.then((saved) => {
				if (closed || !saved.length) return;
				runs = saved.map((r) => ({ ...r, url: URL.createObjectURL(r.clip) }));
				leftId = saved[0].id;
				rightId = saved.length > 1 ? saved[saved.length - 1].id : null;
				if (phase === 'ready') phase = 'results';
			})
			.catch(() => {});
	});

	onDestroy(() => {
		closed = true;
		clearTimeout(timer);
		if (recorder) stopRecorder();
		engine.dataTap = null;
		toolInput.nod = null;
		targets.enabled = true;
		for (const r of runs) URL.revokeObjectURL(r.url);
	});
</script>

<div class="fixed inset-0 z-40 bg-slate-950 text-white">
	<div class:faint={measuring}>
		<ToolLeave
			onLeave={() => {
				closed = true;
				onClose();
			}}
		/>
	</div>

	<!-- Always here, because it is what gets recorded. It's only hidden while someone is being measured. -->
	<canvas
		bind:this={canvas}
		width={CLIP_W}
		height={CLIP_H}
		class="live"
		class:hide={phase !== 'ready'}
	></canvas>

	{#if phase === 'ready'}
		<div class="absolute inset-x-0 top-[70%] flex flex-col items-center gap-3 text-center">
			<p class="text-5xl font-bold">Nod, then look at the dot</p>
			{#if tooFar}<p class="text-3xl font-semibold text-amber-300">Move closer to the camera</p>{/if}
			{#if notice}<p class="text-3xl font-semibold text-amber-300">{notice}</p>{/if}
		</div>
	{:else if phase === 'settle' || phase === 'capture'}
		<div class="dot"></div>
		{#if phase === 'settle'}
			<p class="absolute top-[60%] w-full text-center text-5xl font-bold">Look at the dot</p>
		{/if}
	{:else}
		<div class="columns">
			{#each shown as run, i (run.id)}
				{@const slot = i === 0 ? 'left' : 'right'}
				<section class="flex min-w-0 flex-col gap-3">
					<div class="flex items-center gap-2">
						<button class="small" onclick={() => step(slot, -1)} aria-label="Previous run">‹</button>
						<input
							value={run.label}
							onchange={(e) => rename(run, e.currentTarget.value)}
							class="min-w-0 flex-1 rounded bg-transparent px-2 text-3xl font-bold"
							aria-label="Name"
						/>
						<button class="small" onclick={() => step(slot, 1)} aria-label="Next run">›</button>
						<button class="small" onclick={() => remove(run)} aria-label="Delete run">🗑</button>
					</div>
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						bind:this={videos[i]}
						src={run.url}
						muted
						playsinline
						onended={restartClips}
						class="aspect-[3/1] w-full rounded-lg bg-black object-cover"
					></video>
					<svg viewBox="0 0 {TRACE_W} {TRACE_H}" class="w-full rounded-lg bg-slate-900" aria-label="Eye and head movement over ten seconds">
						<line x1="0" x2={TRACE_W} y1={TRACE_H / 2} y2={TRACE_H / 2} stroke="#334155" />
						<path d={tracePath(run.score.trace, 'head')} fill="none" stroke="#34d399" stroke-width="2.5" />
						<path d={tracePath(run.score.trace, 'eye')} fill="none" stroke="#fb923c" stroke-width="2" />
						<line x1={(playhead * 1000 * TRACE_W) / CAPTURE_MS} x2={(playhead * 1000 * TRACE_W) / CAPTURE_MS} y1="0" y2={TRACE_H} stroke="white" stroke-opacity="0.45" />
					</svg>
					<div class="flex gap-10">
						<p class="text-2xl font-semibold text-orange-400">
							Eyes <b class="text-6xl">{run.score.eyeCm.toFixed(2)}</b> cm
						</p>
						<p class="text-2xl font-semibold text-emerald-400">
							Head <b class="text-6xl">{run.score.headCm.toFixed(2)}</b> cm
						</p>
					</div>
				</section>
			{/each}
		</div>
		<p class="absolute inset-x-8 bottom-4 text-center text-xl text-slate-300">
			Same webcam, same 10 seconds looking at one dot. How far each would wobble a pointer, unsmoothed. Lines
			span ±{traceScale.toFixed(1)} cm. <b class="text-white">Nod for the next person.</b>
		</p>
	{/if}
</div>

<style>
	.faint {
		opacity: 0.15;
	}
	.live {
		position: absolute;
		left: 50%;
		top: 18%;
		width: min(72vw, 130vh);
		translate: -50% 0;
		border-radius: 1rem;
		background: black;
	}
	.hide {
		visibility: hidden;
	}
	.dot {
		position: absolute;
		left: 50%;
		top: 50%;
		height: 2.5rem;
		width: 2.5rem;
		translate: -50% -50%;
		border-radius: 50%;
		background: #ef4444;
	}
	.columns {
		position: absolute;
		inset: 9rem 2rem 4.5rem;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
		gap: 2rem;
	}
	.small {
		height: 2.75rem;
		width: 2.75rem;
		flex: none;
		border-radius: 0.5rem;
		background: #334155;
		font-size: 1.4rem;
	}
</style>
