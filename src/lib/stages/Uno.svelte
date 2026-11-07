<script lang="ts">
	import { onDestroy } from 'svelte';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { crossfade, fade, fly, scale } from 'svelte/transition';
	import { target, targets } from '../input/targets.svelte';
	import { session } from '../session';

	let { onDone }: { onDone: () => void } = $props();

	type Color = 'red' | 'blue' | 'green' | 'yellow' | 'wild';
	type Seat = 'left' | 'top' | 'right';
	type Card = {
		id: number;
		color: Color;
		value: string;
		/** Where it came from, so it can animate from there. */
		from?: Seat | 'hand' | 'deck';
		/** The color a Wild was turned into. */
		shown?: Color;
	};

	const SEATS: Seat[] = ['left', 'top', 'right'];
	const NAMES: Record<Seat, string> = { left: 'Ana', top: 'Ben', right: 'Cy' };
	const COLORS: Record<Color, string> = {
		red: '#dc2626',
		blue: '#2563eb',
		green: '#16a34a',
		yellow: '#eab308',
		wild: '#111827'
	};
	const CARD_MS = 450;

	const [send, receive] = crossfade({
		duration: CARD_MS,
		easing: cubicOut,
		fallback: (node) => scale(node, { start: 0.7, duration: 250 })
	});

	// No green in the hand, so a green top card later makes the Wild the only play.
	// Only the ends of the hand match the first top card, so legal cards sit far apart.
	let hand = $state<Card[]>([
		{ id: 1, color: 'red', value: '3' },
		{ id: 2, color: 'blue', value: '7' },
		{ id: 3, color: 'yellow', value: '5' },
		{ id: 4, color: 'wild', value: 'W' },
		{ id: 5, color: 'yellow', value: '2' },
		{ id: 6, color: 'yellow', value: '9' },
		{ id: 7, color: 'blue', value: '4' }
	]);
	let discard = $state<Card[]>([{ id: 0, color: 'red', value: '4', from: 'deck' }]);
	let turn = $state(0);
	let phase = $state<'play' | 'opponents' | 'pick' | 'uno'>('play');
	let activeSeat = $state<Seat | null>(null);
	let seatNote = $state('');
	let counts = $state<Record<Seat, number>>({ left: 7, top: 7, right: 7 });
	let nextId = 100;

	const drawQueue: { color: Color; value: string }[] = [
		{ color: 'red', value: '6' },
		{ color: 'blue', value: '1' },
		{ color: 'yellow', value: '8' }
	];

	const top = $derived(discard[discard.length - 1]);
	const topColor = $derived(top.shown ?? top.color);

	// What the player could see, so the session log says what they were trying to do.
	$effect(() => {
		session.event('game', {
			game: 'uno',
			phase,
			top: `${topColor} ${top.value}`,
			hand: hand.map((c) => `${c.id}:${c.color} ${c.value}`)
		});
	});

	const timers: ReturnType<typeof setTimeout>[] = [];
	function wait(ms: number) {
		return new Promise<void>((resolve) => {
			timers.push(setTimeout(resolve, ms));
		});
	}

	const releaseCancel = targets.claimCancel(() => {
		if (phase === 'pick') {
			const wild = discard.pop();
			if (wild) hand.splice(3, 0, { id: wild.id, color: 'wild', value: 'W' });
			phase = 'play';
		}
	});
	onDestroy(() => {
		releaseCancel();
		for (const t of timers) clearTimeout(t);
	});

	function isLegal(card: Card) {
		if (phase !== 'play') return false;
		// The script holds the Wild back until its turn, to keep the targets few and far apart.
		if (card.color === 'wild') return turn === 2;
		return card.color === topColor || card.value === top.value;
	}

	/** Sets up the next turn so the playable cards sit at opposite ends of the hand. */
	function nextTop(): { color: Color; value: string } {
		if (turn === 2 && hand.some((c) => c.color === 'wild')) return { color: 'green', value: '8' };
		const plain = hand.filter((c) => c.color !== 'wild');
		if (plain.length === 0) return { color: topColor, value: top.value };
		return { color: plain[0].color, value: plain[plain.length - 1].value };
	}

	function opponentPlays(seat: Seat, card: { color: Color; value: string }) {
		discard.push({ id: nextId++, ...card, from: seat });
		if (discard.length > 4) discard.shift();
		counts[seat] -= 1;
	}

	/** Two opponents play and one draws. Each play is legal, and the last sets up the next turn. */
	async function opponents() {
		phase = 'opponents';
		turn += 1;
		const goal = nextTop();
		const drawer = SEATS[turn % 3];
		const plays = [
			{ color: topColor, value: goal.value },
			{ color: goal.color, value: goal.value }
		];
		for (const seat of SEATS) {
			activeSeat = seat;
			await wait(350);
			if (seat === drawer) {
				counts[seat] += 1;
				seatNote = `${NAMES[seat]} draws`;
			} else {
				opponentPlays(seat, plays.shift()!);
				seatNote = '';
			}
			await wait(CARD_MS + 150);
		}
		activeSeat = null;
		seatNote = '';
		phase = 'play';
	}

	function afterPlay() {
		if (hand.length === 1) {
			phase = 'uno';
			wait(3500).then(onDone);
		} else {
			wait(CARD_MS).then(opponents);
		}
	}

	function play(card: Card) {
		hand = hand.filter((c) => c.id !== card.id);
		discard.push({ ...card, from: 'hand' });
		if (discard.length > 4) discard.shift();
		if (card.color === 'wild') {
			phase = 'pick';
			return;
		}
		afterPlay();
	}

	function chooseColor(color: Color) {
		discard[discard.length - 1].shown = color;
		afterPlay();
	}

	function draw() {
		const next = drawQueue.shift() ?? { color: 'red' as Color, value: '1' };
		hand.push({ id: nextId++, ...next, from: 'deck' });
		wait(CARD_MS).then(opponents);
	}

	/** Every card arrives from where it really came from. */
	function arrive(node: Element, { card }: { card: Card }) {
		if (card.from === 'hand') return receive(node, { key: card.id });
		const offset = {
			left: { x: -innerWidth * 0.42, y: 0 },
			top: { x: 0, y: -innerHeight * 0.3 },
			right: { x: innerWidth * 0.42, y: 0 },
			deck: { x: 0, y: 0 }
		}[card.from ?? 'deck'];
		return fly(node, { ...offset, opacity: 1, duration: CARD_MS, easing: cubicOut });
	}

	/** A drawn card flies from the pile, top left, down to the hand. */
	function dealt(node: Element, { card }: { card: Card }) {
		if (card.from !== 'deck') return { duration: 0 };
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
</script>

{#snippet face(card: Card)}
	<span class="corner tl">{card.value}</span>
	<span class="oval" class:wild-oval={card.color === 'wild' && !card.shown}>
		<span style:color={card.color === 'wild' ? 'white' : COLORS[card.shown ?? card.color]}>
			{card.value}
		</span>
	</span>
	<span class="corner br">{card.value}</span>
{/snippet}

{#snippet seat(s: Seat)}
	<div class="seat" class:active={activeSeat === s}>
		<div class="backs">
			{#each { length: Math.min(counts[s], 5) } as _, i (i)}
				<div class="back" style:transform="translateX({i * 10}px) rotate({i * 3 - 6}deg)"></div>
			{/each}
		</div>
		<span class="name">{NAMES[s]} · {counts[s]}</span>
	</div>
{/snippet}

<div class="relative h-full w-full">
	<button
		use:target={{ id: 'draw', legal: phase === 'play', confirm: draw }}
		class="uno-card pile"
		class:focused={targets.focused === 'draw'}
		class:off={phase !== 'play'}
	>
		Draw
	</button>

	<div class="absolute top-[40%] left-5 -translate-y-1/2">{@render seat('left')}</div>
	<div class="absolute top-3 left-1/2 -translate-x-1/2">{@render seat('top')}</div>
	<div class="absolute top-[40%] right-5 -translate-y-1/2">{@render seat('right')}</div>

	<div class="discard" style:--glow={COLORS[topColor]}>
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
		{#if phase === 'play'}
			<p>Point your head at a bright card, then nod to play it</p>
		{:else if phase === 'opponents'}
			<p class="text-slate-300">
				{seatNote || (activeSeat ? `${NAMES[activeSeat]} is playing` : 'Nice')}
			</p>
		{:else if phase === 'uno'}
			<div in:scale={{ start: 0.5, duration: 350 }}>
				<p class="uno-call">UNO!</p>
				<p>One card from winning. Ready for something harder?</p>
			</div>
		{/if}
	</div>

	<div class="hand">
		{#each hand as card (card.id)}
			{@const legal = isLegal(card)}
			<button
				animate:flip={{ duration: 300 }}
				in:dealt={{ card }}
				out:send={{ key: card.id }}
				use:target={{ id: `card-${card.id}`, legal, calib: true, confirm: () => play(card) }}
				class="uno-card"
				class:dim={!legal}
				class:focused={targets.focused === `card-${card.id}`}
				style:background={COLORS[card.color]}
			>
				{@render face(card)}
			</button>
		{/each}
	</div>

	{#if phase === 'pick'}
		<div transition:fade={{ duration: 200 }} class="pointer-events-none absolute inset-0 bg-black/60"></div>
		<p class="absolute top-[8%] z-[5] w-full text-center text-5xl font-bold">
			Point at a color and nod
		</p>
		{#each corners as c (c.color)}
			<button
				transition:fade={{ duration: 200 }}
				use:target={{ id: `pick-${c.color}`, legal: true, calib: true, confirm: () => chooseColor(c.color) }}
				class="picker"
				class:focused={targets.focused === `pick-${c.color}`}
				style="{c.style};background:{COLORS[c.color]}"
				aria-label={c.color}
			></button>
		{/each}
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
		top: 24%;
		height: 44vh;
		width: 20vw;
		border-radius: 1.2rem;
		border: 6px solid white;
		transition: box-shadow 120ms;
	}
	.picker.focused {
		transform: none;
		box-shadow:
			inset 0 0 0 calc(12px + var(--press, 0) * 24px) white,
			0 0 60px 10px white;
	}
</style>
