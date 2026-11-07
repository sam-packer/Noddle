<script lang="ts">
	type Gesture = 'point' | 'nod' | 'shake';

	let { gesture, size = 'clamp(120px, 28vw, 400px)' }: { gesture: Gesture; size?: string } = $props();

	/** So two pictures on one screen don't share a clip path. */
	const uid = $props.id();

	const LABELS: Record<Gesture, string> = {
		point: 'Turn your head and the dot moves onto a card, which lights up',
		nod: 'Nod and the lit card is picked',
		shake: 'Shake your head and the tile flies back to the rack'
	};
	const BOARD_CELLS = Array.from({ length: 15 }, (_, i) => ({ x: 279 + (i % 5) * 31, y: 50 + Math.floor(i / 5) * 31 }));
	const RACK_TILES = [0, 1, 2, 4].map((col) => 279 + col * 31);
</script>

<!--
	The picture without animation is the still frame for prefers-reduced-motion, so every base style
	below shows the gesture's result and every animation only runs when motion is welcome.
-->
<svg class="cue {gesture}" viewBox="0 0 460 260" style:width={size} role="img" aria-label={LABELS[gesture]}>
	<defs>
		<clipPath id="{uid}-head">
			<ellipse cx="126" cy="130" rx="66" ry="78" />
		</clipPath>
	</defs>

	<!-- The outline stays put and the features slide inside it, which reads as the head turning. -->
	<g class="head">
		<ellipse class="p ear" cx="60" cy="138" rx="11" ry="20" />
		<ellipse class="p ear" cx="192" cy="138" rx="11" ry="20" />
		<ellipse class="skull" cx="126" cy="130" rx="66" ry="78" />
		<g clip-path="url(#{uid}-head)">
			<circle class="p cheek" cx="84" cy="156" r="12" />
			<circle class="p cheek" cx="168" cy="156" r="12" />
			<path class="p hair" d="M -10 -10 H 262 V 150 C 216 110 184 84 126 84 C 68 84 36 110 -10 150 Z" />
			<circle class="p eye" cx="100" cy="128" r="10" />
			<circle class="p eye" cx="152" cy="128" r="10" />
			<path class="p nose" d="M 126 134 V 148 H 119" />
			<path class="p mouth" d="M 102 169 Q 126 192 150 169" />
		</g>
		<ellipse class="rim" cx="126" cy="130" rx="66" ry="78" />
	</g>

	<!-- A small laptop, so the picture says "and on the screen, this happens". -->
	<rect class="base" x="246" y="204" width="214" height="16" rx="8" />
	<rect class="screen" x="258" y="40" width="194" height="166" rx="12" />

	{#if gesture === 'point'}
		<path class="arrow go-left" d="M 36 130 H 6 M 21 114 L 6 130 L 21 146" />
		<path class="arrow go-right" d="M 218 130 H 248 M 233 114 L 248 130 L 233 146" />
		<path class="arrow go-up" d="M 126 44 V 10 M 110 25 L 126 10 L 142 25" />
		<path class="arrow go-down" d="M 126 216 V 250 M 110 235 L 126 250 L 142 235" />

		{#each [{ name: 'left', x: 269, y: 101 }, { name: 'right', x: 407, y: 101 }, { name: 'up', x: 338, y: 47 }, { name: 'down', x: 338, y: 155 }] as card (card.name)}
			<rect class="card-dim" x={card.x} y={card.y} width="34" height="44" rx="6" />
			<g class="lit lit-{card.name}">
				<rect class="halo" x={card.x - 6} y={card.y - 6} width="46" height="56" rx="10" />
				<rect class="card-lit" x={card.x} y={card.y} width="34" height="44" rx="6" />
			</g>
		{/each}
		<circle class="dot point-dot" cx="355" cy="123" r="11" />
	{:else if gesture === 'nod'}
		<path class="arrow dip" d="M 24 84 V 172 M 6 153 L 24 172 L 42 153" />
		<path class="arrow dip" d="M 228 84 V 172 M 210 153 L 228 172 L 246 153" />
		<path class="arrow rise" d="M 24 172 V 84 M 6 103 L 24 84 L 42 103" />
		<path class="arrow rise" d="M 228 172 V 84 M 210 103 L 228 84 L 246 103" />

		<rect class="card-dim" x="266" y="92" width="44" height="62" rx="7" />
		<rect class="card-dim" x="400" y="92" width="44" height="62" rx="7" />
		<g class="rays">
			<path d="M 355 62 V 48 M 311 79 L 301 69 M 399 79 L 409 69 M 311 167 L 301 177 M 399 167 L 409 177 M 355 184 V 198" />
		</g>
		<g class="pressed">
			<rect class="card-lit" x="324" y="80" width="62" height="86" rx="9" />
			<rect class="card-done" x="324" y="80" width="62" height="86" rx="9" />
			<path class="check" d="M 338 124 L 351 138 L 373 108" />
		</g>
		<circle class="dot nod-dot" cx="355" cy="123" r="11" />
	{:else}
		<path class="arrow swing-left" d="M 36 130 H 6 M 21 114 L 6 130 L 21 146" />
		<path class="arrow swing-right" d="M 218 130 H 248 M 233 114 L 248 130 L 233 146" />

		{#each BOARD_CELLS as cell (`${cell.x},${cell.y}`)}
			<rect class="cell" x={cell.x} y={cell.y} width="28" height="28" rx="4" />
		{/each}
		<rect class="ghost" x="279" y="81" width="28" height="28" rx="4" />
		<rect class="rack" x="273" y="152" width="164" height="44" rx="7" />
		{#each RACK_TILES as x (x)}
			<rect class="rack-tile" {x} y="160" width="28" height="28" rx="4" />
		{/each}
		<rect class="slot" x="372" y="160" width="28" height="28" rx="4" />
		<path class="flight" d="M 293 90 C 310 42 400 70 386 150" />
		<rect class="landed" x="366" y="154" width="40" height="40" rx="8" />
		<g class="tile">
			<rect x="279" y="81" width="28" height="28" rx="4" />
			<text x="293" y="102">D</text>
		</g>
	{/if}
</svg>

<style>
	.cue {
		--arrow: #fbbf24;
		display: block;
		flex: none;
		height: auto;
		max-width: 100%;
		pointer-events: none;
	}
	.nod {
		--arrow: #34d399;
	}
	.shake {
		--arrow: #fb7185;
	}

	/* The head. --d is how far each part slides: the nose is nearest, the ears go the other way. */
	.p {
		--d: 1;
	}
	.hair {
		--d: 0.75;
		fill: #92400e;
	}
	.nose {
		--d: 1.4;
		fill: none;
		stroke: #c2410c;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 6;
	}
	.mouth {
		--d: 0.85;
		fill: none;
		stroke: #0f172a;
		stroke-linecap: round;
		stroke-width: 8;
	}
	.ear {
		--d: -0.25;
		fill: #fdba74;
		stroke: white;
		stroke-width: 5;
	}
	.skull {
		fill: #fed7aa;
	}
	.rim {
		fill: none;
		stroke: white;
		stroke-width: 5;
	}
	.eye {
		fill: #0f172a;
	}
	.cheek {
		fill: #fb7185;
		opacity: 0.4;
	}

	.arrow {
		fill: none;
		stroke: var(--arrow);
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 11;
	}

	.screen {
		fill: #0f172a;
		stroke: #94a3b8;
		stroke-width: 5;
	}
	.base {
		fill: #64748b;
	}
	.card-dim {
		fill: #334155;
		stroke: #64748b;
		stroke-width: 3;
	}
	.card-lit {
		fill: #fde047;
		stroke: white;
		stroke-width: 4;
	}
	.halo {
		fill: #fbbf24;
		opacity: 0.4;
	}
	.dot {
		fill: white;
		stroke: #0f172a;
		stroke-width: 4;
	}

	/* The still frame of each gesture. */
	.point .p {
		transform: translate(calc(var(--d) * 28px), 0);
	}
	.point-dot {
		transform: translate(69px, 0);
	}
	.lit {
		opacity: 0;
	}
	.lit-right {
		opacity: 1;
	}

	.nod .p {
		transform: translate(0, calc(var(--d) * 26px));
	}
	.nod .head {
		transform: translateY(10px);
	}
	.pressed {
		transform: scale(1.14);
		transform-box: view-box;
		transform-origin: 355px 123px;
	}
	.card-done {
		fill: #10b981;
		stroke: #a7f3d0;
		stroke-width: 4;
	}
	.check {
		fill: none;
		stroke: white;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 12;
		transform-box: view-box;
		transform-origin: 355px 123px;
	}
	.nod-dot {
		opacity: 0;
	}
	.rays {
		fill: none;
		stroke: #6ee7b7;
		stroke-linecap: round;
		stroke-width: 7;
		transform-box: view-box;
		transform-origin: 355px 123px;
	}

	.shake .p {
		transform: translate(calc(var(--d) * 30px), 0);
	}
	.cell {
		fill: #334155;
	}
	.ghost {
		fill: #0f172a;
		stroke: #fbbf24;
		stroke-dasharray: 5 4;
		stroke-width: 3;
	}
	.rack {
		fill: #475569;
	}
	.rack-tile {
		fill: #cbd5e1;
	}
	.slot {
		fill: #1e293b;
	}
	.flight {
		fill: none;
		stroke: #fb7185;
		stroke-dasharray: 3 12;
		stroke-linecap: round;
		stroke-width: 6;
	}
	.landed {
		fill: none;
		stroke: #34d399;
		stroke-width: 6;
	}
	.tile {
		transform: translate(93px, 79px);
		transform-box: fill-box;
		transform-origin: center;
	}
	.tile rect {
		fill: #fde047;
		stroke: white;
		stroke-width: 3;
	}
	.tile text {
		fill: #0f172a;
		font-size: 21px;
		font-weight: 800;
		text-anchor: middle;
	}

	@media (prefers-reduced-motion: no-preference) {
		/* Left, right, up, down: 2s each, with a second's hold on the card that lit up. */
		.point .p {
			animation: point-face 8s infinite;
		}
		.point-dot {
			animation: point-dot 8s infinite;
		}
		.lit,
		.go-left,
		.go-right,
		.go-up,
		.go-down {
			animation: quarter 8s infinite;
		}
		.lit-right,
		.go-right {
			animation-delay: -6s;
		}
		.lit-up,
		.go-up {
			animation-delay: -4s;
		}
		.lit-down,
		.go-down {
			animation-delay: -2s;
		}
		.go-left,
		.go-right,
		.go-up,
		.go-down {
			animation-name: quarter-early;
		}

		/* One dip and back, then the card pops and the result holds for over two seconds. */
		.nod .p {
			animation: nod-face 5s infinite;
		}
		.nod .head {
			animation: nod-head 5s infinite;
		}
		.dip {
			animation: nod-dip 5s infinite;
		}
		.rise {
			animation: nod-rise 5s infinite;
		}
		.pressed {
			animation: nod-card 5s infinite;
		}
		.card-done {
			animation: nod-done 5s infinite;
		}
		.check {
			animation: nod-check 5s infinite;
		}
		.nod-dot {
			animation: nod-dot 5s infinite;
		}
		.rays {
			animation: nod-rays 5s infinite;
		}

		/* Four quick swings, then the tile flies home and the result holds for nearly two seconds. */
		.shake .p {
			animation: shake-face 5s infinite;
		}
		.swing-left {
			animation: swing-left 5s infinite;
		}
		.swing-right {
			animation: swing-right 5s infinite;
		}
		.tile {
			animation: shake-tile 5s infinite;
		}
		.ghost {
			animation: shake-ghost 5s infinite;
		}
		.flight {
			animation: shake-flight 5s infinite;
		}
		.landed {
			animation: shake-landed 5s infinite;
		}
	}

	@keyframes point-face {
		0%,
		2%,
		25%,
		27%,
		50%,
		52%,
		75%,
		77%,
		100% {
			transform: translate(0, 0);
		}
		7%,
		20% {
			transform: translate(calc(var(--d) * -28px), 0);
		}
		32%,
		45% {
			transform: translate(calc(var(--d) * 28px), 0);
		}
		57%,
		70% {
			transform: translate(0, calc(var(--d) * -24px));
		}
		82%,
		95% {
			transform: translate(0, calc(var(--d) * 24px));
		}
	}
	@keyframes point-dot {
		0%,
		2%,
		25%,
		27%,
		50%,
		52%,
		75%,
		77%,
		100% {
			transform: translate(0, 0);
		}
		7%,
		20% {
			transform: translate(-69px, 0);
		}
		32%,
		45% {
			transform: translate(69px, 0);
		}
		57%,
		70% {
			transform: translate(0, -54px);
		}
		82%,
		95% {
			transform: translate(0, 54px);
		}
	}
	/* The card lights as the dot lands on it. */
	@keyframes quarter {
		0%,
		5%,
		23%,
		100% {
			opacity: 0;
		}
		7%,
		20% {
			opacity: 1;
		}
	}
	/* The arrow leads the head, and is gone before the head comes back. */
	@keyframes quarter-early {
		0%,
		22%,
		100% {
			opacity: 0;
		}
		1%,
		18% {
			opacity: 1;
		}
	}

	@keyframes nod-face {
		0%,
		10%,
		34%,
		100% {
			transform: translate(0, 0);
		}
		20%,
		24% {
			transform: translate(0, calc(var(--d) * 26px));
		}
	}
	@keyframes nod-head {
		0%,
		10%,
		34%,
		100% {
			transform: translateY(0);
		}
		20%,
		24% {
			transform: translateY(10px);
		}
	}
	@keyframes nod-dip {
		0%,
		8%,
		26%,
		100% {
			opacity: 0;
		}
		11%,
		23% {
			opacity: 1;
		}
	}
	@keyframes nod-rise {
		0%,
		23%,
		38%,
		100% {
			opacity: 0;
		}
		26%,
		35% {
			opacity: 1;
		}
	}
	@keyframes nod-card {
		0%,
		10%,
		30%,
		96%,
		100% {
			transform: scale(1);
		}
		22% {
			transform: translateY(6px) scale(0.92);
		}
		37% {
			transform: scale(1.32);
		}
		43%,
		91% {
			transform: scale(1.14);
		}
	}
	@keyframes nod-done {
		0%,
		31%,
		95%,
		100% {
			opacity: 0;
		}
		35%,
		91% {
			opacity: 1;
		}
	}
	@keyframes nod-check {
		0%,
		31%,
		95%,
		100% {
			opacity: 0;
			transform: scale(0.3);
		}
		37% {
			opacity: 1;
			transform: scale(1.3);
		}
		43%,
		91% {
			opacity: 1;
			transform: scale(1);
		}
	}
	@keyframes nod-dot {
		0%,
		29%,
		97%,
		100% {
			opacity: 1;
		}
		33%,
		93% {
			opacity: 0;
		}
	}
	@keyframes nod-rays {
		0%,
		34%,
		52%,
		100% {
			opacity: 0;
			transform: scale(0.75);
		}
		38% {
			opacity: 1;
			transform: scale(1);
		}
		46% {
			opacity: 1;
			transform: scale(1.1);
		}
	}

	@keyframes shake-face {
		0%,
		8%,
		33.5%,
		100% {
			transform: translate(0, 0);
		}
		12.5%,
		23.5% {
			transform: translate(calc(var(--d) * -30px), 0);
		}
		18%,
		29% {
			transform: translate(calc(var(--d) * 30px), 0);
		}
	}
	@keyframes swing-left {
		0%,
		6%,
		34%,
		100% {
			opacity: 0;
		}
		9%,
		12.5%,
		23.5% {
			opacity: 1;
		}
		18%,
		29% {
			opacity: 0.2;
		}
	}
	@keyframes swing-right {
		0%,
		6%,
		34%,
		100% {
			opacity: 0;
		}
		9%,
		12.5%,
		23.5% {
			opacity: 0.2;
		}
		18%,
		29% {
			opacity: 1;
		}
	}
	@keyframes shake-tile {
		0%,
		34%,
		100% {
			opacity: 1;
			transform: translate(0, 0);
		}
		42% {
			opacity: 1;
			transform: translate(38px, -36px) scale(1.5) rotate(-14deg);
		}
		50% {
			opacity: 1;
			transform: translate(93px, 79px) scale(0.95);
		}
		53% {
			opacity: 1;
			transform: translate(93px, 79px) scale(1.2);
		}
		56%,
		91% {
			opacity: 1;
			transform: translate(93px, 79px);
		}
		94% {
			opacity: 0;
			transform: translate(93px, 79px);
		}
		95% {
			opacity: 0;
			transform: translate(0, 0);
		}
	}
	@keyframes shake-ghost {
		0%,
		35%,
		95%,
		100% {
			opacity: 0;
		}
		38%,
		92% {
			opacity: 1;
		}
	}
	@keyframes shake-flight {
		0%,
		36%,
		94%,
		100% {
			opacity: 0;
		}
		40%,
		91% {
			opacity: 1;
		}
	}
	@keyframes shake-landed {
		0%,
		49%,
		94%,
		100% {
			opacity: 0;
		}
		52%,
		91% {
			opacity: 1;
		}
	}
</style>
