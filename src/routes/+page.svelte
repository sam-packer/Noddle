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
	import { createDemoScrabble, createDemoUno, createLocalScrabble, createLocalUno } from '../lib/session/browser';
	import { hasSeatToken } from '../lib/session/remote';
	import type { GameSession } from '../lib/session/types';
	import type { UnoAction, UnoView } from '../lib/games/uno/engine';
	import type { ScrabbleAction, ScrabbleView } from '../lib/games/scrabble/engine';
	import Menu, { type MenuChoice } from '../lib/stages/Menu.svelte';
	import Room from '../lib/stages/Room.svelte';
	import { toolInput } from '../lib/stages/ToolLeave.svelte';
	import { engine, setup, SOURCES } from '../lib/vision/engine.svelte';
	import { gestureConfig } from '../lib/vision/gestures';

	type Stage = 'gate' | 'instructions' | 'menu' | 'uno' | 'scrabble' | 'play-uno' | 'play-scrabble' | 'room';

	/** Leave the game, open tools or change the controls, so they only work with the debug panel open. */
	const DEBUG_KEYS = 'prnbgktyxvh1230`';

	/** Asks to join a room, from a shared link. */
	const roomLink = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? null;
	let roomRequest = $state<{ join: string } | null>(roomLink ? { join: roomLink } : null);
	/** The instructions run once, before whatever the player opens first. */
	let taught = false;
	let afterInstructions: MenuChoice = 'multiplayer';

	let stage = $state<Stage>('gate');
	let localUno = $state<GameSession<UnoView, UnoAction> | null>(null);
	let localScrabble = $state<GameSession<ScrabbleView, ScrabbleAction> | null>(null);
	// A fresh script each time its stage opens, and stopped when it closes.
	const demoUno = $derived(stage === 'uno' ? createDemoUno() : null);
	const demoScrabble = $derived(stage === 'scrabble' ? createDemoScrabble() : null);
	$effect(() => {
		const opened = demoUno;
		return () => opened?.close();
	});
	$effect(() => {
		const opened = demoScrabble;
		return () => opened?.close();
	});
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

	/** Someone already seated in this room is mid game, and others are waiting on them. */
	function returningToRoom() {
		try {
			return !!roomLink && hasSeatToken(localStorage, roomLink);
		} catch {
			return false;
		}
	}

	function next() {
		if (stage === 'gate') {
			if (!roomRequest) stage = 'menu';
			else stage = returningToRoom() ? 'room' : 'instructions';
		} else if (stage === 'instructions') {
			taught = true;
			open(afterInstructions);
		} else if (stage === 'uno') {
			stage = 'scrabble';
		}
	}

	function closeLocalGames() {
		localUno?.close();
		localScrabble?.close();
		localUno = null;
		localScrabble = null;
	}

	function toMenu() {
		closeLocalGames();
		roomRequest = null;
		stage = 'menu';
	}

	function chooseFromMenu(choice: MenuChoice) {
		session.event('menu', { choice });
		if (taught) {
			open(choice);
		} else {
			afterInstructions = choice;
			stage = 'instructions';
		}
	}

	function open(choice: MenuChoice) {
		closeLocalGames();
		switch (choice) {
			case 'demo':
				stage = 'uno';
				break;
			case 'uno':
				localUno = createLocalUno();
				stage = 'play-uno';
				break;
			case 'scrabble':
				localScrabble = createLocalScrabble();
				stage = 'play-scrabble';
				break;
			case 'multiplayer':
				stage = 'room';
				break;
		}
	}

	/** Back to the first screen of the demo, the lesson, ready for the next person. */
	function restartDemo() {
		session.event('menu', { choice: 'demo-restart' });
		afterInstructions = 'demo';
		stage = 'instructions';
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
		hud = false;
		recording = true;
	}

	function handoff() {
		closeLocalGames();
		engine.release();
		taught = false;
		stage = 'gate';
	}

	onMount(() => {
		session.start({ gestures: { ...gestureConfig } });
		engine.onFrame = (p, t) => targets.updateGaze(p, t, engine.selectionHeld);
		engine.onGesture = (g) => {
			if (away || performance.now() < ignoreGesturesUntil) {
				session.event('ignored', { kind: g.kind, why: away ? 'away' : 'just back' });
				// Still in view with another window in front, so this nod brings the game back. That's
				// all it does: it never reaches a target. A hidden tab comes back when it's shown.
				if (away && !document.hidden && g.kind === confirmWith) setAway(false);
				return;
			}
			if (test || collecting || recording) {
				if (g.kind === confirmWith) toolInput.nod?.(g.onset);
				else toolInput.shake?.();
				return;
			}
			if (g.kind === confirmWith) targets.confirmGaze(g.onset);
			else targets.cancel();
		};
		engine.onLocked = () => {
			if (stage === 'gate') next();
			// The same nod answers both banners, rather than asking for one more.
			if (!document.hidden) setAway(false);
		};
		engine.start();
		return smoothPointer.start();
	});

	function onKeydown(e: KeyboardEvent) {
		const el = e.target as HTMLElement;
		if (el.tagName === 'INPUT' || collecting) return;
		if (!hud && DEBUG_KEYS.includes(e.key)) return;
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
				hud = false;
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
				hud = false;
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
				hud = false;
				test = { train: false };
				break;
			case 'y':
				hud = false;
				test = { train: true };
				break;
			case 'n':
				next();
				break;
			case 'p':
				engine.lockFirst();
				toMenu();
				break;
			case 'h':
				handoff();
				break;
			case 'r':
				// Back to the start from anywhere, even if a room changed the address.
				location.assign('/');
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
		<Instructions onDone={next} onExit={toMenu} />
	{:else if stage === 'uno' && demoUno}
		<Uno session={demoUno} onDone={next} onExit={toMenu} {restartDemo} />
	{:else if stage === 'scrabble' && demoScrabble}
		<Scrabble session={demoScrabble} onExit={toMenu} {restartDemo} />
	{:else if stage === 'menu'}
		<Menu onChoose={chooseFromMenu} />
	{:else if stage === 'play-uno' && localUno}
		<Uno session={localUno} onDone={toMenu} onExit={toMenu} />
	{:else if stage === 'play-scrabble' && localScrabble}
		<Scrabble session={localScrabble} onExit={toMenu} />
	{:else if stage === 'room'}
		<Room request={roomRequest} onExit={toMenu} />
	{/if}

	{#if engine.lock === 'lost' && stage !== 'gate'}
		<div class="banner">
			Lost you. Face the screen and nod to take control.
		</div>
	{:else if engine.lock === 'locked' && !engine.inBounds}
		<div class="banner">
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

{#if away}
	<p class="fixed inset-x-0 top-0 z-[70] bg-sky-700 py-3 text-center text-2xl font-bold text-white">
		Paused while you're away. Nod to keep playing.
	</p>
{/if}

{#if marked}
	<p class="fixed right-4 bottom-8 z-30 rounded bg-rose-600 px-4 py-2 text-xl font-bold text-white">Mistake marked</p>
{/if}

{#if hud}
	<Hud onTest={(train) => (test = { train })} onRecord={startRecording} onClose={() => (hud = false)} />
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
	/* Narrow enough to leave the corners clear, because that's where the way out of a screen is. */
	.banner {
		position: fixed;
		left: 50%;
		top: 0;
		z-index: 45;
		translate: -50% 0;
		border-radius: 0 0 0.8rem 0.8rem;
		background: #f59e0b;
		padding: 0.75rem 2rem;
		color: black;
		font-size: 1.5rem;
		font-weight: 700;
		white-space: nowrap;
	}
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
