<script lang="ts">
	import { engine, setup, SOURCES, type SourceId } from '../vision/engine.svelte';
	import { gestureConfig } from '../vision/gestures';
	import { testLog } from './testlog.svelte';

	let { onTest, onRecord }: { onTest: (train: boolean) => void; onRecord: () => void } = $props();

	let nodDeg = $state(gestureConfig.nodDeg);
	let shakeDeg = $state(gestureConfig.shakeDeg);
	let screenCm = $state(setup.screenWidthCm);
	let cropPct = $state(Math.round(setup.cropScale * 100));
	let cropY = $state(Math.round(setup.cropOffsetY * 100));
	let rangeYaw = $state(setup.headRangeYawDeg);
	let rangePitch = $state(setup.headRangePitchDeg);
	let deadband = $state(setup.headDeadbandDeg);
	let rangeDown = $state(setup.headRangeDownDeg);
	let copied = $state(false);

	$effect(() => {
		gestureConfig.nodDeg = nodDeg;
		gestureConfig.shakeDeg = shakeDeg;
		setup.screenWidthCm = screenCm;
		setup.cropScale = cropPct / 100;
		setup.cropOffsetY = cropY / 100;
		setup.headRangeYawDeg = rangeYaw;
		setup.headRangePitchDeg = rangePitch;
		setup.headDeadbandDeg = deadband;
		setup.headRangeDownDeg = rangeDown;
	});

	const COLORS: Record<SourceId, string> = {
		free: '#22d3ee',
		calibrated: '#e879f9',
		head: '#facc15'
	};
	const NAMES: Record<SourceId, string> = {
		free: 'MobileOne (no calib)',
		calibrated: 'WebEyeTrack',
		head: 'Head'
	};

	const fmt = (v: number | null | undefined, digits = 1) =>
		v === null || v === undefined || Number.isNaN(v) ? '–' : v.toFixed(digits);

	async function copy() {
		await testLog.copy();
		copied = true;
		setTimeout(() => (copied = false), 1200);
	}
</script>

{#each SOURCES as s (s)}
	{@const p = engine.gaze[s]}
	{#if p}
		<div
			class="dot"
			class:active={engine.active === s}
			style:background={COLORS[s]}
			style:transform="translate({p.x}px, {p.y}px) translate(-50%, -50%)"
		></div>
	{/if}
{/each}

<div class="hud">
	<button class="record" onclick={onRecord}>Record nods and shakes (G)</button>

	<canvas {@attach (c) => engine.addPreview(c)} width="256" height="144" class="w-full rounded"></canvas>

	<div class="grid grid-cols-2 gap-x-3">
		<span>Camera {engine.resolution}</span><span>{engine.fps} fps</span>
		<span>Lock {engine.lock}</span><span>{engine.faceCount} face(s)</span>
		<span>Distance {fmt(engine.distanceCm, 0)} cm</span><span>Face {fmt(engine.faceWidth * 100, 0)}%</span>
		<span>Yaw {fmt(engine.yaw, 0)}°</span><span>Pitch {fmt(engine.pitch, 0)}°</span>
		<span>Eyes {engine.eyesOpen ? 'open' : 'CLOSED'} {fmt(engine.ear, 2)}</span>
		<span class:warn={!engine.inBounds}>{engine.inBounds ? 'In bounds' : 'OUT OF BOUNDS'}</span>
		<span>Landmarks {fmt(engine.mediapipeMs, 0)} ms</span><span>Samples {engine.sampleCount}/{engine.wetSamples}</span>
		<span>Free {fmt(engine.freeMs, 0)} ms</span><span>WET {fmt(engine.calibratedMs, 0)} ms</span>
		<span>Last: {engine.lastGesture || '–'}</span><span>{engine.info.calibrated ?? ''}</span>
	</div>

	<table class="mt-1 w-full">
		<tbody>
			{#each SOURCES as s, i (s)}
				<tr class:font-bold={engine.active === s}>
					<td><span class="swatch" style:background={COLORS[s]}></span>{i + 1} {NAMES[s]}</td>
					<td class="text-right">{fmt(engine.prequentialCm[s])} cm</td>
				</tr>
			{/each}
		</tbody>
	</table>
	<p>Driving: <b>{NAMES[engine.active]}</b> {engine.forced ? '(forced)' : `(${engine.policy})`}</p>

	<div class="mt-1 flex items-center gap-1">
		<label for="nod">Nod°</label>
		<input id="nod" type="number" step="0.5" min="1" max="20" bind:value={nodDeg} />
		<label for="shake">Shake°</label>
		<input id="shake" type="number" step="0.5" min="1" max="25" bind:value={shakeDeg} />
		<label for="scr">Screen cm</label>
		<input id="scr" type="number" step="0.1" bind:value={screenCm} />
	</div>

	<div class="mt-1 flex items-center gap-1">
		<label for="crop">Detect area %</label>
		<input id="crop" type="number" step="5" min="30" max="100" bind:value={cropPct} />
		<label for="cropy">Shift %</label>
		<input id="cropy" type="number" step="5" min="-35" max="35" bind:value={cropY} />
		<span class="text-slate-400">adapt {engine.info.adapt ?? '–'}, skipped {engine.wetSkipped}</span>
	</div>

	<div class="mt-1 flex items-center gap-1">
		<label for="ry">Head range°</label>
		<input id="ry" type="number" step="1" min="3" max="45" bind:value={rangeYaw} />
		<input aria-label="Head range upward" type="number" step="1" min="3" max="45" bind:value={rangePitch} />
		<input aria-label="Head range downward" type="number" step="1" min="2" max="45" bind:value={rangeDown} />
		<label for="dz">Still°</label>
		<input id="dz" type="number" step="0.1" min="0" max="5" bind:value={deadband} />
	</div>

	<div class="mt-2 flex items-center gap-1">
		<input class="grow" aria-label="Position label" placeholder="position" bind:value={testLog.label} />
		<button onclick={() => onTest(false)}>Test</button>
		<button onclick={() => onTest(true)}>Train</button>
	</div>

	{#if testLog.rows.length}
		<table class="mt-1 w-full">
			<thead>
				<tr><th class="text-left">Position</th><th>cm</th><th>pitch</th><th>Free</th><th>WET</th><th>Head</th></tr>
			</thead>
			<tbody>
				{#each testLog.rows.slice(-8) as row (row.at)}
					<tr>
						<td class="max-w-24 truncate">{row.trained ? '+ ' : ''}{row.label}</td>
						<td class="text-center">{row.distanceCm}</td>
						<td class="text-center">{row.pitch}</td>
						<td class="text-center">{fmt(row.errorCm.free)}</td>
						<td class="text-center">{fmt(row.errorCm.calibrated)}</td>
						<td class="text-center">{fmt(row.errorCm.head)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<div class="mt-1 flex gap-1">
			<button onclick={copy}>{copied ? 'Copied' : 'Copy log'}</button>
			<button onclick={() => testLog.clear()}>Clear</button>
		</div>
	{/if}

	{#each engine.errors as e, i (i)}
		<p class="text-red-400">{e}</p>
	{/each}

	<p class="mt-1 text-slate-400">
		D panel · C recentre · V swap nod and shake · K collect data · T test · Y train · 1/2/3 force source · ` lowest error · 0 head · N next · H handoff · R reset · F fullscreen · -/= zoom
	</p>
</div>

<style>
	.dot {
		position: fixed;
		left: 0;
		top: 0;
		z-index: 60;
		height: 18px;
		width: 18px;
		border-radius: 50%;
		opacity: 0.75;
		pointer-events: none;
		outline: 2px solid rgb(0 0 0 / 0.5);
	}
	.dot.active {
		height: 34px;
		width: 34px;
		opacity: 0.85;
		outline: 3px solid white;
	}
	.hud {
		position: fixed;
		left: 0.5rem;
		top: 0.5rem;
		z-index: 50;
		width: 21rem;
		border-radius: 0.5rem;
		background: rgb(2 6 23 / 0.88);
		padding: 0.5rem;
		color: #e2e8f0;
		font-size: 0.68rem;
		line-height: 1.15rem;
	}
	.warn {
		color: #f87171;
		font-weight: 700;
	}
	.swatch {
		display: inline-block;
		height: 0.55rem;
		width: 0.55rem;
		margin-right: 0.3rem;
		border-radius: 50%;
	}
	input {
		min-width: 0;
		width: 3rem;
		border-radius: 0.2rem;
		background: #1e293b;
		border: 0;
		padding: 0.05rem 0.25rem;
		font-size: 0.68rem;
		color: white;
	}
	input.grow {
		flex: 1;
		width: auto;
	}
	button {
		border-radius: 0.2rem;
		background: #334155;
		padding: 0.05rem 0.4rem;
	}
	.record {
		width: 100%;
		margin-bottom: 0.4rem;
		background: #b91c1c;
		padding: 0.35rem;
		font-size: 0.85rem;
		font-weight: 700;
	}
</style>
