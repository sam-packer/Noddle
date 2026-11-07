<script lang="ts">
	import { untrack } from 'svelte';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { crossfade, fade, fly, scale } from 'svelte/transition';
	import type { Card as EngineCard, Color, PlayedCard, UnoAction, UnoView } from '../games/uno/engine';
	import { CARD_MS, type GameSession } from '../session/types';
	import { target, targets } from '../input/targets.svelte';
	import { session as log } from '../session';
	import GameExit from './GameExit.svelte';

	let {
		session,
		onDone,
		onExit
	}: {
		session: GameSession<UnoView, UnoAction>;
		onDone: () => void;
		onExit: () => void;
	} = $props();

	type Position = 'left' | 'top' | 'right';
	type Card = EngineCard & { shown?: Color; by?: number | null };

	/** Where each other seat sits, going round the table from this player. */
	const POSITIONS: Record<number, Position[]> = {
		2: ['top'],
		3: ['left', 'right'],
		4: ['left', 'top', 'right']
	};
	const COLORS: Record<Color | 'wild', string> = {
		red: '#dc2626',
		blue: '#2563eb',
		green: '#16a34a',
		yellow: '#eab308',
		wild: '#111827'
	};
	const LABELS: Partial<Record<EngineCard['value'], string>> = {
		skip: '⊘',
		reverse: '⇄',
		draw2: '+2',
		wild: 'W',
		wild4: '+4'
	};
	/** The most cards that fit in a row at their full size. A longer hand is paged. */
	const PAGE_SIZE = 7;
	/** A stray nod just after the game ends must not choose what happens next. */
	const END_BUTTONS_DELAY_MS = 1500;

	const [send, receive] = crossfade({
		duration: CARD_MS,
		easing: cubicOut,
		fallback: (node) => scale(node, { start: 0.7, duration: 250 })
	});

	const snap = $derived($session);
	let lastRejected: typeof snap.rejected = null;
	const view = $derived(snap.view);
	const me = $derived(view.me);

	/** A Wild waiting for its colour. It only becomes a real move once one is chosen. */
	let pendingWild = $state<EngineCard | null>(null);
	/** Its colour, once chosen. The card stays on the pile until the session confirms the move. */
	let pendingColor = $state<Color | null>(null);
	let leaving = $state(false);
	let page = $state(0);
	let endButtons = $state(false);

	const seats = $derived(
		(POSITIONS[view.players] ?? []).map((position, i) => ({
			position,
			seat: (me + i + 1) % view.players
		}))
	);
	const hand = $derived(view.hand.filter((c) => c.id !== pendingWild?.id));
	const pageCount = $derived(Math.max(1, Math.ceil(hand.length / PAGE_SIZE)));
	const shown = $derived(hand.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));
	const discard = $derived<Card[]>(
		pendingWild && !view.discard.some((c) => c.id === pendingWild?.id)
			? [...view.discard, { ...pendingWild, by: me, shown: pendingColor ?? undefined }]
			: view.discard
	);
	const top = $derived(view.discard[view.discard.length - 1]);
	const glow = $derived(discard[discard.length - 1]);
	const glowColor = $derived(glow.shown ?? glow.color);
	const picking = $derived(pendingWild !== null && pendingColor === null);
	const myMove = $derived(
		!pendingWild && !snap.ended && (view.legal.cards.length > 0 || view.legal.draw || view.legal.keep)
	);
	const pageOf = (id: number) => Math.floor(hand.findIndex((c) => c.id === id) / PAGE_SIZE);
	const legalPages = $derived(
		view.legal.cards.filter((id) => hand.some((c) => c.id === id)).map(pageOf)
	);
	const legalBefore = $derived(legalPages.filter((p) => p < page).length);
	const legalAfter = $derived(legalPages.filter((p) => p > page).length);
	const legalKey = $derived(`${view.legal.cards.join()}|${view.drawnId}`);
	const activeName = $derived(snap.active === null ? null : snap.names[snap.active]);

	$effect(() => {
		if (page >= pageCount) page = pageCount - 1;
	});

	// When the options change, open on a page with a move on it. After that the page is the
	// player's to change, even to look at cards they can't play.
	$effect(() => {
		void legalKey;
		untrack(() => {
			if (view.drawnId !== null && hand.some((c) => c.id === view.drawnId)) {
				page = pageOf(view.drawnId);
			} else if (legalPages.length && !legalPages.includes(page)) {
				page = legalPages[0];
			}
		});
	});

	// Once the session has answered, the waiting Wild has either landed or been refused.
	$effect(() => {
		void snap.rejected;
		if (pendingColor === null) return;
		const held = view.hand.some((c) => c.id === pendingWild?.id);
		if (!held || untrack(() => lastRejected !== snap.rejected)) {
			pendingWild = null;
			pendingColor = null;
		}
		lastRejected = snap.rejected;
	});

	// What the player could see, so the session log says what they were trying to do.
	$effect(() => {
		const color = top.shown ?? top.color;
		log.event('game', {
			game: 'uno',
			phase: picking ? 'pick' : snap.ended ? 'uno' : myMove ? 'play' : 'opponents',
			top: `${color} ${top.value}`,
			hand: view.hand.map((c) => `${c.id}:${c.color} ${c.value}`),
			page,
			counts: view.counts,
			current: view.current,
			note: snap.note
		});
	});

	$effect(() => {
		if (snap.rejected) log.event('rejected', { reason: snap.rejected.reason });
	});

	// A scripted ending moves on by itself. A real one waits for the player to choose.
	$effect(() => {
		const ended = snap.ended;
		if (!ended) {
			endButtons = false;
			return;
		}
		const delay = ended.advanceMs ?? END_BUTTONS_DELAY_MS;
		const timer = setTimeout(() => {
			if (ended.advanceMs !== undefined) onDone();
			else endButtons = true;
		}, delay);
		return () => clearTimeout(timer);
	});

	function play(card: EngineCard) {
		if (card.color === 'wild') {
			pendingWild = card;
			return;
		}
		session.send({ type: 'play', cardId: card.id });
	}

	function chooseColor(color: Color) {
		lastRejected = snap.rejected;
		pendingColor = color;
		session.send({ type: 'play', cardId: pendingWild!.id, color });
	}

	/** Takes a played Wild back, from the close button on the color picker. */
	function takeBackWild() {
		pendingWild = null;
	}

	/** Cards this player already held, so only a newly drawn one flies in from the pile. */
	const known = new Set<number>();
	let arriving = new Set<number>();
	$effect.pre(() => {
		const ids = view.hand.map((c) => c.id);
		arriving = new Set(ids.filter((id) => !known.has(id)));
		for (const id of ids) known.add(id);
	});

	function positionOf(by: number | null | undefined) {
		return seats.find((s) => s.seat === by)?.position ?? null;
	}

	/** Every card arrives from where it really came from. */
	function arrive(node: Element, { card }: { card: Card }) {
		if (card.by === me) return receive(node, { key: card.id });
		const position = positionOf(card.by);
		const offset = position
			? {
					left: { x: -innerWidth * 0.42, y: 0 },
					top: { x: 0, y: -innerHeight * 0.3 },
					right: { x: innerWidth * 0.42, y: 0 }
				}[position]
			: { x: 0, y: 0 };
		return fly(node, { ...offset, opacity: 1, duration: CARD_MS, easing: cubicOut });
	}

	/** A drawn card flies from the pile, top left, down to the hand. */
	function dealt(node: Element, { card }: { card: Card }) {
		if (!arriving.has(card.id)) return { duration: 0 };
		return fly(node, {
			x: -innerWidth * 0.45,
			y: -innerHeight * 0.45,
			opacity: 1,
			duration: CARD_MS,
			easing: cubicOut
		});
	}

	// In a row across the middle: no neck strain, and a nod can't slide onto the next color.
	const corners: { color: Color; style: string }[] = [
		{ color: 'red', style: 'left:4%' },
		{ color: 'blue', style: 'left:28%' },
		{ color: 'green', style: 'left:52%' },
		{ color: 'yellow', style: 'left:76%' }
	];

	const rotation = (id: number) => ((id * 37) % 13) - 6;
	const label = (card: EngineCard) => LABELS[card.value] ?? card.value;
	const isPlayedWild = (card: Card) => card.color === 'wild' && !card.shown;
</script>

{#snippet face(card: Card)}
	<span class="corner tl">{label(card)}</span>
	<span class="oval" class:wild-oval={isPlayedWild(card)}>
		<span style:color={card.color === 'wild' ? 'white' : COLORS[card.shown ?? card.color]}>
			{label(card)}
		</span>
	</span>
	<span class="corner br">{label(card)}</span>
{/snippet}

{#snippet seat(s: number)}
	<div class="seat" class:active={snap.active === s}>
		<div class="backs">
			{#each { length: Math.min(view.counts[s], 5) } as _, i (i)}
				<div class="back" style:transform="translateX({i * 10}px) rotate({i * 3 - 6}deg)"></div>
			{/each}
		</div>
		<span class="name">{snap.names[s]} · {view.counts[s]}{view.counts[s] === 1 ? ' · UNO!' : ''}</span>
	</div>
{/snippet}

<div class="relative h-full w-full">
	<button
		use:target={{
			id: 'draw',
			legal: view.legal.draw && !pendingWild && !leaving,
			confirm: () => session.send({ type: 'draw' })
		}}
		class="uno-card pile"
		class:focused={targets.focused === 'draw'}
		class:off={!view.legal.draw || !!pendingWild}
	>
		Draw
	</button>

	{#each seats as s (s.seat)}
		{#if s.position === 'left'}
			<div class="absolute top-[40%] left-5 -translate-y-1/2">{@render seat(s.seat)}</div>
		{:else if s.position === 'top'}
			<div class="absolute top-3 left-1/2 -translate-x-1/2">{@render seat(s.seat)}</div>
		{:else}
			<div class="absolute top-[40%] right-5 -translate-y-1/2">{@render seat(s.seat)}</div>
		{/if}
	{/each}

	<div class="discard" style:--glow={COLORS[glowColor]}>
		{#each discard as card (card.id)}
			<div
				in:arrive={{ card }}
				class="uno-card stacked"
				style:background={COLORS[card.shown ?? card.color]}
				style:rotate="{rotation(card.id)}deg"
			>
				{@render face(card)}
			</div>
		{/each}
	</div>

	<div class="status">
		{#if snap.ended?.advanceMs !== undefined}
			<div in:scale={{ start: 0.5, duration: 350 }}>
				<p class="uno-call">{snap.ended.title}</p>
				<p>{snap.ended.text}</p>
			</div>
		{:else if myMove}
			{#if snap.note}<p class="note">{snap.note}</p>{/if}
			{#if view.legal.keep}
				<p>You can play the card you drew, or point at Keep and nod</p>
			{:else if view.legal.cards.length}
				<p>Point your head at a bright card, then nod to play it</p>
			{:else}
				<p>Nothing to play. Point at Draw and nod</p>
			{/if}
		{:else if !pendingWild && !snap.ended}
			<p class="text-slate-300">{snap.note || (activeName ? `${activeName} is playing` : 'Nice')}</p>
		{/if}
	</div>

	<div class="hand">
		{#each shown as card (card.id)}
			{@const legal = view.legal.cards.includes(card.id) && !pendingWild}
			<button
				animate:flip={{ duration: 300 }}
				in:dealt={{ card }}
				out:send={{ key: card.id }}
				use:target={{ id: `card-${card.id}`, legal: legal && !leaving, calib: true, confirm: () => play(card) }}
				class="uno-card"
				class:dim={!legal}
				class:focused={targets.focused === `card-${card.id}`}
				style:background={COLORS[card.color]}
			>
				{@render face(card)}
			</button>
		{/each}
	</div>

	<!-- Large arrows at the far ends, so a long hand never has to shrink its cards to fit. -->
	{#if pageCount > 1}
		<button
			use:target={{
				id: 'page-back',
				legal: page > 0 && !pendingWild && !leaving,
				confirm: () => (page -= 1)
			}}
			class="arrow"
			style="left:0.75rem"
			class:gone={page === 0}
			class:focused={targets.focused === 'page-back'}
		>
			‹{#if legalBefore}<small>{legalBefore} to play</small>{/if}
		</button>
		<button
			use:target={{
				id: 'page-next',
				legal: page < pageCount - 1 && !pendingWild && !leaving,
				confirm: () => (page += 1)
			}}
			class="arrow"
			style="right:0.75rem"
			class:gone={page === pageCount - 1}
			class:focused={targets.focused === 'page-next'}
		>
			›{#if legalAfter}<small>{legalAfter} to play</small>{/if}
		</button>
		<p class="pages">Page {page + 1} of {pageCount}</p>
	{/if}

	<GameExit
		show={snap.canLeave && !snap.ended && !pendingWild && !view.legal.keep}
		bind:leaving
		{onExit}
	/>

	{#if view.legal.keep && !pendingWild && !leaving}
		<button
			transition:fade={{ duration: 200 }}
			use:target={{ id: 'keep', legal: true, confirm: () => session.send({ type: 'pass' }) }}
			class="close-picker keep"
			class:focused={targets.focused === 'keep'}
		>
			Keep<span>End your turn</span>
		</button>
	{/if}

	{#if picking}
		<div transition:fade={{ duration: 200 }} class="pointer-events-none absolute inset-0 bg-black/60"></div>
		<p class="pointer-events-none absolute top-[8%] z-[5] w-full text-center text-5xl font-bold">
			Point at a color and nod
		</p>
		<button
			transition:fade={{ duration: 200 }}
			use:target={{ id: 'pick-close', legal: !leaving, confirm: takeBackWild }}
			class="close-picker"
			class:focused={targets.focused === 'pick-close'}
		>
			✕<span>Take back</span>
		</button>
		{#each corners as c (c.color)}
			<button
				transition:fade={{ duration: 200 }}
				use:target={{ id: `pick-${c.color}`, legal: !leaving, calib: true, confirm: () => chooseColor(c.color) }}
				class="picker"
				class:focused={targets.focused === `pick-${c.color}`}
				style="{c.style};background:{COLORS[c.color]}"
				aria-label={c.color}
			></button>
		{/each}
	{/if}

	{#if snap.ended && snap.ended.advanceMs === undefined}
		<div in:fade={{ duration: 250 }} class="pointer-events-none absolute inset-0 z-[5] bg-black/70"></div>
		<div class="end-title" in:scale={{ start: 0.5, duration: 350 }}>
			<p class="uno-call">{snap.ended.title}</p>
			<p class="text-2xl">{snap.ended.text}</p>
		</div>
		{#if snap.canRestart && session.restart}
			<button
				use:target={{ id: 'again', legal: endButtons, confirm: () => session.restart?.() }}
				class="end-choice"
				style="left:14%;background:#15803d"
				class:off={!endButtons}
				class:focused={targets.focused === 'again'}
			>
				Play again
			</button>
		{/if}
		<button
			use:target={{ id: 'menu', legal: endButtons, confirm: onExit }}
			class="end-choice"
			style="right:14%;background:#334155"
			class:off={!endButtons}
			class:focused={targets.focused === 'menu'}
		>
			✕ Menu
		</button>
	{/if}
</div>

<style>
	.uno-card {
		position: relative;
		display: flex;
		height: 10.5rem;
		width: 7rem;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		border-radius: 0.9rem;
		border: 5px solid white;
		color: white;
		font-weight: 800;
		box-shadow: 0 8px 18px rgb(0 0 0 / 0.45);
		transition:
			transform 90ms ease-out,
			opacity 200ms,
			box-shadow 120ms;
	}
	.oval {
		display: flex;
		height: 62%;
		width: 82%;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		background: white;
		font-size: 3.2rem;
		rotate: -18deg;
	}
	.oval > span {
		rotate: 18deg;
	}
	.wild-oval {
		background: conic-gradient(#dc2626 0 25%, #2563eb 0 50%, #eab308 0 75%, #16a34a 0);
	}
	.corner {
		position: absolute;
		font-size: 1.1rem;
	}
	.tl {
		left: 0.4rem;
		top: 0.2rem;
	}
	.br {
		bottom: 0.2rem;
		right: 0.4rem;
		rotate: 180deg;
	}
	.pile {
		position: absolute;
		left: 1.5rem;
		top: 1.5rem;
		z-index: 2;
		background: repeating-linear-gradient(45deg, #334155 0 10px, #1e293b 10px 20px);
		font-size: 1.7rem;
	}
	.off {
		opacity: 0.45;
	}
	.discard {
		position: absolute;
		left: 50%;
		top: 34%;
		height: 10.5rem;
		width: 7rem;
		translate: -50% -50%;
		scale: 1.05;
		filter: drop-shadow(0 0 28px var(--glow));
	}
	.stacked {
		position: absolute;
		inset: 0;
	}
	.status {
		position: absolute;
		left: 0;
		top: 84%;
		width: 100%;
		text-align: center;
		font-size: 1.9rem;
		font-weight: 600;
	}
	.uno-call {
		color: #fcd34d;
		font-size: 5rem;
		font-weight: 900;
		line-height: 1;
	}
	.hand {
		position: absolute;
		top: 54%;
		display: flex;
		width: 100%;
		justify-content: center;
		gap: 1.1rem;
		padding: 0 2rem;
	}
	.dim {
		opacity: 0.28;
	}
	.focused {
		z-index: 3;
		transform: translateY(calc(-1.6rem + var(--press, 0) * 1.6rem))
			scale(calc(1.16 - var(--press, 0) * 0.1));
		box-shadow:
			0 0 0 4px #fde047,
			0 0 45px 14px rgb(253 224 71 / 0.75);
		opacity: 1;
	}
	.seat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3rem;
		border-radius: 1rem;
		padding: 0.5rem 1rem;
		transition:
			box-shadow 150ms,
			background 150ms;
	}
	.seat.active {
		background: rgb(251 191 36 / 0.15);
		box-shadow: 0 0 34px 6px rgb(251 191 36 / 0.7);
	}
	.backs {
		position: relative;
		height: 5.6rem;
		width: 6rem;
	}
	.back {
		position: absolute;
		height: 5.5rem;
		width: 3.8rem;
		border-radius: 0.5rem;
		border: 3px solid white;
		background: #7f1d1d;
	}
	.name {
		font-size: 1.15rem;
		font-weight: 600;
	}
	.picker {
		position: absolute;
		z-index: 4;
		top: 32%;
		height: 44vh;
		width: 20vw;
		border-radius: 1.2rem;
		border: 6px solid white;
		transition: box-shadow 120ms;
	}
	.close-picker {
		position: absolute;
		z-index: 4;
		right: 2rem;
		top: 1.5rem;
		display: flex;
		height: 8rem;
		width: 10rem;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		border-radius: 1rem;
		border: 5px solid white;
		background: #b91c1c;
		font-size: 3rem;
		font-weight: 800;
		line-height: 1;
	}
	.close-picker span {
		margin-top: 0.4rem;
		font-size: 1.2rem;
	}
	.keep {
		background: #15803d;
		font-size: 2.2rem;
	}
	.note {
		color: #cbd5e1;
		font-size: 1.4rem;
	}
	.arrow {
		position: absolute;
		top: 54%;
		display: flex;
		height: 10.5rem;
		width: 6.5rem;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		border-radius: 0.9rem;
		border: 5px solid white;
		background: #334155;
		color: white;
		font-size: 4.5rem;
		font-weight: 800;
		line-height: 1;
		transition:
			transform 90ms ease-out,
			box-shadow 120ms;
	}
	.arrow small {
		margin-top: 0.5rem;
		font-size: 1rem;
		font-weight: 700;
		color: #fde047;
	}
	.gone {
		visibility: hidden;
	}
	.pages {
		position: absolute;
		left: 0;
		top: 51%;
		width: 100%;
		text-align: center;
		font-size: 1.1rem;
		font-weight: 600;
		color: #94a3b8;
	}
	.end-title {
		position: absolute;
		left: 0;
		top: 7%;
		z-index: 6;
		width: 100%;
		text-align: center;
	}
	.end-choice {
		position: absolute;
		top: 34%;
		z-index: 6;
		height: 36vh;
		width: 28vw;
		border-radius: 1.2rem;
		border: 6px solid white;
		font-size: 2.6rem;
		font-weight: 800;
		transition:
			transform 90ms ease-out,
			opacity 200ms;
	}
	.picker.focused {
		transform: none;
		box-shadow:
			inset 0 0 0 calc(12px + var(--press, 0) * 24px) white,
			0 0 60px 10px white;
	}
</style>
