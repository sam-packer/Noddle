<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { targets } from '../input/targets.svelte';
	import { engine, setup, type DataFrame } from '../vision/engine.svelte';
	import { faceBox } from '../vision/math';
	import ToolLeave, { toolInput } from './ToolLeave.svelte';

	let { onClose }: { onClose: () => void } = $props();

	const BLOCK_SECONDS = 300;
	const SETTLE_MS = 600;
	const FRAME_MS = 66;
	const MAX_UPLOADS = 8;
	const COLS = 11;
	const ROWS = 7;
	// Test parts dwell longer, so scoring can use windows of up to 1.5 s after the eyes settle.
	const SHORT_DOT_MS = 1600;
	const LONG_DOT_MS = 3000;

	type Block = { id: string; text: string; dotMs: number };

	const MAIN_BLOCKS: Block[] = [
		{ id: 'still-1', text: 'Sit normally. Keep your head still and follow the dot with your eyes.', dotMs: SHORT_DOT_MS },
		{ id: 'moving-1', text: 'Sit normally. Move your head naturally and look at the dot.', dotMs: SHORT_DOT_MS },
		{ id: 'far', text: 'Lean back or move your chair back. Keep your head still and follow the dot.', dotMs: SHORT_DOT_MS },
		{ id: 'still-2', text: 'Sit normally. Keep your head still and follow the dot with your eyes.', dotMs: LONG_DOT_MS },
		{ id: 'standing', text: 'Stand at the table and look down at the screen, like a judge would. Follow the dot.', dotMs: SHORT_DOT_MS },
		{ id: 'moving-2', text: 'Any comfortable position. Move your head naturally and look at the dot.', dotMs: LONG_DOT_MS }
	];
	// A separate sitting, later on, gives a test that shares nothing with training.
	const TEST_BLOCKS: Block[] = [
		{ id: 'test-session', text: 'Sit normally. Move your head naturally and look at the dot.', dotMs: LONG_DOT_MS }
	];

	const session = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
	let kind = $state<'main' | 'test'>('main');
	const blocks = $derived(kind === 'main' ? MAIN_BLOCKS : TEST_BLOCKS);

	let fullscreen = $state(!!document.fullscreenElement);
	let measured = $state(false);
	let formError = $state('');
	let viewportWidthCm = $state<number | null>(null);
	let lensFromLeftCm = $state<number | null>(null);
	let lensAboveCm = $state<number | null>(null);
	let viewingEye = $state('');
	let glasses = $state('');
	let eyeDistanceCm = $state<number | null>(null);

	let blockIndex = $state(0);
	let phase = $state<'intro' | 'running' | 'done'>('intro');
	let dot = $state({ x: 0.5, y: 0.5 });
	let dotId = $state(0);
	let saved = $state(0);
	let skipped = $state(0);
	let lost = $state(0);
	let remaining = $state(BLOCK_SECONDS);
	/** Stopped part way through a part, which carries on from there. */
	let paused = $state(false);
	/** Fullscreen this tool asked for, so it hands it back when it closes. */
	let wentFullscreen = false;

	let dotStart = 0;
	let lastFrame = 0;
	let uploads = 0;
	let n = 0;
	let bag: { x: number; y: number }[] = [];
	let labels: unknown[] = [];
	let dotTimer: ReturnType<typeof setInterval> | undefined;
	let clockTimer: ReturnType<typeof setInterval> | undefined;
	let labelTimer: ReturnType<typeof setInterval> | undefined;
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d', { alpha: false })!;

	/** Resolves true once the dev server has it. Never rejects, so a lost write can't stop a run. */
	const post = (path: string, body: BodyInit, extra = '') =>
		fetch(`/__dataset/${path}?session=${session}${extra}`, { method: 'POST', body }).then(
			(res) => res.ok,
			() => false
		);

	function nextDot() {
		if (bag.length === 0) {
			const cellX = 0.92 / (COLS - 1);
			const cellY = 0.88 / (ROWS - 1);
			const clamp = (v: number) => Math.max(0.02, Math.min(0.98, v));
			// Jittered by up to half a cell, so no two parts share exact positions.
			for (let r = 0; r < ROWS; r++) {
				for (let c = 0; c < COLS; c++) {
					bag.push({
						x: clamp(0.04 + c * cellX + (Math.random() - 0.5) * cellX),
						y: clamp(0.06 + r * cellY + (Math.random() - 0.5) * cellY)
					});
				}
			}
			for (let i = bag.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[bag[i], bag[j]] = [bag[j], bag[i]];
			}
		}
		dot = bag.pop()!;
		dotId += 1;
		dotStart = performance.now();
	}

	function flushLabels() {
		if (labels.length === 0) return;
		const text = labels.map((l) => JSON.stringify(l)).join('\n') + '\n';
		labels = [];
		post('labels', text);
	}

	function onFrame(f: DataFrame) {
		if (phase !== 'running' || f.ts - lastFrame < FRAME_MS) return;
		if (uploads >= MAX_UPLOADS) {
			skipped += 1;
			return;
		}
		lastFrame = f.ts;

		const box = faceBox(f.lm);
		const side = Math.max(box.w * f.W, box.h * f.H) * 1.5;
		const x = Math.round(Math.max(0, box.cx * f.W - side / 2));
		const y = Math.round(Math.max(0, box.cy * f.H - side / 2));
		const w = Math.round(Math.min(side, f.W - x));
		const h = Math.round(Math.min(side, f.H - y));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ctx.drawImage(f.video, x, y, w, h, 0, 0, w, h);

		const id = n++;
		const round = (v: number, k = 10000) => Math.round(v * k) / k;
		const captureTime = f.captureTime ?? f.ts;
		labels.push({
			n: id,
			t: round(f.ts, 10),
			captureTime: round(captureTime, 10),
			presentedFrames: f.presentedFrames,
			block: blocks[blockIndex].id,
			dotId,
			dotStart: round(dotStart, 10),
			phase: captureTime - dotStart < SETTLE_MS ? 'settle' : 'fix',
			dot: { x: round(dot.x * innerWidth, 10), y: round(dot.y * innerHeight, 10) },
			window: { screenX, screenY, innerWidth, innerHeight, outerHeight },
			crop: { x, y, w, h },
			frame: { w: f.W, h: f.H },
			yaw: round(f.yaw, 100),
			pitch: round(f.pitch, 100),
			distance: round(f.distance, 100),
			ear: round(f.ear, 1000),
			matrix: Array.from(f.matrix, (v) => round(v)),
			lm: f.lm.map((l) => [round(l.x), round(l.y), round(l.z)])
		});

		uploads += 1;
		canvas.toBlob(
			(blob) => {
				if (!blob) {
					uploads -= 1;
					return;
				}
				post('frame', blob, `&n=${id}`)
					.then((ok) => {
						if (ok) saved += 1;
					})
					.finally(() => {
						uploads -= 1;
					});
			},
			'image/jpeg',
			0.92
		);
	}

	function saveMeta() {
		post(
			'meta',
			JSON.stringify({
				session,
				kind,
				startedAt: new Date().toISOString(),
				screen: { width: screen.width, height: screen.height },
				viewport: { width: innerWidth, height: innerHeight },
				devicePixelRatio,
				viewportWidthCm,
				lensFromLeftCm,
				lensAboveCm,
				viewingEye,
				glasses,
				irisCmDefault: setup.irisCm,
				cameraHfovDegDefault: setup.cameraHfovDeg,
				track: engine.videoSettings(),
				resolution: engine.resolution,
				userAgent: navigator.userAgent
			})
		);
	}

	function confirmMeasurements() {
		if (!viewportWidthCm || lensFromLeftCm === null || lensAboveCm === null || !viewingEye || !glasses) {
			formError = 'Please fill in every box.';
			return;
		}
		if (viewportWidthCm < 15 || viewportWidthCm > 60) {
			formError = 'That picture width looks wrong. It should be in centimetres.';
			return;
		}
		formError = '';
		measured = true;
		saveMeta();
	}

	function startBlock() {
		const block = blocks[blockIndex];
		labels.push({ event: 'block-start', block: block.id, t: performance.now(), eyeDistanceCm });
		phase = 'running';
		if (!paused) remaining = BLOCK_SECONDS;
		paused = false;
		bag = [];
		nextDot();
		dotTimer = setInterval(nextDot, block.dotMs);
		clockTimer = setInterval(() => {
			remaining -= 1;
			if (remaining <= 0) endBlock();
		}, 1000);
	}

	function stopTimers() {
		clearInterval(dotTimer);
		clearInterval(clockTimer);
	}

	function pauseBlock() {
		stopTimers();
		labels.push({ event: 'block-paused', block: blocks[blockIndex].id, t: performance.now() });
		flushLabels();
		paused = true;
		phase = 'intro';
	}

	function endBlock() {
		stopTimers();
		flushLabels();
		blockIndex += 1;
		eyeDistanceCm = null;
		phase = blockIndex >= blocks.length ? 'done' : 'intro';
	}

	function onFullscreenChange() {
		fullscreen = !!document.fullscreenElement;
		// Dot positions only mean something on the measured, fullscreen picture.
		if (!fullscreen && phase === 'running') pauseBlock();
	}

	/** Browsers only allow fullscreen from a key or a click, so running this tool takes hands. */
	function goFullscreen() {
		wentFullscreen = true;
		document.documentElement.requestFullscreen().catch(() => {
			wentFullscreen = false;
			formError = 'Could not go fullscreen. Recording needs fullscreen.';
		});
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			if (!fullscreen) goFullscreen();
			else if (!measured) confirmMeasurements();
			else if (phase === 'intro') startBlock();
		} else if (e.key === ' ' && phase === 'running') {
			// The player couldn't find the dot, so this one shouldn't be trusted.
			e.preventDefault();
			lost += 1;
			labels.push({ event: 'lost-dot', dotId, t: performance.now() });
		} else if (e.key === 'Escape') {
			if (phase === 'running') pauseBlock();
			else onClose();
		}
	}

	onMount(() => {
		targets.enabled = false;
		engine.dataTap = onFrame;
		toolInput.shake = () => {
			if (phase === 'running') pauseBlock();
		};
		labelTimer = setInterval(flushLabels, 1000);
	});

	onDestroy(() => {
		stopTimers();
		clearInterval(labelTimer);
		flushLabels();
		engine.dataTap = null;
		toolInput.shake = null;
		targets.enabled = true;
		if (wentFullscreen && document.fullscreenElement) document.exitFullscreen();
	});

	const minutes = $derived(`${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`);
</script>

<svelte:window onkeydown={onKeydown} />
<svelte:document onfullscreenchange={onFullscreenChange} />

<!-- Above the pointer during a run, so it can't pull the eyes away from the dot. -->
<div class={['fixed inset-0 bg-black text-white', phase === 'running' ? 'z-[70]' : 'z-40']}>
	{#if phase !== 'running'}
		<ToolLeave onLeave={onClose} label={phase === 'done' ? 'Close' : 'Leave'} />
	{/if}
	{#if !fullscreen}
		<div class="flex h-full flex-col items-center justify-center gap-6 px-16 text-center">
			<p class="text-6xl font-bold">Data collection needs fullscreen</p>
			<p class="text-3xl text-slate-300">This is a development tool. Point at Leave and nod to go back.</p>
			<button class="go" onclick={goFullscreen}>Go fullscreen</button>
			<p class="text-2xl text-amber-300">{formError}</p>
		</div>
	{:else if !measured}
		<!-- The white frame marks the exact picture to measure. -->
		<div class="pointer-events-none absolute inset-0 border-4 border-white"></div>
		<div class="flex h-full flex-col items-center justify-center gap-4 px-16 text-xl">
			<p class="text-4xl font-bold">Before you start</p>
			<p class="text-amber-300">
				In Control Center, turn off Center Stage, Portrait and Studio Light for the camera.
			</p>
			<p class="text-slate-300">Measure with a ruler, in centimetres, using the white frame.</p>

			<label class="field">
				<span>Width of the white frame</span>
				<input type="number" step="0.1" bind:value={viewportWidthCm} />
			</label>
			<label class="field">
				<span>Left edge of the frame to the camera lens</span>
				<input type="number" step="0.1" bind:value={lensFromLeftCm} />
			</label>
			<label class="field">
				<span>Top edge of the frame up to the camera lens</span>
				<input type="number" step="0.1" bind:value={lensAboveCm} />
			</label>
			<label class="field">
				<span>Which eye do you mostly see with?</span>
				<select bind:value={viewingEye}>
					<option value=""></option>
					<option value="left">Left</option>
					<option value="right">Right</option>
					<option value="both">Both</option>
				</select>
			</label>
			<label class="field">
				<span>Wearing glasses?</span>
				<select bind:value={glasses}>
					<option value=""></option>
					<option value="no">No</option>
					<option value="yes">Yes</option>
				</select>
			</label>
			<label class="field">
				<span>Which session?</span>
				<select bind:value={kind}>
					<option value="main">Main, 30 minutes</option>
					<option value="test">Separate test, 5 minutes, do this later</option>
				</select>
			</label>

			<p class="text-amber-300">{formError}</p>
			<button class="go" onclick={confirmMeasurements}>Done</button>
		</div>
	{:else if phase === 'intro'}
		<div class="flex h-full flex-col items-center justify-center gap-6 px-16 text-center">
			<p class="text-3xl text-slate-400">
				Part {blockIndex + 1} of {blocks.length}, {paused ? `${minutes} left` : '5 minutes'}
			</p>
			<p class="text-6xl leading-tight font-bold">{blocks[blockIndex].text}</p>
			<label class="field text-2xl">
				<span>Your eyes to the camera, in centimetres (if you can measure it)</span>
				<input type="number" step="1" bind:value={eyeDistanceCm} />
			</label>
			<button class="go" onclick={startBlock}>Start</button>
			<p class="text-xl text-slate-400">
				Take a break first if you want. Shake your head during a part to pause it. {saved} frames saved.
			</p>
		</div>
	{:else if phase === 'running'}
		{#key dotId}
			<div class="dot" style:left="{dot.x * 100}%" style:top="{dot.y * 100}%"></div>
		{/key}
		{#if engine.lock !== 'locked'}
			<p class="absolute inset-x-0 top-0 bg-amber-500 py-3 text-center text-2xl font-bold text-black">
				Lost you. Face the screen and nod to take control.
			</p>
		{/if}
		<p class="absolute right-3 bottom-2 text-sm text-slate-600">
			{minutes} · {saved} saved{skipped ? ` · ${skipped} skipped` : ''}{lost ? ` · ${lost} lost` : ''} · Shake to pause
		</p>
	{:else}
		<div class="flex h-full flex-col items-center justify-center gap-6 text-center">
			<p class="text-7xl font-bold text-emerald-300">All done. Thank you.</p>
			<p class="text-3xl">{saved} frames saved. Tell Claude.</p>
		</div>
	{/if}
</div>

<style>
	.go {
		border-radius: 0.8rem;
		border: 4px solid #6ee7b7;
		background: #047857;
		padding: 0.6rem 2.5rem;
		font-size: 1.6rem;
		font-weight: 800;
	}
	.field {
		display: flex;
		width: min(52rem, 90%);
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.field input,
	.field select {
		width: 12rem;
		border-radius: 0.4rem;
		background: #1e293b;
		padding: 0.4rem 0.6rem;
		color: white;
		font-size: 1.4rem;
	}
	/* The ring closes in, so the eyes land on the centre before the labelled part begins. */
	.dot {
		position: absolute;
		height: 22px;
		width: 22px;
		translate: -50% -50%;
		border-radius: 50%;
		background: #fde047;
	}
	.dot::after {
		content: '';
		position: absolute;
		inset: -50px;
		border: 5px solid #fde047;
		border-radius: 50%;
		animation: close 600ms ease-in forwards;
	}
	@keyframes close {
		to {
			inset: 0;
			opacity: 0;
		}
	}
</style>
