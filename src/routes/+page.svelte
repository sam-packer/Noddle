<script lang="ts">
	import { onMount } from 'svelte';
	import { smoothPointer } from '../lib/input/smoothPointer.svelte';
	import { targets } from '../lib/input/targets.svelte';
	import Gate from '../lib/stages/Gate.svelte';
	import Hud from '../lib/stages/Hud.svelte';
	import Instructions from '../lib/stages/Instructions.svelte';
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
	import { engine, setup } from '../lib/vision/engine.svelte';
	import { gestureConfig } from '../lib/vision/gestures';

	type Stage = 'gate' | 'instructions' | 'menu' | 'uno' | 'scrabble' | 'play-uno' | 'play-scrabble' | 'room';
	/** A research tool. Only one is open at a time, since each takes over the targets and the gestures. */
	type Tool = 'test' | 'train' | 'recorder' | 'collector' | 'eyes' | 'benchmark';

	/**
	 * Keys that work without the debug panel: a stand-in for the head, fullscreen, and the panel
	 * itself. Every other key leaves the game or changes the controls, so it needs the panel open.
	 */
	const OPEN_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'f', 'd']);
	const TOOL_KEYS: Record<string, Tool> = {
		g: 'recorder',
		e: 'eyes',
		b: 'benchmark',
		k: 'collector',
		t: 'test',
		y: 'train'
	};

	/**
	 * The research tools save to the dev server, so they only exist there, and the live site never
	 * downloads them.
	 */
	const devTools = import.meta.env.DEV
		? Promise.all([
				import('../lib/stages/AccuracyTest.svelte'),
				import('../lib/stages/Benchmark.svelte'),
				import('../lib/stages/Collector.svelte'),
				import('../lib/stages/EyeCompare.svelte'),
				import('../lib/stages/Recorder.svelte')
			]).then(([a, b, c, e, r]) => ({
				AccuracyTest: a.default,
				Benchmark: b.default,
				Collector: c.default,
				EyeCompare: e.default,
				Recorder: r.default
			}))
		: null;

	/** Asks to join a room, from a shared link. */
	const roomLink = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? null;
	let roomRequest = $state<{ join: string } | null>(roomLink ? { join: roomLink } : null);
	/** The instructions run once, before whatever the player opens first. */
	let taught = false;
	let afterInstructions: MenuChoice = 'multiplayer';
	/** The gate goes straight to the lesson for the demo's next person, not to the menu. */
	let demoRestarted = false;

	let stage = $state<Stage>('gate');
	let localUno = $state<GameSession<UnoView, UnoAction> | null>(null);
	let localScrabble = $state<GameSession<ScrabbleView, ScrabbleAction> | null>(null);
	// A fresh script each time its stage opens, and stopped when it closes.
	let demoUno = $state<GameSession<UnoView, UnoAction> | null>(null);
	let demoScrabble = $state<GameSession<ScrabbleView, ScrabbleAction> | null>(null);
	let hud = $state(false);
	let tool = $state<Tool | null>(null);
	/** The moving pointer would pull the eyes off the dot being measured. */
	let eyesMeasuring = $state(false);
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
			if (demoRestarted) {
				demoRestarted = false;
				stage = 'instructions';
			} else if (!roomRequest) stage = 'menu';
			else stage = returningToRoom() ? 'room' : 'instructions';
		} else if (stage === 'instructions') {
			taught = true;
			open(afterInstructions);
		} else if (stage === 'uno') {
			closeLocalGames();
			demoScrabble = createDemoScrabble();
			stage = 'scrabble';
		}
	}

	function closeLocalGames() {
		localUno?.close();
		localScrabble?.close();
		demoUno?.close();
		demoScrabble?.close();
		localUno = null;
		localScrabble = null;
		demoUno = null;
		demoScrabble = null;
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
				demoUno = createDemoUno();
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

	/**
	 * Every restart is a new person, so nothing learned about the last one carries over: they nod
	 * to take control, then get the lesson and the demo.
	 */
	function restartDemo() {
		session.event('menu', { choice: 'demo-restart' });
		handoff();
		afterInstructions = 'demo';
		demoRestarted = true;
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

	function openTool(next: Tool) {
		if (!import.meta.env.DEV) return;
		// The accuracy test waits for the player to take control. The others start straight away.
		if (next !== 'test' && next !== 'train') engine.lockFirst();
		hud = false;
		tool = next;
	}

	/** Only closes the tool that asked, in case another has opened since. */
	function closeTool(which: Tool) {
		if (tool !== which) return;
		tool = null;
		eyesMeasuring = false;
	}

	function handoff() {
		closeLocalGames();
		engine.release();
		taught = false;
		demoRestarted = false;
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
			if (tool && tool !== 'benchmark') {
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
		// Browser and system shortcuts, like find or reload, stay theirs.
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const typing = e.target instanceof Element && !!e.target.closest('input, textarea, select');
		// The collector has keys of its own.
		if (typing || tool === 'collector') return;
		if (!hud && !OPEN_KEYS.has(e.key)) return;
		if (import.meta.env.DEV && Object.hasOwn(TOOL_KEYS, e.key)) {
			openTool(TOOL_KEYS[e.key]);
			e.preventDefault();
			return;
		}
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
			case 'm':
				markMistake();
				break;
			case 'c':
				engine.recenter();
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
			default:
				return;
		}
		e.preventDefault();
	}
</script>

<svelte:window
	onkeydown={onKeydown}
	onblur={() => setAway(true)}
	onfocus={() => setAway(false)}
/>
<svelte:document onvisibilitychange={() => setAway(document.hidden)} />

<main
	class="h-screen w-screen overflow-hidden bg-slate-950 text-white"
	style:--press={engine.nodProgress}
>
	{#if devTools && tool === 'benchmark'}
		{#await devTools then t}
			<t.Benchmark onClose={() => closeTool('benchmark')} />
		{/await}
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

	{#if engine.problem}
		<div class="banner">
			{engine.problem}
		</div>
	{:else if engine.lock !== 'locked' && stage !== 'gate'}
		<div class="banner">
			{engine.lock === 'lost' ? 'Lost you. Face the screen and nod to take control.' : 'Nod to take control'}
		</div>
	{:else if engine.lock === 'locked' && !engine.inBounds}
		<div class="banner">
			Step back into view
		</div>
	{/if}
</main>

{#if smoothPointer.visible && !eyesMeasuring}
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
	<Hud
		onTest={(train) => openTool(train ? 'train' : 'test')}
		onRecord={() => openTool('recorder')}
		onClose={() => (hud = false)}
	/>
{/if}

{#if devTools && tool && tool !== 'benchmark'}
	{#await devTools then t}
		<!-- Keyed, so switching tools always closes the old one before the next one starts. -->
		{#key tool}
			{#if tool === 'collector'}
				<t.Collector onClose={() => closeTool('collector')} />
			{:else if tool === 'eyes'}
				<t.EyeCompare bind:measuring={eyesMeasuring} onClose={() => closeTool('eyes')} />
			{:else if tool === 'recorder'}
				<t.Recorder onClose={() => closeTool('recorder')} />
			{:else if tool === 'test' || tool === 'train'}
				{@const which = tool}
				<t.AccuracyTest train={which === 'train'} onClose={() => closeTool(which)} />
			{/if}
		{/key}
	{/await}
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
