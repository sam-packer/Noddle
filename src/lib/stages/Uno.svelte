<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { innerWidth as viewportWidth } from 'svelte/reactivity/window';
	import { crossfade, fade, fly, scale } from 'svelte/transition';
	import type { Card as EngineCard, Color, PlayedCard, UnoAction, UnoView } from '../games/uno/engine';
	import { CARD_MS, type GameSession } from '../session/types';
	import { target } from '../input/targets.svelte';
	import { session as log } from '../session';
	import Confetti from './Confetti.svelte';
	import GameExit from './GameExit.svelte';
	import { gameEnd } from './gameEnd.svelte';

	let {
		session,
		onDone,
		onExit,
		restartDemo
	}: {
		session: GameSession<UnoView, UnoAction>;
		onDone: () => void;
		onExit: () => void;
		/** In the demo, the corner button starts it over instead of leaving. */
		restartDemo?: () => void;
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
	/** The most cards a row shows, however wide the screen. A longer hand is paged. */
	const MAX_PAGE_SIZE = 7;
	/** A card and the gap between cards, in rem, as in the styles below. */
	const CARD_REM = 7;
	const CARD_GAP_REM = 1.1;
	/** Kept clear at each end of the hand for a paging arrow, and the space beside it. */
	const ARROW_LANE_REM = 9.75;
	/** A Wild the session never answers goes back in the hand, so the game can't get stuck on it. */
	const WILD_ANSWER_MS = 5000;
	/** A drawn card's trip from the pile, and the gap between cards when several are drawn. */
	const DRAW_MS = 650;
	const DRAW_STAGGER_MS = 130;
	/** How long a card just drawn stands out once it lands, so nobody misses what they got. */
	const FRESH_MS = 1500;
	/** A card back is drawn at this share of a card's size. */
	const BACK_SCALE = 0.52;

	const [send, receive] = crossfade({
		duration: CARD_MS,
		easing: cubicOut,
		fallback: (node) => scale(node, { start: 0.7, duration: 250 })
	});

	const snap = $derived($session);
	let rejectedBefore = 0;
	const view = $derived(snap.view);
	const me = $derived(view.me);

	/** A Wild waiting for its colour. It only becomes a real move once one is chosen. */
	let pendingWild = $state<EngineCard | null>(null);
	/** Its colour, once chosen. The card stays on the pile until the session confirms the move. */
	let pendingColor = $state<Color | null>(null);
	let leaving = $state(false);
	/** The page the player or the game last chose. */
	let wantedPage = $state(0);

	/** Timers that change what is shown, stopped with the screen or when a new game starts. */
	const timers = new Set<ReturnType<typeof setTimeout>>();
	function later(run: () => void, ms: number) {
		const timer = setTimeout(() => {
			timers.delete(timer);
			run();
		}, ms);
		timers.add(timer);
	}
	function stopTimers() {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	}
	onDestroy(stopTimers);

	// Before anything that watches the hand, so a new game's cards are all new to it.
	const end = gameEnd({
		ended: () => snap.ended,
		onDone: () => onDone(),
		onEnd: () => {
			leaving = false;
			pendingWild = null;
			pendingColor = null;
		},
		onNewGame: () => {
			stopTimers();
			known.clear();
			arriving = new Set();
			fresh = [];
			flights = [];
			drew = {};
			seenCounts = null;
			pendingWild = null;
			pendingColor = null;
			wantedPage = 0;
		}
	});

	const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
	/** As many cards as fit between the paging arrows at their full size, so none runs under one. */
	const pageSize = $derived(
		Math.max(
			1,
			Math.min(
				MAX_PAGE_SIZE,
				Math.floor(
					((viewportWidth.current ?? 1280) / rem - 2 * ARROW_LANE_REM + CARD_GAP_REM) /
						(CARD_REM + CARD_GAP_REM)
				)
			)
		)
	);

	const seats = $derived(
		(POSITIONS[view.players] ?? []).map((position, i) => ({
			position,
			seat: (me + i + 1) % view.players
		}))
	);
	const hand = $derived(view.hand.filter((c) => c.id !== pendingWild?.id));
	const pageCount = $derived(Math.max(1, Math.ceil(hand.length / pageSize)));
	/** The page asked for, or the last one if the hand has since got shorter. */
	const page = $derived(Math.min(wantedPage, pageCount - 1));
	const shown = $derived(hand.slice(page * pageSize, (page + 1) * pageSize));
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
		!pendingWild && !end.over && (view.legal.cards.length > 0 || view.legal.draw || view.legal.keep)
	);
	const pageOf = (id: number) => Math.floor(hand.findIndex((c) => c.id === id) / pageSize);
	const legalPages = $derived(
		view.legal.cards.filter((id) => hand.some((c) => c.id === id)).map(pageOf)
	);
	const legalBefore = $derived(legalPages.filter((p) => p < page).length);
	const legalAfter = $derived(legalPages.filter((p) => p > page).length);
	const legalKey = $derived(`${view.legal.cards.join()}|${view.drawnId}`);
	const activeName = $derived(snap.active === null ? null : snap.names[snap.active]);

	// When the options change, open on a page with a move on it. After that the page is the
	// player's to change, even to look at cards they can't play.
	$effect(() => {
		void legalKey;
		untrack(() => {
			if (view.drawnId !== null && hand.some((c) => c.id === view.drawnId)) {
				wantedPage = pageOf(view.drawnId);
			} else if (legalPages.length && !legalPages.includes(page)) {
				wantedPage = legalPages[0];
			}
		});
	});

	// Once the session has answered, the waiting Wild has either landed or been refused.
	$effect(() => {
		if (pendingColor === null) return;
		const held = view.hand.some((c) => c.id === pendingWild?.id);
		if (!held || rejectedCount !== rejectedBefore) {
			pendingWild = null;
			pendingColor = null;
		}
	});
	$effect(() => {
		if (pendingColor === null) return;
		const timer = setTimeout(() => {
			pendingWild = null;
			pendingColor = null;
		}, WILD_ANSWER_MS);
		return () => clearTimeout(timer);
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

	const rejectedCount = $derived(snap.rejected?.n ?? 0);
	$effect(() => {
		if (rejectedCount) log.event('rejected', { reason: untrack(() => snap.rejected?.reason) });
	});

	function play(card: EngineCard) {
		if (card.color === 'wild') {
			pendingWild = card;
			return;
		}
		session.send({ type: 'play', cardId: card.id });
	}

	function chooseColor(color: Color) {
		rejectedBefore = rejectedCount;
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
	/** Cards that just landed in the hand. */
	let fresh = $state<number[]>([]);
	let pileEl = $state<HTMLElement>();
	let handEl = $state<HTMLElement>();
	const seatEls = new Map<number, HTMLElement>();
	/** Card backs on their way from the pile to wherever they were drawn to. */
	type Flight = { id: number; x0: number; y0: number; x1: number; y1: number; delay: number; end: number };
	let flights = $state<Flight[]>([]);
	let flightId = 0;
	/** "+2" over a player who just drew, and when it should appear. */
	let drew = $state<Record<number, { n: number; id: number; land: number }>>({});

	const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

	$effect.pre(() => {
		const ids = view.hand.map((c) => c.id);
		arriving = new Set(ids.filter((id) => !known.has(id)));
		for (const id of ids) known.add(id);
		// The opening deal has no last move. Anything else that arrives was drawn.
		if (!arriving.size || !view.last) return;
		const [first] = arriving;
		const landed = [...arriving];
		untrack(() => {
			wantedPage = Math.max(0, pageOf(first));
			fresh = landed;
		});
		later(
			() => (fresh = fresh.filter((id) => !landed.includes(id))),
			DRAW_MS + landed.length * DRAW_STAGGER_MS + FRESH_MS
		);
	});

	/** Sends card backs flying from the pile to a place on the table. */
	function launch(to: HTMLElement, count: number, end: number) {
		if (!pileEl || stillMotion()) return;
		const from = pileEl.getBoundingClientRect();
		const dest = to.getBoundingClientRect();
		const added = Array.from({ length: count }, (_, i) => ({
			id: ++flightId,
			x0: from.left,
			y0: from.top,
			x1: dest.left,
			y1: dest.top,
			delay: i * DRAW_STAGGER_MS,
			end
		}));
		flights = [...flights, ...added];
		const ids = added.map((f) => f.id);
		later(
			() => (flights = flights.filter((f) => !ids.includes(f.id))),
			DRAW_MS + count * DRAW_STAGGER_MS
		);
	}

	function kickPile() {
		if (!stillMotion()) {
			pileEl?.animate([{ scale: 1 }, { scale: 1.1 }, { scale: 1 }], { duration: 260, easing: 'ease-out' });
		}
	}

	// Watches the counts, because other players' cards are hidden and that's all there is to see.
	const countsKey = $derived(view.counts.join());
	let seenCounts: number[] | null = null;
	$effect(() => {
		void countsKey;
		untrack(() => {
			const was = seenCounts;
			seenCounts = [...view.counts];
			const last = view.last;
			if (!was || was.length !== view.counts.length) return;
			if (!last || last.kind === 'pass' || (last.kind === 'play' && !last.drew)) return;
			view.counts.forEach((count, seat) => {
				const more = count - was[seat];
				if (more <= 0) return;
				kickPile();
				if (seat === me) {
					// Cards sort into the hand, so some of them can land on a page not showing.
					const away = [...arriving].filter((id) => !shown.some((c) => c.id === id)).length;
					if (away && handEl) launch(handEl, away, 1);
					return;
				}
				const el = seatEls.get(seat);
				if (!el) return;
				launch(el, more, BACK_SCALE);
				const id = ++flightId;
				drew = { ...drew, [seat]: { n: more, id, land: DRAW_MS + (more - 1) * DRAW_STAGGER_MS } };
				later(() => {
					if (drew[seat]?.id !== id) return;
					const { [seat]: _gone, ...rest } = drew;
					drew = rest;
				}, DRAW_MS + more * DRAW_STAGGER_MS + FRESH_MS);
			});
		});
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

	/** A drawn card leaves the pile face down, and turns over on its way to the hand. */
	function dealt(node: Element, { card }: { card: Card }) {
		if (!arriving.has(card.id) || !pileEl || stillMotion()) return { duration: 0 };
		const from = pileEl.getBoundingClientRect();
		const to = node.getBoundingClientRect();
		const dx = from.left - to.left;
		const dy = from.top - to.top;
		return {
			delay: [...arriving].indexOf(card.id) * DRAW_STAGGER_MS,
			duration: DRAW_MS,
			easing: cubicOut,
			css: (t: number, u: number) =>
				`z-index: 4; opacity: 1; transform: perspective(900px) translate(${dx * u}px, ${dy * u - Math.sin(t * Math.PI) * 50}px) rotateY(${u * 180}deg) scale(${1 + Math.sin(t * Math.PI) * 0.12})`,
			tick: (t: number) => node.classList.toggle('face-down', t < 0.5)
		};
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
		{#if drew[s]}
			{#key drew[s].id}
				<span class="drew" style:--land="{drew[s].land}ms">+{drew[s].n}</span>
			{/key}
		{/if}
		<div
			class="backs"
			{@attach (el) => {
				seatEls.set(s, el as HTMLElement);
				return () => seatEls.delete(s);
			}}
		>
			{#each { length: Math.min(view.counts[s], 5) } as _, i (i)}
				<div class="back" style:transform="translateX({i * 10}px) rotate({i * 3 - 6}deg)"></div>
			{/each}
		</div>
		<span class="name">{snap.names[s]} · {view.counts[s]}{view.counts[s] === 1 ? ' · UNO!' : ''}</span>
	</div>
{/snippet}

<div class="relative h-full w-full">
	<button
		bind:this={pileEl}
		use:target={{
			id: 'draw',
			legal: view.legal.draw && !pendingWild && !leaving,
			confirm: () => session.send({ type: 'draw' })
		}}
		class="uno-card pile"
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
		{#if snap.ended && end.scripted}
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
		{:else if !pendingWild && !end.over}
			<p class="text-slate-300">{snap.note || (activeName ? `${activeName} is playing` : 'Nice')}</p>
		{/if}
	</div>

	<div class="hand" bind:this={handEl}>
		{#each shown as card (card.id)}
			{@const legal = view.legal.cards.includes(card.id) && !pendingWild}
			<button
				animate:flip={{ duration: 300 }}
				in:dealt={{ card }}
				out:send={{ key: card.id }}
				use:target={{
					id: `card-${card.id}`,
					legal: legal && !leaving,
					calib: true,
					group: 'hand',
					confirm: () => play(card)
				}}
				class="uno-card"
				class:dim={!legal}
				class:fresh={fresh.includes(card.id)}
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
				confirm: () => (wantedPage = page - 1)
			}}
			class="arrow"
			style="left:0.75rem"
			class:gone={page === 0}
		>
			‹{#if legalBefore}<small>{legalBefore} to play</small>{/if}
		</button>
		<button
			use:target={{
				id: 'page-next',
				legal: page < pageCount - 1 && !pendingWild && !leaving,
				confirm: () => (wantedPage = page + 1)
			}}
			class="arrow"
			style="right:0.75rem"
			class:gone={page === pageCount - 1}
		>
			›{#if legalAfter}<small>{legalAfter} to play</small>{/if}
		</button>
		<p class="pages">Page {page + 1} of {pageCount}</p>
	{/if}

	{#each flights as flight (flight.id)}
		<div
			class="flight"
			style:--x0="{flight.x0}px"
			style:--y0="{flight.y0}px"
			style:--x1="{flight.x1}px"
			style:--y1="{flight.y1}px"
			style:--end={flight.end}
			style:--ms="{DRAW_MS}ms"
			style:animation-delay="{flight.delay}ms"
		></div>
	{/each}

	{#if snap.ended?.won}<Confetti />{/if}

	<GameExit show={snap.canLeave && !end.over && !pendingWild && !view.legal.keep} bind:leaving {onExit} {restartDemo} />

	{#if view.legal.keep && !pendingWild && !leaving}
		<button
			transition:fade={{ duration: 200 }}
			use:target={{ id: 'keep', legal: true, confirm: () => session.send({ type: 'pass' }) }}
			class="close-picker keep"
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
		>
			✕<span>Take back</span>
		</button>
		{#each corners as c (c.color)}
			<button
				transition:fade={{ duration: 200 }}
				use:target={{
					id: `pick-${c.color}`,
					legal: !leaving,
					calib: true,
					group: 'colours',
					confirm: () => chooseColor(c.color)
				}}
				class="picker"
				style="{c.style};background:{COLORS[c.color]}"
				aria-label={c.color}
			></button>
		{/each}
	{/if}

	{#if snap.ended && !end.scripted}
		<div in:fade={{ duration: 250 }} class="pointer-events-none absolute inset-0 z-[5] bg-black/80"></div>
		<div class="end-title" in:scale={{ start: 0.5, duration: 350 }}>
			<p class="uno-call">{snap.ended.title}</p>
			<p class="text-2xl">{snap.ended.text}</p>
		</div>
		{#if snap.canRestart && session.restart}
			<button
				use:target={{ id: 'again', legal: end.buttons && !leaving, confirm: () => session.restart?.() }}
				class="end-choice"
				style="left:14%;background:#15803d"
				class:off={!end.buttons}
			>
				Play again
			</button>
		{/if}
		<button
			use:target={{ id: 'menu', legal: end.buttons && !leaving, confirm: onExit }}
			class="end-choice"
			style="right:14%;background:#334155"
			class:off={!end.buttons}
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
	/* On a short screen, kept below the hand rather than over it. */
	.status {
		position: absolute;
		left: 0;
		top: max(84%, calc(54% + 11rem));
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
	/* Just drawn: readable even if it can't be played, until the player has seen what they got. */
	.fresh {
		opacity: 1;
		translate: 0 -0.7rem;
		box-shadow:
			0 0 0 4px white,
			0 0 36px 10px rgb(255 255 255 / 0.65);
		transition:
			translate 250ms ease-out,
			opacity 400ms,
			box-shadow 400ms;
	}
	/* The back of the card, while it's still turning over. Added and removed by the deal itself. */
	.hand .uno-card:global(.face-down)::after {
		content: '';
		position: absolute;
		inset: -5px;
		border-radius: inherit;
		border: 5px solid white;
		background: repeating-linear-gradient(45deg, #334155 0 10px, #1e293b 10px 20px);
	}
	.flight {
		position: fixed;
		left: 0;
		top: 0;
		z-index: 6;
		height: 10.5rem;
		width: 7rem;
		border-radius: 0.9rem;
		border: 5px solid white;
		background: repeating-linear-gradient(45deg, #334155 0 10px, #1e293b 10px 20px);
		box-shadow: 0 10px 24px rgb(0 0 0 / 0.5);
		pointer-events: none;
		transform-origin: top left;
		animation: fly-to-seat var(--ms) cubic-bezier(0.25, 0.8, 0.3, 1) both;
	}
	@keyframes fly-to-seat {
		from {
			transform: translate(var(--x0), var(--y0)) rotate(-6deg) scale(1);
		}
		to {
			transform: translate(var(--x1), var(--y1)) rotate(5deg) scale(var(--end));
		}
	}
	.drew {
		position: absolute;
		left: 50%;
		top: 0.2rem;
		z-index: 2;
		translate: -50% 0;
		border-radius: 0.6rem;
		border: 3px solid white;
		background: #b91c1c;
		padding: 0.05rem 0.6rem;
		font-size: 1.7rem;
		font-weight: 900;
		color: white;
		animation: drew-pop 1.4s var(--land) both;
	}
	@keyframes drew-pop {
		0% {
			opacity: 0;
			scale: 0.4;
		}
		18% {
			opacity: 1;
			scale: 1.2;
		}
		30%,
		80% {
			opacity: 1;
			scale: 1;
		}
		100% {
			opacity: 0;
			scale: 1;
		}
	}
	.uno-card:global([data-focused]),
	.arrow:global([data-focused]),
	.close-picker:global([data-focused]),
	.picker:global([data-focused]),
	.end-choice:global([data-focused]) {
		z-index: 3;
		transform: translateY(calc(-1.6rem + var(--press, 0) * 1.6rem))
			scale(calc(1.16 - var(--press, 0) * 0.1));
		box-shadow:
			0 0 0 4px #fde047,
			0 0 45px 14px rgb(253 224 71 / 0.75);
		opacity: 1;
	}
	.seat {
		position: relative;
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
	.picker:global([data-focused]) {
		transform: none;
		box-shadow:
			inset 0 0 0 calc(12px + var(--press, 0) * 24px) white,
			0 0 60px 10px white;
	}
</style>
