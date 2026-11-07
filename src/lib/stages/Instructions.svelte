<script lang="ts">
	import { onDestroy } from 'svelte';
	import { target, targets } from '../input/targets.svelte';
	import { engine } from '../vision/engine.svelte';
	import Confetti from './Confetti.svelte';
	import GameExit from './GameExit.svelte';
	import HeadCue from './HeadCue.svelte';

	let { onDone, onExit }: { onDone: () => void; onExit: () => void } = $props();

	const spots = [
		{ x: 10, y: 20 },
		{ x: 90, y: 20 },
		{ x: 90, y: 58 },
		{ x: 10, y: 58 },
		{ x: 50, y: 58 }
	];
	/** The pointer wobbles over a card's edge, and the picture shouldn't restart each time it does. */
	const LEFT_GOAL_MS = 500;
	/** Nobody gets stuck if their shake doesn't register. */
	const SHAKE_PATIENCE_MS = 8000;
	/** Long enough to watch the tile land, and for the head to settle before there's a nod to catch. */
	const AFTER_SHAKE_MS = 1100;
	const RACK = ['N', 'O', 'D', null, 'L', 'E'];
	/** The corner cards are done with the pointer hidden, so the head turns the way it naturally would. */
	const BLIND_CARDS = 4;
	/** How long the picture shows turning, before it shows the nod. */
	const TURN_FIRST_MS = 1600;
	/** Nods that didn't follow a head turn before the card moves on anyway, teaching us nothing. */
	const BLIND_TRIES = 3;

	let step = $state(0);
	let leaving = $state(false);
	/** A nod anywhere counts on these cards, because the player has no pointer to aim with. */
	const blind = $derived(engine.headCalibrating);
	let turning = $state(true);
	let tries = $state(0);
	const finished = $derived(step >= spots.length);
	/** Fills as the head moves, and is full once the nod is big enough to count. */
	const nodMeter = $derived(targets.focused || blind ? engine.nodProgress : 0);
	const needsAim = $derived(!finished && targets.missedNods > 0 && !targets.focused);

	const goal = $derived(finished ? 'start' : `spot-${step}`);
	let reached = $state<string | null>(null);
	const onGoal = $derived(reached === goal);

	let shaken = $state(false);
	let canStart = $state(false);

	const cue = $derived.by(() => {
		if (blind) return turning ? 'point' : 'nod';
		if (onGoal) return 'nod';
		if (!finished) return 'point';
		return 'shake';
	});
	const word = $derived.by(() => {
		if (blind) return turning ? 'Turn to the card' : 'Nod';
		if (onGoal) return 'Nod';
		if (finished) return 'Shake';
		return needsAim ? 'Aim first' : 'Turn your head';
	});

	targets.missedNods = 0;
	engine.beginHeadCalibration();
	onDestroy(() => engine.endHeadCalibration());

	function blindNod(onset: number) {
		const spot = spots[step];
		const point = { x: (spot.x / 100) * innerWidth, y: (spot.y / 100) * innerHeight };
		if (!engine.addHeadPose(point, onset) && tries + 1 < BLIND_TRIES) {
			tries += 1;
			turning = true;
			return;
		}
		tries = 0;
		step += 1;
		turning = true;
		if (step >= BLIND_CARDS) {
			engine.endHeadCalibration();
			targets.missedNods = 0;
		}
	}

	$effect(() => {
		if (!blind || leaving) return;
		targets.onBareNod = blindNod;
		return () => (targets.onBareNod = null);
	});

	$effect(() => {
		if (!blind || !turning) return;
		const timer = setTimeout(() => (turning = false), TURN_FIRST_MS);
		return () => clearTimeout(timer);
	});

	$effect(() => {
		if (targets.focused === goal) {
			reached = goal;
			return;
		}
		const timer = setTimeout(() => (reached = null), LEFT_GOAL_MS);
		return () => clearTimeout(timer);
	});

	// The shake only sends the tile home. A nod on Let's play is what moves on.
	$effect(() => (finished && !leaving ? targets.claimCancel(() => (shaken = true)) : undefined));

	$effect(() => {
		if (!finished) return;
		const timer = setTimeout(() => (canStart = true), shaken ? AFTER_SHAKE_MS : SHAKE_PATIENCE_MS);
		return () => clearTimeout(timer);
	});
</script>

<div class="relative h-full w-full">
	{#if !shaken}
		<div class="lesson" class:invisible={leaving}>
			<div class="meter" class:shown={cue === 'nod'} aria-hidden="true">
				<div class="fill" class:full={nodMeter >= 1} style:height="{nodMeter * 100}%"></div>
			</div>
			<HeadCue gesture={cue} size="min(34vw, 52vh)" />
			<p class="word" class:warn={needsAim}>{word}</p>
		</div>
	{/if}

	{#if finished}
		<div class="practice-row" class:invisible={leaving}>
			<div class="practice" class:alone={!canStart} class:shaken aria-hidden="true">
				<div class="board">
					{#each { length: 18 }, i (i)}
						<span class="square"></span>
					{/each}
				</div>
				<div class="rack">
					{#each RACK as letter, i (i)}
						<span class="square" class:rack-tile={letter}>{letter}</span>
					{/each}
				</div>
				<span class="tile" class:home={shaken}>D</span>
			</div>
			<div class="start-slot">
				{#if canStart}
					<button
						use:target={{ id: 'start', legal: !leaving, confirm: onDone }}
						class="start"
						class:focused={targets.focused === 'start'}
					>
						Let's play
					</button>
				{/if}
			</div>
		</div>
	{/if}

	{#if shaken}
		<Confetti />
	{/if}

	<GameExit show bind:leaving {onExit} question="Leave the lesson?" stay="✕ Keep going" bottom />

	{#each spots as spot, i (i)}
		<button
			use:target={{
				id: `spot-${i}`,
				legal: step === i && !leaving && !blind,
				calib: true,
				confirm: () => (step = i + 1)
			}}
			class="absolute h-44 w-32 -translate-x-1/2 -translate-y-1/2 rounded-xl border-4 text-5xl font-bold transition-all"
			class:glow={step === i}
			class:focused={targets.focused === `spot-${i}`}
			class:done={step > i}
			class:idle={step < i}
			class:gone={finished}
			style:left="{spot.x}%"
			style:top="{spot.y}%"
			aria-label="Card {i + 1}"
		>
			{step > i ? '✓' : ''}
		</button>
	{/each}
</div>

<style>
	/* Between the top cards and above the middle one, so nothing in it can cover a target. */
	.lesson {
		position: absolute;
		top: 3vh;
		inset-inline: calc(10% + 5rem);
		z-index: 1;
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		gap: 1.5rem;
		pointer-events: none;
	}
	.word {
		width: min-content;
		font-size: 3.4rem;
		font-weight: 800;
		line-height: 1.1;
	}
	.word.warn {
		color: #fbbf24;
	}
	/* Beside the head and filling downward, the way a nod goes. */
	.meter {
		justify-self: end;
		height: 32vh;
		width: 1.6rem;
		overflow: hidden;
		border-radius: 0.8rem;
		background: #1e293b;
		visibility: hidden;
	}
	.meter.shown {
		visibility: visible;
	}
	.fill {
		width: 100%;
		background: #fbbf24;
		transition: height 60ms linear;
	}
	.fill.full {
		background: #34d399;
	}

	.practice-row {
		--cell: 7.4vh;
		--gap: 0.5vh;
		--pad: 0.9vh;
		--rack-gap: 1.8vh;
		--start-width: 22rem;
		--row-gap: 4vw;
		position: absolute;
		inset-inline: 0;
		top: 47vh;
		display: flex;
		justify-content: center;
		align-items: center;
		gap: var(--row-gap);
	}
	.practice {
		position: relative;
		transition: transform 400ms ease-out;
		pointer-events: none;
	}
	/* Centred under the picture until there is a button beside it. */
	.practice.alone {
		transform: translateX(calc((var(--start-width) + var(--row-gap)) / 2));
	}
	.board,
	.rack {
		display: grid;
		grid-template-columns: repeat(6, var(--cell));
		gap: var(--gap);
		padding: var(--pad);
		border-radius: 1vh;
	}
	.board {
		background: #1e293b;
	}
	.rack {
		margin-top: var(--rack-gap);
		background: #475569;
		transition:
			background 200ms,
			box-shadow 200ms;
	}
	.practice.shaken .rack {
		background: #065f46;
		box-shadow: 0 0 0 4px #34d399;
	}
	.square {
		display: grid;
		place-items: center;
		height: var(--cell);
		border-radius: 0.6vh;
		background: #334155;
	}
	.rack .square {
		background: #1e293b;
	}
	.rack .rack-tile,
	.tile {
		font-size: 4vh;
		font-weight: 800;
		color: #0f172a;
	}
	.rack .rack-tile {
		background: #cbd5e1;
	}
	/* Second row of the board, and flies to the gap in the rack, which it completes. */
	.tile {
		--to-x: calc((var(--cell) + var(--gap)) * 2);
		--to-y: calc(var(--cell) * 2 + var(--gap) + var(--pad) * 2 + var(--rack-gap));
		position: absolute;
		left: calc(var(--pad) + var(--cell) + var(--gap));
		top: calc(var(--pad) + var(--cell) + var(--gap));
		display: grid;
		place-items: center;
		height: var(--cell);
		width: var(--cell);
		border-radius: 0.6vh;
		background: #fde047;
		box-shadow: 0 0 0 3px white;
	}
	.tile.home {
		transform: translate(var(--to-x), var(--to-y));
	}

	.start-slot {
		height: 6rem;
		width: var(--start-width);
	}
	.start {
		height: 100%;
		width: 100%;
		border-radius: 1rem;
		border: 5px solid white;
		background: #047857;
		font-size: 2.2rem;
		font-weight: 800;
	}

	.glow {
		background: #f59e0b;
		border-color: #fde68a;
		box-shadow: 0 0 50px 12px rgb(251 191 36 / 0.7);
	}
	/* Lights up only while the pointer is on it, so a nod clearly has something to land on. */
	.focused {
		background: #fde047;
		border-color: white;
		color: #0f172a;
		box-shadow:
			0 0 0 6px white,
			0 0 70px 22px rgb(253 224 71 / 0.9);
		transform: translateY(calc(var(--press, 0) * 1.2rem)) scale(calc(1.1 - var(--press, 0) * 0.08));
	}
	.done {
		background: #065f46;
		border-color: #34d399;
		color: #a7f3d0;
	}
	.idle {
		background: #1e293b;
		border-color: #334155;
	}
	/* Only the shake practice is on screen by then. */
	.gone {
		opacity: 0;
	}

	@media (prefers-reduced-motion: no-preference) {
		.tile:not(.home) {
			animation: waiting 1.1s ease-in-out infinite;
		}
		.tile.home {
			animation: fly-home 750ms ease-in-out;
		}
		.start {
			animation: arrive 350ms ease-out;
		}
		.practice.shaken .rack .rack-tile {
			animation: cheer 500ms 650ms ease-out;
		}
	}
	@keyframes waiting {
		0%,
		100% {
			box-shadow: 0 0 0 3px white;
		}
		50% {
			box-shadow:
				0 0 0 3px white,
				0 0 22px 8px rgb(251 191 36 / 0.8);
		}
	}
	@keyframes fly-home {
		0% {
			transform: translate(0, 0);
		}
		45% {
			transform: translate(calc(var(--to-x) * 0.4), calc(var(--cell) * -1.1)) scale(1.5) rotate(-14deg);
		}
		85% {
			transform: translate(var(--to-x), var(--to-y)) scale(0.95);
		}
		100% {
			transform: translate(var(--to-x), var(--to-y));
		}
	}
	@keyframes arrive {
		from {
			opacity: 0;
			scale: 0.7;
		}
	}
	@keyframes cheer {
		40% {
			transform: translateY(-0.9vh);
		}
	}
</style>
