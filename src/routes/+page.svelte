<script lang="ts">
	import { onMount } from 'svelte';
	import { smoothPointer } from '../lib/input/smoothPointer.svelte';
	import { targets } from '../lib/input/targets.svelte';
	import AccuracyTest from '../lib/stages/AccuracyTest.svelte';
	import Benchmark from '../lib/stages/Benchmark.svelte';
	import Collector from '../lib/stages/Collector.svelte';
	import Gate from '../lib/stages/Gate.svelte';
	import Hud from '../lib/stages/Hud.svelte';
	import Instructions from '../lib/stages/Instructions.svelte';
	import Recorder from '../lib/stages/Recorder.svelte';
	import Scrabble from '../lib/stages/Scrabble.svelte';
	import Uno from '../lib/stages/Uno.svelte';
	import { session } from '../lib/session';
	import { engine, setup, SOURCES } from '../lib/vision/engine.svelte';
	import { gestureConfig } from '../lib/vision/gestures';

	type Stage = 'gate' | 'instructions' | 'uno' | 'scrabble';
	const ORDER: Stage[] = ['gate', 'instructions', 'uno', 'scrabble'];

	let stage = $state<Stage>('gate');
	let hud = $state(false);
	let test = $state<{ train: boolean } | null>(null);
	let recording = $state(false);
	let collecting = $state(false);
	let testRun = $state(false);
	/** Shows briefly that a mistake was marked in the session log. */
	let marked = $state(false);
	let markTimer: ReturnType<typeof setTimeout> | undefined;
	/** In another window or tab, where head movement has nothing to do with the game. */
	let away = $state(false);
	let ignoreGesturesUntil = 0;
	/** The head is still coming back to the screen for a moment after the player returns. */
	const RETURN_GRACE_MS = 1200;

	function setAway(next: boolean) {
		if (next === away) return;
		away = next;
		session.event(next ? 'away' : 'back', {});
		if (!next) ignoreGesturesUntil = performance.now() + RETURN_GRACE_MS;
	}

	/** Which gesture confirms. The other one goes back, so the two can be compared. */
	let confirmWith = $state<'nod' | 'shake'>('nod');

	function next() {
		const i = ORDER.indexOf(stage);
		if (i < ORDER.length - 1) stage = ORDER[i + 1];
	}

	function markMistake() {
		const p = engine.pointer;
		session.event('mistake', { stage, selected: targets.focused, x: p?.x, y: p?.y });
		marked = true;
		clearTimeout(markTimer);
		markTimer = setTimeout(() => (marked = false), 1200);
	}

	$effect(() => {
		session.event('stage', { stage });
	});

	function startRecording() {
		engine.lockFirst();
		recording = true;
	}

	function handoff() {
		engine.release();
		stage = 'gate';
	}

	onMount(() => {
		session.start({ gestures: { ...gestureConfig } });
		engine.onFrame = (p, t) => targets.updateGaze(p, t, engine.selectionHeld);
		engine.onGesture = (g) => {
			if (test || collecting) return;
			if (away || performance.now() < ignoreGesturesUntil) {
				session.event('ignored', { kind: g.kind, why: away ? 'away' : 'just back' });
				return;
			}
			if (g.kind === confirmWith) targets.confirmGaze(g.onset);
			else targets.cancel();
		};
		engine.onLocked = () => {
			if (stage === 'gate') stage = 'instructions';
		};
		engine.start();
		return smoothPointer.start();
	});

	function onKeydown(e: KeyboardEvent) {
		const el = e.target as HTMLElement;
		if (el.tagName === 'INPUT' || collecting) return;
		switch (e.key) {
			case 'ArrowLeft':
				targets.move(-1, 0);
				break;
			case 'ArrowRight':
				targets.move(1, 0);
				break;
			case 'ArrowUp':
				targets.move(0, -1);
				break;
			case 'ArrowDown':
				targets.move(0, 1);
				break;
			case 'Enter':
				if (stage === 'gate') engine.lockFirst();
				else targets.confirmKey();
				break;
			case 'g':
				startRecording();
				break;
			case 'b':
				engine.lockFirst();
				testRun = true;
				break;
			case 'm':
				markMistake();
				break;
			case 'c':
				engine.recenter();
				break;
			case 'k':
				engine.lockFirst();
				collecting = true;
				break;
			case 'x':
				setup.headFlipX = !setup.headFlipX;
				break;
			case 'v':
				confirmWith = confirmWith === 'nod' ? 'shake' : 'nod';
				break;
			case 'Escape':
				targets.cancel();
				break;
			case 'd':
				hud = !hud;
				break;
			case 't':
				test = { train: false };
				break;
			case 'y':
				test = { train: true };
				break;
			case 'n':
				next();
				break;
			case 'h':
				handoff();
				break;
			case 'r':
				location.reload();
				break;
			case 'f':
				if (document.fullscreenElement) document.exitFullscreen();
				else document.documentElement.requestFullscreen();
				break;
			case '1':
			case '2':
			case '3':
				engine.forced = SOURCES[Number(e.key) - 1];
				break;
			case '`':
				engine.forced = null;
				engine.policy = 'best';
				break;
			case '0':
				engine.forced = null;
				engine.policy = 'head';
				break;
			default:
				return;
		}
		e.preventDefault();
	}
</script>

<svelte:window
	onkeydown={onKeydown}
	onmousemove={() => targets.mouseMoved()}
	onblur={() => setAway(true)}
	onfocus={() => setAway(false)}
/>
<svelte:document onvisibilitychange={() => setAway(document.hidden)} />

<main
	class="h-screen w-screen overflow-hidden bg-slate-950 text-white"
	style:--press={engine.nodProgress}
>
	{#if testRun}
		<Benchmark onClose={() => (testRun = false)} />
	{:else if stage === 'gate'}
		<Gate />
	{:else if stage === 'instructions'}
		<Instructions onDone={next} />
	{:else if stage === 'uno'}
		<Uno onDone={next} />
	{:else}
		<Scrabble />
	{/if}

	{#if engine.lock === 'lost' && stage !== 'gate'}
		<div class="fixed inset-x-0 top-0 z-30 bg-amber-500 py-3 text-center text-2xl font-bold text-black">
			Lost you. Face the screen and nod to take control.
		</div>
	{:else if engine.lock === 'locked' && !engine.inBounds}
		<div class="fixed inset-x-0 top-0 z-30 bg-amber-500 py-3 text-center text-2xl font-bold text-black">
			Step back into view
		</div>
	{/if}
</main>

{#if smoothPointer.visible}
	<div
		class="pointer"
		style:transform="translate({smoothPointer.x}px, {smoothPointer.y}px) translate(-50%, -50%)"
	></div>
{/if}

{#if !hud}
	<p class="fixed right-2 bottom-1 z-30 text-xs text-slate-500">B test run · M marks a mistake · C recentres · D debug</p>
{/if}

{#if away}
	<p class="fixed inset-x-0 top-0 z-[70] bg-sky-700 py-3 text-center text-2xl font-bold text-white">
		Paused while you're away. Click back to keep playing.
	</p>
{/if}

{#if marked}
	<p class="fixed right-4 bottom-8 z-30 rounded bg-rose-600 px-4 py-2 text-xl font-bold text-white">Mistake marked</p>
{/if}

{#if hud}
	<Hud onTest={(train) => (test = { train })} onRecord={startRecording} />
{/if}

{#if collecting}
	<Collector onClose={() => (collecting = false)} />
{/if}

{#if recording}
	<Recorder onClose={() => (recording = false)} />
{/if}

{#if test}
	<AccuracyTest train={test.train} onClose={() => (test = null)} />
{/if}

<style>
	.pointer {
		position: fixed;
		left: 0;
		top: 0;
		z-index: 55;
		height: 26px;
		width: 26px;
		border-radius: 50%;
		background: rgb(250 204 21 / 0.55);
		box-shadow: 0 0 0 2px rgb(255 255 255 / 0.5);
		pointer-events: none;
	}
</style>
