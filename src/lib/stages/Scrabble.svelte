<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { smoothPointer } from '../input/smoothPointer.svelte';
	import { target, targets, type ConfirmContext } from '../input/targets.svelte';
	import {
		premiumAt as premium,
		SIZE,
		tileValue,
		type ScrabbleAction,
		type ScrabbleView
	} from '../games/scrabble/engine';
	import { session as log } from '../session';
	import type { GameSession } from '../session/types';
	import { engine } from '../vision/engine.svelte';
	import Confetti from './Confetti.svelte';
	import GameExit from './GameExit.svelte';
	import HeadCue from './HeadCue.svelte';

	let {
		session,
		onExit,
		restartDemo
	}: {
		session: GameSession<ScrabbleView, ScrabbleAction>;
		onExit: () => void;
		/** In the demo, the corner button and the end of the game start it over. */
		restartDemo?: () => void;
	} = $props();

	const PREMIUM_COLOR = { TW: '#b91c1c', DW: '#be7c8c', TL: '#1d4ed8', DL: '#60a5fa' };
	const DEFAULT_ZOOM = 5;
	const CENTRE = 7;
	/** A stray nod just after the game ends must not choose what happens next. */
	const END_BUTTONS_DELAY_MS = 1500;
	const PLAY_HOLD_MS = 1500;
	/** The two-step picker for a blank: a group of letters, then the letter. */
	const LETTER_GROUPS = ['ABCDE', 'FGHIJ', 'KLMNO', 'PQRST', 'UVWXYZ'];

	type Placed = { r: number; c: number; letter: string; tileId: number; blank: boolean };
	type Stage = 'idle' | 'held' | 'zoom' | 'blank' | 'swap' | 'pass' | 'done';

	const snap = $derived($session);
	const view = $derived(snap.view);
	const rack = $derived(view.rack);
	const committed = $derived(view.board);
	const fullGame = $derived(snap.showOpponents);

	let pending = $state<Placed[]>([]);
	let stage = $state<Stage>('idle');
	let heldIndex = $state<number | null>(null);
	/** The letter a held blank stands for. */
	let blankLetter = $state<string | null>(null);
	let blankGroup = $state<string | null>(null);
	let swapping = $state<number[]>([]);
	let zoom = $state<{ r0: number; c0: number; n: number } | null>(null);
	let zoomSize = $state(DEFAULT_ZOOM);
	let message = $state('');
	let boardEl = $state<HTMLElement>();
	let leaving = $state(false);
	let endButtons = $state(false);
	/** Just after backing out, when Play has appeared under the pointer and must not take a nod. */
	let playHeld = $state(false);
	/** Sent and waiting for an answer, so a second nod can't send the same play twice. */
	let submitted = $state(false);
	/** Squares from the last move, so a new word stands out for a moment. */
	let recent = $state<string[]>([]);

	const pendingAt = (r: number, c: number) => pending.find((p) => p.r === r && p.c === c);
	const letterAt = (r: number, c: number) => committed[`${r},${c}`]?.letter ?? pendingAt(r, c)?.letter;
	const blankAt = (r: number, c: number) => committed[`${r},${c}`]?.blank ?? pendingAt(r, c)?.blank ?? false;
	const rackUsed = (i: number) => pending.some((p) => p.tileId === rack[i]?.id);
	const heldTile = $derived(heldIndex === null ? null : rack[heldIndex]);
	const heldLetter = $derived(heldTile ? (heldTile.letter === '?' ? blankLetter : heldTile.letter) : null);
	const myTurn = $derived(view.can.place && !submitted && !leaving);
	const boardEmpty = $derived(Object.keys(committed).length === 0);
	const canPlay = $derived(stage === 'idle' && pending.length > 0 && myTurn && !playHeld);

	// A shake takes back one tile: the one being held, or else the last one placed. It never does
	// anything else, so a head drifting while the player thinks can't lose them more than that.
	const releaseCancel = targets.claimCancel(() => {
		if (submitted || leaving) return;
		if (stage === 'held' || stage === 'zoom' || stage === 'blank') {
			putBack();
		} else if (stage === 'idle' && pending.length) {
			message = '';
			pending = pending.slice(0, -1);
		}
	});
	onDestroy(releaseCancel);

	function clearHold() {
		heldIndex = null;
		blankLetter = null;
		blankGroup = null;
		zoom = null;
	}

	/** The held tile goes straight back on the rack, however far it had got. */
	function putBack() {
		message = '';
		stage = 'idle';
		clearHold();
		playHeld = pending.length > 0;
	}

	// Tiles leave the pending play once the session has taken them off the rack.
	$effect(() => {
		const ids = new Set(view.rack.map((t) => t.id));
		untrack(() => {
			if (pending.some((p) => !ids.has(p.tileId))) {
				pending = pending.filter((p) => ids.has(p.tileId));
			}
		});
	});

	// A refused play stays on the board, with the reason and how to fix it.
	// Keyed on the count, because each session update is a new object and must not repeat this.
	const rejectedCount = $derived(snap.rejected?.n ?? 0);
	$effect(() => {
		if (!rejectedCount) return;
		untrack(() => {
			const rejected = snap.rejected!;
			log.event('rejected', { reason: rejected.reason });
			submitted = false;
			const hint = /connect to the board|centre|connection|not connected/i.test(rejected.reason)
				? ''
				: rejected.reason.includes('dictionary')
					? ' Shake to take a tile back.'
					: ' Shake to take one back.';
			message = `${rejected.reason}${hint}`;
		});
	});

	// Whatever just landed on the board gets a glow, and the move goes in the session log.
	let knownSquares: Set<string> | null = null;
	$effect(() => {
		const squares = Object.keys(committed);
		untrack(() => {
			const known = knownSquares;
			knownSquares = new Set(squares);
			if (!known) return;
			const fresh = squares.filter((key) => !known.has(key));
			if (fresh.length) recent = fresh;
		});
	});

	const lastKey = $derived(JSON.stringify(view.last));
	let loggedKey: string | undefined;
	$effect(() => {
		const key = lastKey;
		untrack(() => {
			if (key !== loggedKey && view.last) {
				// However it ended, the move in flight has been answered.
				submitted = false;
				if (view.last.kind === 'place') {
					log.event('played', { word: view.last.word, gained: view.last.score, seat: view.last.seat });
				} else {
					log.event('turn', { ...view.last });
				}
			}
			loggedKey = key;
		});
	});

	const hasEnded = $derived(!!snap.ended);
	$effect(() => {
		const ended = hasEnded;
		untrack(() => {
			if (ended) {
				stage = 'done';
				clearHold();
				pending = [];
				return;
			}
			if (stage === 'done') {
				stage = 'idle';
				message = '';
				recent = [];
			}
		});
		if (!ended) {
			endButtons = false;
			return;
		}
		const timer = setTimeout(() => (endButtons = true), END_BUTTONS_DELAY_MS);
		return () => clearTimeout(timer);
	});

	function closeStep() {
		message = '';
		if (stage === 'zoom') {
			stage = 'held';
			zoom = null;
		} else if (stage === 'held') {
			putBack();
		}
	}

	$effect(() => {
		if (!playHeld) return;
		const timer = setTimeout(() => (playHeld = false), PLAY_HOLD_MS);
		return () => clearTimeout(timer);
	});

	/**
	 * Squares that couldn't be part of a play are dimmed as a guide. They can still be chosen, so
	 * the selection never jumps away from where the player is pointing. New tiles share a line
	 * with each other, and with a tile already on the board.
	 */
	function squareIsPlayable(r: number, c: number) {
		if (letterAt(r, c)) return false;
		if (pending.length === 1) return pending[0].r === r || pending[0].c === c;
		if (pending.length > 1) {
			return pending[0].r === pending[1].r ? pending[0].r === r : pending[0].c === c;
		}
		// The first word of a game has to cross the centre.
		if (boardEmpty) return r === CENTRE || c === CENTRE;
		return Object.keys(committed).some((key) => {
			const [kr, kc] = key.split(',').map(Number);
			return kr === r || kc === c;
		});
	}

	function pointToCell(p: { x: number; y: number }) {
		const rect = boardEl!.getBoundingClientRect();
		const clamp = (v: number) => Math.max(0, Math.min(SIZE - 1, v));
		return {
			r: clamp(Math.floor(((p.y - rect.top) / rect.height) * SIZE)),
			c: clamp(Math.floor(((p.x - rect.left) / rect.width) * SIZE))
		};
	}

	/**
	 * Zooms about the pointed-at square, so it stays under the pointer and the player doesn't have
	 * to aim again. It sits as far across the zoomed view as it does across the whole board.
	 */
	function zoomAround(r: number, c: number) {
		const start = (v: number) => Math.round((v + 0.5) * (1 - zoomSize / SIZE));
		return { r0: start(r), c0: start(c), n: zoomSize };
	}

	function pickTile(i: number) {
		heldIndex = i;
		message = '';
		if (rack[i].letter === '?') {
			blankLetter = null;
			blankGroup = null;
			stage = 'blank';
			return;
		}
		goToBoard();
	}

	function goToBoard() {
		const last = pending[pending.length - 1];
		if (!last) {
			stage = 'held';
			return;
		}
		// The next tile almost always goes beside the last one, so save a nod and open there.
		const start = (v: number) => Math.max(0, Math.min(SIZE - zoomSize, v - Math.floor(zoomSize / 2)));
		zoom = { r0: start(last.r), c0: start(last.c), n: zoomSize };
		stage = 'zoom';
		log.event('zoom', { r: last.r, c: last.c, ...zoom, auto: true });
	}

	function chooseBlank(letter: string) {
		blankLetter = letter;
		blankGroup = null;
		log.event('blank', { letter });
		goToBoard();
	}

	function closeBlank() {
		if (blankGroup) {
			blankGroup = null;
			return;
		}
		stage = 'idle';
		clearHold();
	}

	function openZoom(ctx: ConfirmContext) {
		const { r, c } = pointToCell(ctx.point ?? { x: innerWidth / 2, y: innerHeight / 2 });
		zoom = zoomAround(r, c);
		stage = 'zoom';
		log.event('zoom', { r, c, ...zoom, x: ctx.point?.x, y: ctx.point?.y });
	}

	function placeAt(r: number, c: number) {
		if (!heldTile || !heldLetter) return;
		log.event('place', { r, c, letter: heldLetter });
		pending = [
			...pending,
			{ r, c, letter: heldLetter, tileId: heldTile.id, blank: heldTile.letter === '?' }
		];
		clearHold();
		stage = 'idle';
	}

	function playWord() {
		submitted = true;
		message = '';
		session.send({
			type: 'place',
			tiles: pending.map(({ r, c, letter, tileId }) => ({ r, c, letter, tileId }))
		});
	}

	function passTurn() {
		stage = 'idle';
		message = '';
		session.send({ type: 'pass' });
	}

	function startSwap() {
		swapping = [];
		message = '';
		stage = 'swap';
	}

	function toggleSwap(id: number) {
		swapping = swapping.includes(id) ? swapping.filter((x) => x !== id) : [...swapping, id];
	}

	function confirmSwap() {
		const tileIds = swapping;
		swapping = [];
		stage = 'idle';
		session.send({ type: 'exchange', tileIds });
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === '-') zoomSize = Math.min(9, zoomSize + 1);
		if (e.key === '=') zoomSize = Math.max(3, zoomSize - 1);
	}

	const prompt = $derived(
		stage === 'done'
			? 'You did it'
			: stage === 'swap'
				? 'Nod at the tiles to swap, then point at Swap'
				: stage === 'pass'
					? 'Pass your turn?'
					: stage === 'blank'
						? blankGroup
							? 'Which letter should this blank be? Shake to put it back'
							: 'Pick a group of letters for this blank, or shake to put it back'
						: stage === 'held'
							? `Point where ${heldLetter} should go and nod to zoom in, or shake to put it back`
							: stage === 'zoom'
								? 'Point at a square and nod to place it, or shake to put it back'
								: !view.can.place
									? `${snap.names[view.current] ?? 'They'} is thinking`
									: pending.length
										? 'Pick another tile, point at Play and nod, or shake to undo'
										: boardEmpty
											? 'Pick a tile. The first word must cross the centre square'
											: 'Point your head at a tile and nod to pick it up'
	);

	const headline = $derived.by(() => {
		if (snap.ended) return fullGame ? `${snap.ended.title} ${snap.ended.text}` : snap.ended.text;
		if (message) return message;
		if (fullGame && snap.note && stage === 'idle' && !pending.length) return `${snap.note}. ${prompt}`;
		return prompt;
	});

	// While holding a tile, show the area that will open when they nod.
	const zoomPreview = $derived.by(() => {
		if (stage !== 'held' || !boardEl) return null;
		const p = engine.pointer;
		if (!p) return null;
		const { r, c } = pointToCell(p);
		return zoomAround(r, c);
	});

	// What the player could see, so the session log says what they were trying to do.
	$effect(() => {
		log.event('game', {
			game: 'scrabble',
			stage,
			holding: heldLetter,
			placed: pending.map((p) => `${p.letter}@${p.r},${p.c}`),
			rack: rack.filter((_, i) => !rackUsed(i)).map((t) => t.letter).join(''),
			score: view.scores[view.me],
			scores: view.scores,
			current: view.current,
			bag: view.bagCount,
			says: headline
		});
	});

	// The lesson taught nodding. This is the one thing the demo still shows, while a shake would work.
	const shakeCue = $derived.by(() => {
		if (fullGame || !myTurn) return null;
		if (stage === 'held' || stage === 'zoom') return 'Shake to put back';
		if (stage === 'idle' && pending.length) return 'Shake to undo';
		return null;
	});

	const cameraStyle = $derived(
		zoom
			? `transform: scale(${SIZE / zoom.n}) translate(${(-zoom.c0 / SIZE) * 100}%, ${(-zoom.r0 / SIZE) * 100}%)`
			: 'transform: none'
	);
</script>

<svelte:window onkeydown={onKeydown} />

<div class="table">
	<p class="headline" class:done={stage === 'done'}>{headline}</p>

	<div class="rack">
		{#each rack as tile, i (tile.id)}
			{@const available = stage === 'swap' || (stage === 'idle' && myTurn && !rackUsed(i))}
			<button
				use:target={{
					id: `rack-${i}`,
					legal: available && !leaving,
					calib: true,
					confirm: () => (stage === 'swap' ? toggleSwap(tile.id) : pickTile(i))
				}}
				class="rack-tile"
				class:gone={rackUsed(i) || heldIndex === i}
				class:off={!available}
				class:chosen={swapping.includes(tile.id)}
				class:focused={targets.focused === `rack-${i}`}
			>
				{tile.letter === '?' ? '' : tile.letter}<sub>{tileValue(tile.letter)}</sub>
			</button>
		{/each}
	</div>

	{#if fullGame}
		<!-- One each side of the board, level with its middle: far from the rack and from each other. -->
		{#if stage === 'pass'}
			<button
				use:target={{ id: 'pass-no', legal: !leaving, confirm: () => (stage = 'idle') }}
				class="action close side-left"
				class:focused={targets.focused === 'pass-no'}
			>
				✕ Keep turn
			</button>
			<button
				use:target={{ id: 'pass-yes', legal: !leaving, confirm: passTurn }}
				class="action side-right bg-slate-600"
				class:focused={targets.focused === 'pass-yes'}
			>
				Yes, pass
			</button>
		{:else if stage === 'swap'}
			<button
				use:target={{ id: 'swap-no', legal: !leaving, confirm: () => (stage = 'idle') }}
				class="action close side-left"
				class:focused={targets.focused === 'swap-no'}
			>
				✕ Cancel
			</button>
			<button
				use:target={{ id: 'swap-yes', legal: swapping.length > 0 && !leaving, confirm: confirmSwap }}
				class="action side-right bg-slate-600"
				class:off={swapping.length === 0}
				class:focused={targets.focused === 'swap-yes'}
			>
				Swap {swapping.length || ''}
			</button>
		{:else if stage !== 'done'}
			{@const canAct = stage === 'idle' && myTurn && pending.length === 0}
			<button
				use:target={{ id: 'pass', legal: canAct && view.can.pass, confirm: () => (stage = 'pass') }}
				class="action side-left bg-slate-600"
				class:off={!(canAct && view.can.pass)}
				class:focused={targets.focused === 'pass'}
			>
				Pass
			</button>
			<button
				use:target={{ id: 'exchange', legal: canAct && view.can.exchange, confirm: startSwap }}
				class="action side-right bg-slate-600"
				class:off={!(canAct && view.can.exchange)}
				class:focused={targets.focused === 'exchange'}
			>
				Exchange
			</button>
		{/if}
	{/if}

	<div
		{@attach (el) => {
			boardEl = el;
		}}
		use:target={{ id: 'board', legal: stage === 'held' && !leaving, confirm: openZoom }}
		class="board"
		class:ready={stage === 'held'}
	>
		<div class="camera" style={cameraStyle}>
			{#each { length: SIZE * SIZE } as _, i (i)}
				{@const r = Math.floor(i / SIZE)}
				{@const c = i % SIZE}
				{@const letter = letterAt(r, c)}
				{@const pr = premium(r, c)}
				<div class="cell" style:background={pr ? PREMIUM_COLOR[pr] : null}>
					{#if letter}
						<div
							class="tile"
							class:new={!!pendingAt(r, c)}
							class:recent={recent.includes(`${r},${c}`)}
							class:blank={blankAt(r, c)}
							in:scale={{ start: 1.8, duration: 260 }}
						>
							{letter}<sub>{blankAt(r, c) ? 0 : tileValue(letter)}</sub>
						</div>
					{:else if pr}
						<span class="prem">{pr}</span>
					{/if}
				</div>
			{/each}
		</div>

		{#if zoomPreview}
			<div
				class="zoom-box"
				style:left="{(zoomPreview.c0 / SIZE) * 100}%"
				style:top="{(zoomPreview.r0 / SIZE) * 100}%"
				style:width="{(zoomPreview.n / SIZE) * 100}%"
				style:height="{(zoomPreview.n / SIZE) * 100}%"
			></div>
		{/if}

		{#if zoom}
			{@const z = zoom}
			<div
				class="overlay"
				in:fade={{ duration: 150, delay: 280 }}
				style="grid-template-columns:repeat({z.n},1fr);grid-template-rows:repeat({z.n},1fr)"
			>
				{#each { length: z.n * z.n } as _, i (i)}
					{@const r = z.r0 + Math.floor(i / z.n)}
					{@const c = z.c0 + i % z.n}
					{@const playable = squareIsPlayable(r, c)}
					<button
						use:target={{
							id: `cell-${r}-${c}`,
							legal: !letterAt(r, c) && !leaving,
							exact: true,
							confirm: () => placeAt(r, c)
						}}
						class="spot"
						class:blocked={!playable && !letterAt(r, c)}
						class:focused={targets.focused === `cell-${r}-${c}`}
						aria-label="Row {r + 1} column {c + 1}"
					>
						{#if targets.focused === `cell-${r}-${c}`}
							<span class="ghost">{heldLetter}</span>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<div class="scores-area">
		{#if fullGame}
			<div class="scores">
				{#each view.scores as score, seat (seat)}
					<p class:turn={view.current === seat && !snap.ended} class="font-bold">
						<span>{seat === view.me ? 'You' : snap.names[seat]}</span>
						<span>{score}</span>
					</p>
				{/each}
				<p class="bag">{view.bagCount} in the bag</p>
			</div>
		{:else}
			<p class="text-center text-3xl font-bold">Score {view.scores[view.me]}</p>
		{/if}
	</div>

	{#if shakeCue}
		<div class="cue cue-left" transition:fade={{ duration: 150 }}>
			<HeadCue gesture="shake" size="var(--cue)" />
			<p>{shakeCue}</p>
		</div>
	{/if}

	<!-- For anyone whose shake doesn't register, and the only way to a far square once zoomed. -->
	<button
		use:target={{ id: 'close', legal: (stage === 'held' || stage === 'zoom') && !leaving, confirm: closeStep }}
		class="action close back-corner"
		class:gone={stage !== 'held' && stage !== 'zoom'}
		class:focused={targets.focused === 'close'}
	>
		<span>✕</span>
		{stage === 'zoom' ? 'Zoom out' : 'Put back'}
	</button>

	{#if stage === 'done'}
		{@const again = restartDemo ?? (snap.canRestart && session.restart ? () => session.restart?.() : null)}
		{#if again}
			<button
				use:target={{ id: 'again', legal: endButtons, confirm: again }}
				class="action far-corner bg-emerald-700"
				class:off={!endButtons}
				class:focused={targets.focused === 'again'}
			>
				{restartDemo ? '↺ Restart' : 'Play again'}
			</button>
		{/if}
		<button
			use:target={{ id: 'menu', legal: endButtons, confirm: onExit }}
			class="action exit"
			class:far-corner={!again}
			class:menu-corner={!!again}
			class:off={!endButtons}
			class:focused={targets.focused === 'menu'}
		>
			✕ Menu
		</button>
	{:else}
		<button
			use:target={{ id: 'play', legal: canPlay, confirm: playWord }}
			class="action far-corner bg-emerald-700"
			class:off={!canPlay}
			class:focused={targets.focused === 'play'}
		>
			Play
		</button>
	{/if}
</div>

{#if snap.ended?.won}<Confetti />{/if}

<GameExit
	show={snap.canLeave && stage !== 'done' && stage !== 'blank'}
	bind:leaving
	onExit={restartDemo ?? onExit}
	question={restartDemo ? 'Restart the demo?' : undefined}
	label={restartDemo ? 'Restart' : undefined}
	icon={restartDemo ? '↺' : undefined}
/>

{#if stage === 'blank'}
	<div transition:fade={{ duration: 200 }} class="fixed inset-0 z-[5] bg-black/70"></div>
	<p class="pointer-events-none fixed inset-x-48 top-[11%] z-[6] text-center text-5xl font-bold text-balance">{prompt}</p>
	<button
		use:target={{ id: 'blank-close', legal: !leaving, confirm: closeBlank }}
		class="blank-close"
		class:focused={targets.focused === 'blank-close'}
	>
		✕ {blankGroup ? 'Back' : 'Put back'}
	</button>
	<div class="blank-row">
		{#if blankGroup}
			{#each [...blankGroup] as letter (letter)}
				<button
					use:target={{ id: `blank-${letter}`, legal: !leaving, confirm: () => chooseBlank(letter) }}
					class="blank-choice"
					class:focused={targets.focused === `blank-${letter}`}
				>
					{letter}
				</button>
			{/each}
		{:else}
			{#each LETTER_GROUPS as group (group)}
				<button
					use:target={{ id: `group-${group}`, legal: !leaving, confirm: () => (blankGroup = group) }}
					class="blank-choice group"
					class:focused={targets.focused === `group-${group}`}
				>
					{group[0]}–{group[group.length - 1]}
				</button>
			{/each}
		{/if}
	</div>
{/if}

{#if heldLetter && smoothPointer.visible && (stage === 'held' || stage === 'zoom')}
	<div
		class="carried"
		class:landing={targets.focused?.startsWith('cell-')}
		style:transform="translate({smoothPointer.x}px, {smoothPointer.y}px) translate(-50%, -120%)"
	>
		{heldLetter}<sub>{heldTile?.letter === '?' ? 0 : tileValue(heldLetter)}</sub>
	</div>
{/if}

<style>
	/*
	 * The pointer selects a target from up to 110px outside its edge (input/hitbox.ts), so targets
	 * that are legal together need 220px between them for those zones not to overlap. In pixels,
	 * because the reach is. 712px is what's left for the board's two margins when the close button
	 * (left) and the Leave button (right) both keep that distance from it.
	 */
	.table {
		--rack-tile: min(5.5rem, 10vh);
		--board-top: calc(3.5rem + var(--rack-tile));
		--board: min(calc(100vh - var(--board-top) - 1rem), calc(100vw - 712px));
		--board-left: calc((100vw - var(--board) - 1.5rem) / 2);
		--cue: 15rem;
		position: relative;
		height: 100%;
		width: 100%;
	}
	.headline {
		position: absolute;
		left: 1.5rem;
		right: 16.5rem;
		top: 0.5rem;
		text-align: center;
		font-size: 1.5rem;
		font-weight: 600;
		line-height: 2rem;
	}
	/* The Leave button is gone by the end, so the word sits centred over the board like the rack. */
	.headline.done {
		left: 0;
		right: 1.5rem;
		color: #6ee7b7;
	}
	/* Up high to save the neck, and stopping 120px short of the Leave button. */
	/*
	 * Tile centres are 10vw apart, which is 2.4 degrees of head turn on any screen. Recordings put
	 * the good range at 9 to 11.5vw and don't settle it further. Centred over the board.
	 */
	.rack {
		position: absolute;
		left: 0;
		right: 1.5rem;
		top: 2.75rem;
		display: flex;
		justify-content: center;
		gap: calc(10vw - var(--rack-tile));
	}
	.board {
		position: absolute;
		left: var(--board-left);
		top: var(--board-top);
		height: var(--board);
		width: var(--board);
		overflow: hidden;
		border: 3px solid #475569;
		background: #0f172a;
		container-type: size;
		transition: box-shadow 150ms;
	}
	.board.ready {
		box-shadow: 0 0 30px 4px rgb(253 224 71 / 0.45);
	}
	/* A real camera move: the same board scales up, so the player keeps their bearings. */
	.camera {
		position: absolute;
		inset: 0;
		display: grid;
		grid-template-columns: repeat(15, 1fr);
		grid-template-rows: repeat(15, 1fr);
		gap: 1px;
		background: #475569;
		transform-origin: 0 0;
		transition: transform 380ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.cell {
		display: flex;
		min-height: 0;
		min-width: 0;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		background: #1e293b;
	}
	.tile {
		display: flex;
		height: 84%;
		width: 84%;
		border-radius: 12%;
		align-items: center;
		justify-content: center;
		background: #fcd34d;
		color: #1c1917;
		font-size: 2.7cqw;
		font-weight: 800;
	}
	.tile.new {
		background: #86efac;
	}
	.tile.recent {
		background: #fde68a;
		box-shadow: inset 0 0 0 2px #f59e0b;
	}
	.tile.blank {
		color: #b45309;
	}
	sub {
		font-size: 0.5em;
		font-weight: 600;
	}
	.prem {
		color: white;
		font-size: 1.4cqw;
		opacity: 0.8;
	}
	.zoom-box {
		position: absolute;
		border: 4px solid #fde047;
		background: rgb(253 224 71 / 0.16);
		pointer-events: none;
		transition:
			left 90ms linear,
			top 90ms linear;
	}
	.overlay {
		position: absolute;
		inset: 0;
		z-index: 2;
		display: grid;
	}
	.spot {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		transition: background 100ms;
	}
	.spot.blocked {
		background: rgb(2 6 23 / 0.55);
	}
	.spot.focused {
		background: rgb(253 224 71 / 0.25);
		box-shadow: inset 0 0 0 calc(5px + var(--press, 0) * 12px) #fde047;
		z-index: 1;
	}
	.ghost {
		display: flex;
		height: 76%;
		width: 76%;
		align-items: center;
		justify-content: center;
		border-radius: 0.5rem;
		background: #86efac;
		color: #1c1917;
		font-size: 3.4rem;
		font-weight: 800;
		transform: scale(calc(1 - var(--press, 0) * 0.14));
	}
	.action {
		height: 5.5rem;
		border-radius: 0.9rem;
		border: 4px solid white;
		font-size: 1.8rem;
		font-weight: 700;
		transition:
			transform 90ms ease-out,
			opacity 150ms;
	}
	.close {
		background: #b91c1c;
		font-size: 1.5rem;
	}
	/* In the corner, as far from the rack as it can be, so reaching for a letter can't land on Play. */
	.far-corner,
	.menu-corner {
		position: absolute;
		bottom: 1.5rem;
		height: 7rem;
		width: 13rem;
	}
	.far-corner {
		right: 1.5rem;
	}
	.menu-corner {
		left: 1.5rem;
	}
	.back-corner {
		position: absolute;
		bottom: 1.5rem;
		left: 1.5rem;
		display: flex;
		height: 7rem;
		width: 6rem;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		font-size: 1rem;
		line-height: 1.1;
	}
	.back-corner span {
		font-size: 2rem;
	}
	.side-left,
	.side-right {
		position: absolute;
		top: 48%;
		width: 12rem;
	}
	.side-left {
		left: 1.5rem;
	}
	.side-right {
		right: 1.5rem;
	}
	.scores-area {
		position: absolute;
		right: 1.5rem;
		top: var(--board-top);
		width: 12rem;
	}
	/* In the margins, between the things that can be selected. Pictures can't be, and don't catch it. */
	.cue {
		position: absolute;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		font-size: 1.25rem;
		font-weight: 700;
		color: #fde047;
		pointer-events: none;
		width: var(--cue);
	}
	.cue-left {
		left: calc((var(--board-left) - var(--cue)) / 2);
		top: calc(var(--board-top) + 2rem);
	}
	.exit {
		background: #334155;
		font-size: 1.5rem;
	}
	.scores p {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		border-radius: 0.5rem;
		padding: 0.2rem 0.6rem;
		font-size: 1.5rem;
	}
	.scores p.turn {
		background: rgb(251 191 36 / 0.2);
		box-shadow: 0 0 14px 2px rgb(251 191 36 / 0.5);
	}
	.scores .bag {
		justify-content: center;
		color: #94a3b8;
		font-size: 1rem;
		font-weight: 500;
	}
	.chosen {
		background: #86efac;
		outline: 5px solid #16a34a;
	}
	.blank-row {
		position: fixed;
		left: 3%;
		right: 3%;
		top: 38%;
		z-index: 6;
		display: flex;
		justify-content: center;
		gap: 8.4vw;
	}
	.blank-choice {
		height: 34vh;
		width: 8.8vw;
		border-radius: 1.2rem;
		border: 6px solid white;
		background: #fcd34d;
		color: #1c1917;
		font-size: 4.5rem;
		font-weight: 800;
		transition: transform 90ms ease-out;
	}
	.blank-choice.group {
		width: 12.5vw;
		font-size: 3rem;
	}
	.blank-close {
		position: fixed;
		right: 2rem;
		top: 1.5rem;
		z-index: 6;
		height: 6rem;
		width: 10rem;
		border-radius: 1rem;
		border: 5px solid white;
		background: #b91c1c;
		font-size: 1.5rem;
		font-weight: 800;
		color: white;
		transition: transform 90ms ease-out;
	}
	.blank-choice.focused,
	.blank-close.focused {
		transform: scale(calc(1.08 - var(--press, 0) * 0.08));
		box-shadow:
			0 0 0 4px #fde047,
			0 0 45px 14px rgb(253 224 71 / 0.75);
	}
	.rack-tile {
		display: flex;
		height: var(--rack-tile);
		width: var(--rack-tile);
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		border-radius: 0.6rem;
		background: #fcd34d;
		color: #1c1917;
		font-size: 2.25rem;
		font-weight: 800;
		box-shadow: 0 6px 12px rgb(0 0 0 / 0.4);
		transition:
			transform 90ms ease-out,
			opacity 150ms,
			box-shadow 120ms;
	}
	.off {
		opacity: 0.4;
	}
	.gone {
		visibility: hidden;
	}
	/* No lift for a rack tile, or it would cover the words just above it. */
	.rack-tile.focused {
		transform: translateY(calc(var(--press, 0) * 0.5rem)) scale(calc(1.14 - var(--press, 0) * 0.1));
	}
	.action.focused {
		transform: translateY(calc(-0.9rem + var(--press, 0) * 1rem))
			scale(calc(1.14 - var(--press, 0) * 0.1));
	}
	.rack-tile.focused,
	.action.focused {
		opacity: 1;
		box-shadow:
			0 0 0 4px #fde047,
			0 0 40px 12px rgb(253 224 71 / 0.75);
	}
	.carried {
		position: fixed;
		left: 0;
		top: 0;
		z-index: 54;
		display: flex;
		height: 4rem;
		width: 4rem;
		align-items: center;
		justify-content: center;
		border-radius: 0.5rem;
		background: #86efac;
		color: #1c1917;
		font-size: 2.2rem;
		font-weight: 800;
		box-shadow: 0 10px 22px rgb(0 0 0 / 0.5);
		pointer-events: none;
		transition: opacity 120ms;
	}
	/* The square shows where it will land, so the carried tile steps back but never vanishes. */
	.carried.landing {
		opacity: 0.35;
	}
</style>
