<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { smoothPointer } from '../input/smoothPointer.svelte';
	import { target, targets, type ConfirmContext } from '../input/targets.svelte';
	import { session } from '../session';
	import { engine } from '../vision/engine.svelte';

	const SIZE = 15;
	const VALUES: Record<string, number> = {
		A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3,
		N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10
	};

	function premium(r: number, c: number): 'TW' | 'DW' | 'TL' | 'DL' | null {
		const a = Math.min(r, 14 - r);
		const b = Math.min(c, 14 - c);
		const [p, q] = a < b ? [a, b] : [b, a];
		if ((p === 0 && q === 0) || (p === 0 && q === 7)) return 'TW';
		if (p === q && p >= 1 && p <= 4) return 'DW';
		if (p === 7 && q === 7) return 'DW';
		if ((p === 1 && q === 5) || (p === 5 && q === 5)) return 'TL';
		if ((p === 0 && q === 3) || (p === 2 && q === 6) || (p === 3 && q === 7) || (p === 6 && q === 6))
			return 'DL';
		return null;
	}

	const PREMIUM_COLOR = { TW: '#b91c1c', DW: '#be7c8c', TL: '#1d4ed8', DL: '#60a5fa' };
	const DEFAULT_ZOOM = 5;

	type Placed = { r: number; c: number; letter: string; rackIndex: number };

	// The computer's opening: BOARD across the centre, with the A on the centre square.
	let committed = $state<Record<string, string>>(
		Object.fromEntries([...'BOARD'].map((letter, i) => [`7,${5 + i}`, letter]))
	);
	const rack = ['T', 'G', 'I', 'M', 'E', 'L', 'S'];

	let pending = $state<Placed[]>([]);
	let stage = $state<'idle' | 'held' | 'zoom' | 'done'>('idle');
	let heldIndex = $state<number | null>(null);
	let zoom = $state<{ r0: number; c0: number; n: number } | null>(null);
	let zoomSize = $state(DEFAULT_ZOOM);
	let message = $state('');
	let score = $state(0);
	let boardEl = $state<HTMLElement>();
	let dictionary: Set<string> | null = null;

	const pendingAt = (r: number, c: number) => pending.find((p) => p.r === r && p.c === c);
	const letterAt = (r: number, c: number) => committed[`${r},${c}`] ?? pendingAt(r, c)?.letter;
	const rackUsed = (i: number) => pending.some((p) => p.rackIndex === i);
	const heldLetter = $derived(heldIndex === null ? null : rack[heldIndex]);

	onMount(async () => {
		const text = await (await fetch('/dict/enable.txt')).text();
		dictionary = new Set(text.split(/\r?\n/).map((w) => w.trim().toUpperCase()));
	});

	const releaseCancel = targets.claimCancel(() => {
		message = '';
		if (stage === 'zoom') {
			stage = 'held';
			zoom = null;
		} else if (stage === 'held') {
			stage = 'idle';
			heldIndex = null;
		} else if (stage === 'idle' && pending.length) {
			pending = pending.slice(0, -1);
		}
	});
	onDestroy(releaseCancel);

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
		stage = 'held';
		message = '';
	}

	function openZoom(ctx: ConfirmContext) {
		const { r, c } = pointToCell(ctx.point ?? { x: innerWidth / 2, y: innerHeight / 2 });
		zoom = zoomAround(r, c);
		stage = 'zoom';
		session.event('zoom', { r, c, ...zoom, x: ctx.point?.x, y: ctx.point?.y });
	}

	function placeAt(r: number, c: number) {
		if (heldIndex === null) return;
		session.event('place', { r, c, letter: rack[heldIndex] });
		pending = [...pending, { r, c, letter: rack[heldIndex], rackIndex: heldIndex }];
		heldIndex = null;
		zoom = null;
		stage = 'idle';
	}

	function wordThrough(r: number, c: number, dr: number, dc: number) {
		let [sr, sc] = [r, c];
		while (letterAt(sr - dr, sc - dc)) {
			sr -= dr;
			sc -= dc;
		}
		const cells: { r: number; c: number; letter: string }[] = [];
		for (let [cr, cc] = [sr, sc]; letterAt(cr, cc); cr += dr, cc += dc) {
			cells.push({ r: cr, c: cc, letter: letterAt(cr, cc)! });
		}
		return cells;
	}

	function scoreWord(cells: { r: number; c: number; letter: string }[]) {
		let sum = 0;
		let mult = 1;
		for (const cell of cells) {
			let v = VALUES[cell.letter] ?? 0;
			if (pendingAt(cell.r, cell.c)) {
				const pr = premium(cell.r, cell.c);
				if (pr === 'DL') v *= 2;
				if (pr === 'TL') v *= 3;
				if (pr === 'DW') mult *= 2;
				if (pr === 'TW') mult *= 3;
			}
			sum += v;
		}
		return sum * mult;
	}

	function playWord() {
		const rows = new Set(pending.map((p) => p.r));
		const cols = new Set(pending.map((p) => p.c));
		if (rows.size > 1 && cols.size > 1) {
			message = 'Tiles must be in one line. Shake to take one back.';
			return;
		}
		const across =
			rows.size === 1 && (cols.size > 1 || wordThrough(pending[0].r, pending[0].c, 0, 1).length > 1);
		const [dr, dc] = across ? [0, 1] : [1, 0];
		const main = wordThrough(pending[0].r, pending[0].c, dr, dc);
		if (!pending.every((p) => main.some((m) => m.r === p.r && m.c === p.c))) {
			message = 'Tiles must connect with no gaps. Shake to take one back.';
			return;
		}
		const words = [main];
		for (const p of pending) {
			const cross = wordThrough(p.r, p.c, dc, dr);
			if (cross.length > 1) words.push(cross);
		}
		const touches = main.some((m) => committed[`${m.r},${m.c}`]) || words.length > 1;
		if (!touches) {
			message = 'Your word has to connect to the board.';
			return;
		}
		for (const w of words) {
			const text = w.map((x) => x.letter).join('');
			if (text.length < 2 || (dictionary && !dictionary.has(text))) {
				message = `${text} isn't in the dictionary. Shake to take a tile back.`;
				return;
			}
		}
		const gained = words.reduce((s, w) => s + scoreWord(w), 0);
		score += gained;
		for (const p of pending) committed[`${p.r},${p.c}`] = p.letter;
		const played = main.map((m) => m.letter).join('');
		pending = [];
		stage = 'done';
		message = `${played} for ${gained} points!`;
		session.event('played', { word: played, gained });
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === '-') zoomSize = Math.min(9, zoomSize + 1);
		if (e.key === '=') zoomSize = Math.max(3, zoomSize - 1);
	}

	const prompt = $derived(
		stage === 'idle'
			? pending.length
				? 'Pick another tile, or point at Play and nod'
				: 'Point your head at a tile and nod to pick it up'
			: stage === 'held'
				? `Point where ${heldLetter} should go and nod to zoom in. Shake to put it back`
				: stage === 'zoom'
					? 'Point at a square and nod to place it. Shake to go back'
					: 'You did it'
	);

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
		session.event('game', {
			game: 'scrabble',
			stage,
			holding: heldLetter,
			placed: pending.map((p) => `${p.letter}@${p.r},${p.c}`),
			rack: rack.filter((_, i) => !rackUsed(i)).join(''),
			score,
			says: message || prompt
		});
	});

	const cameraStyle = $derived(
		zoom
			? `transform: scale(${SIZE / zoom.n}) translate(${(-zoom.c0 / SIZE) * 100}%, ${(-zoom.r0 / SIZE) * 100}%)`
			: 'transform: none'
	);
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full w-full flex-col items-center justify-between gap-2 py-3">
	<p class="text-2xl font-semibold" class:text-emerald-300={stage === 'done'}>{message || prompt}</p>

	<div class="flex gap-6">
		{#each rack as letter, i (i)}
			{@const available = stage === 'idle' && !rackUsed(i)}
			<button
				use:target={{ id: `rack-${i}`, legal: available, calib: true, confirm: () => pickTile(i) }}
				class="rack-tile"
				class:gone={rackUsed(i) || heldIndex === i}
				class:off={!available}
				class:focused={targets.focused === `rack-${i}`}
			>
				{letter}<sub>{VALUES[letter]}</sub>
			</button>
		{/each}
	</div>

	<div class="flex items-start gap-8">
		<div
			{@attach (el) => {
				boardEl = el;
			}}
			use:target={{ id: 'board', legal: stage === 'held', confirm: openZoom }}
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
							<div class="tile" class:new={!!pendingAt(r, c)} in:scale={{ start: 1.8, duration: 260 }}>
								{letter}<sub>{VALUES[letter]}</sub>
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
								legal: !letterAt(r, c),
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

		<div class="flex w-44 flex-col gap-5">
			<p class="text-center text-3xl font-bold">Score {score}</p>
			<button
				use:target={{ id: 'play', legal: stage === 'idle' && pending.length > 0, confirm: playWord }}
				class="action bg-emerald-700"
				class:off={!(stage === 'idle' && pending.length > 0)}
				class:focused={targets.focused === 'play'}
			>
				Play
			</button>
		</div>
	</div>

</div>

{#if heldLetter && smoothPointer.visible && (stage === 'held' || stage === 'zoom')}
	<div
		class="carried"
		class:landing={targets.focused?.startsWith('cell-')}
		style:transform="translate({smoothPointer.x}px, {smoothPointer.y}px) translate(-50%, -120%)"
	>
		{heldLetter}<sub>{VALUES[heldLetter]}</sub>
	</div>
{/if}

<style>
	.board {
		position: relative;
		height: min(70vh, 56vw);
		width: min(70vh, 56vw);
		flex-shrink: 0;
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
		height: 100%;
		width: 100%;
		align-items: center;
		justify-content: center;
		background: #fcd34d;
		color: #1c1917;
		font-size: 3.6cqw;
		font-weight: 800;
	}
	.tile.new {
		background: #86efac;
	}
	sub {
		font-size: 0.5em;
		font-weight: 600;
	}
	.prem {
		color: white;
		font-size: 1.6cqw;
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
	.rack-tile {
		display: flex;
		height: 6.5rem;
		width: 6.5rem;
		align-items: center;
		justify-content: center;
		border-radius: 0.6rem;
		background: #fcd34d;
		color: #1c1917;
		font-size: 2.5rem;
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
	.rack-tile.focused,
	.action.focused {
		opacity: 1;
		transform: translateY(calc(-0.9rem + var(--press, 0) * 1rem))
			scale(calc(1.14 - var(--press, 0) * 0.1));
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
