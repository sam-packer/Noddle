<script lang="ts">
	import { target, targets } from '../input/targets.svelte';
	import { engine, setup } from '../vision/engine.svelte';
	import { gestureConfig } from '../vision/gestures';
	import { testLog } from './testlog.svelte';

	let {
		onTest,
		onRecord,
		onClose
	}: { onTest: (train: boolean) => void; onRecord: () => void; onClose: () => void } = $props();

	/** Research tools save to the dev server, so they only exist there. */
	const research = import.meta.env.DEV;

	let copied = $state(false);

	const fmt = (v: number | null | undefined, digits = 1) =>
		v === null || v === undefined || Number.isNaN(v) ? '–' : v.toFixed(digits);

	async function copy() {
		await testLog.copy();
		copied = true;
		setTimeout(() => (copied = false), 1200);
	}
</script>

{#if engine.headPoint}
	<!-- Where the head points this frame. The pointer waits through a nod, and this doesn't. -->
	<div
		class="dot"
		style:transform="translate({engine.headPoint.x}px, {engine.headPoint.y}px) translate(-50%, -50%)"
	></div>
{/if}

<div class="hud">
	<button
		use:target={{ id: 'hud-close', legal: true, confirm: onClose }}
		class="close"
		class:focused={targets.focused === 'hud-close'}
	>
		✕ Close debug
	</button>
	<p>
		Keys, while this is open: P menu · N skip · H hand over · R restart · C recentre · X flip left and
		right · V swap nod and shake · M mark a mistake · F fullscreen · D close
	</p>
	{#if research}
		<p>
			Research tools: G record · B test run · K collect (Space in a run marks a dot you can't find) · E
			eyes · T/Y accuracy
		</p>
		<button class="record" onclick={onRecord}>Record nods and shakes (G)</button>
	{/if}

	<canvas {@attach (c) => engine.addPreview(c)} width="256" height="144" class="w-full rounded"></canvas>

	{#if engine.problem}
		<p class="warn">{engine.problem}</p>
	{/if}

	<div class="grid grid-cols-2 gap-x-3">
		<span>Camera {engine.resolution}</span><span>{engine.fps} fps</span>
		<span>Lock {engine.lock}</span><span>{engine.faceCount} face(s)</span>
		<span>Distance {fmt(engine.distanceCm, 0)} cm</span><span>Face {fmt(engine.faceWidth * 100, 0)}%</span>
		<span>Yaw {fmt(engine.yaw, 0)}°</span><span>Pitch {fmt(engine.pitch, 0)}°</span>
		<span>Landmarks {fmt(engine.mediapipeMs, 0)} ms</span>
		<span class:warn={!engine.inBounds}>{engine.inBounds ? 'In bounds' : 'OUT OF BOUNDS'}</span>
		<span>Head off by {fmt(engine.headErrorCm)} cm</span><span>over {engine.sampleCount} picks</span>
		<span class="col-span-2">
			Last: {engine.lastGesture || '–'} · nods {engine.nodStyle ?? '–'} · mouth {engine.mouth.toFixed(2)}{engine.talking
				? ' TALKING'
				: ''}
		</span>
	</div>

	<div class="mt-1 flex items-center gap-1">
		<label for="nod">Nod°</label>
		<input
			id="nod"
			type="number"
			step="0.5"
			min="1"
			max="20"
			bind:value={() => gestureConfig.nodDeg, (v) => (gestureConfig.nodDeg = v)}
		/>
		<label for="shake">Shake°</label>
		<input
			id="shake"
			type="number"
			step="0.5"
			min="1"
			max="25"
			bind:value={() => gestureConfig.shakeDeg, (v) => (gestureConfig.shakeDeg = v)}
		/>
		<label for="scr">Screen cm</label>
		<input id="scr" type="number" step="0.1" bind:value={setup.screenWidthCm} />
	</div>

	<div class="mt-1 flex items-center gap-1">
		<label for="crop">Detect area %</label>
		<input
			id="crop"
			type="number"
			step="5"
			min="30"
			max="100"
			bind:value={() => Math.round(setup.cropScale * 100), (v) => (setup.cropScale = v / 100)}
		/>
		<label for="cropy">Shift %</label>
		<input
			id="cropy"
			type="number"
			step="5"
			min="-35"
			max="35"
			bind:value={() => Math.round(setup.cropOffsetY * 100), (v) => (setup.cropOffsetY = v / 100)}
		/>
	</div>

	<div class="mt-1 flex items-center gap-1">
		<label for="ry">Head range°</label>
		<input id="ry" type="number" step="1" min="3" max="45" bind:value={setup.headRangeYawDeg} />
		<input
			aria-label="Head range upward"
			type="number"
			step="1"
			min="3"
			max="45"
			bind:value={setup.headRangePitchDeg}
		/>
		<input
			aria-label="Head range downward"
			type="number"
			step="1"
			min="2"
			max="45"
			bind:value={setup.headRangeDownDeg}
		/>
		<label for="dz">Still°</label>
		<input id="dz" type="number" step="0.1" min="0" max="5" bind:value={setup.headDeadbandDeg} />
	</div>

	{#if research}
		<div class="mt-2 flex items-center gap-1">
			<input class="grow" aria-label="Position label" placeholder="position" bind:value={testLog.label} />
			<button onclick={() => onTest(false)}>Test</button>
			<button onclick={() => onTest(true)}>Train</button>
		</div>

		{#if testLog.rows.length}
			<table class="mt-1 w-full">
				<thead>
					<tr><th class="text-left">Position</th><th>cm</th><th>pitch</th><th>Head error cm</th></tr>
				</thead>
				<tbody>
					{#each testLog.rows.slice(-8) as row (row.at)}
						<tr>
							<td class="max-w-24 truncate">{row.trained ? '+ ' : ''}{row.label}</td>
							<td class="text-center">{row.distanceCm}</td>
							<td class="text-center">{row.pitch}</td>
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
	{/if}

	{#each engine.errors as e, i (i)}
		<p class="text-red-400">{e}</p>
	{/each}
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
		background: #facc15;
		opacity: 0.75;
		pointer-events: none;
		outline: 2px solid rgb(0 0 0 / 0.5);
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
	.close {
		width: 100%;
		height: 4rem;
		margin-bottom: 0.5rem;
		border-radius: 0.5rem;
		border: 3px solid #94a3b8;
		background: #334155;
		font-size: 1.2rem;
		font-weight: 800;
	}
	.close.focused {
		box-shadow:
			0 0 0 3px #fde047,
			0 0 25px 8px rgb(253 224 71 / 0.75);
	}
	.warn {
		color: #f87171;
		font-weight: 700;
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
