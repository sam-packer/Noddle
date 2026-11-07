<script lang="ts" module>
	/**
	 * Gestures for whichever development tool is open. +page.svelte sends them here. Tools sit on
	 * top of the game and switch its targets off, so that head movement asked of the player can't
	 * press anything underneath, which is why this way out can't be a normal target.
	 */
	export const toolInput: { nod: ((onset: number) => void) | null; shake: (() => void) | null } = {
		nod: null,
		shake: null
	};
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { engine } from '../vision/engine.svelte';
	import type { Point } from '../vision/math';

	let {
		onLeave,
		label = 'Leave',
		style
	}: {
		onLeave: () => void;
		label?: string;
		/** For a tool with something else in the top corner. */
		style?: string;
	} = $props();

	/** Smaller than a normal target's reach, because some tools ask for nods near the top of the screen. */
	const REACH_PX = 60;

	let el = $state<HTMLElement>();

	function aimedAt(p: Point | null) {
		if (!p || !el) return false;
		const r = el.getBoundingClientRect();
		return (
			p.x >= r.left - REACH_PX &&
			p.x <= r.right + REACH_PX &&
			p.y >= r.top - REACH_PX &&
			p.y <= r.bottom + REACH_PX
		);
	}

	const aimed = $derived(aimedAt(engine.pointer));

	onMount(() => {
		// The head moves during a nod, so it counts where the pointer was when the nod began.
		const nod = (onset: number) => {
			if (aimedAt(engine.pointerAt(onset) ?? engine.pointer)) onLeave();
		};
		toolInput.nod = nod;
		return () => {
			if (toolInput.nod === nod) toolInput.nod = null;
		};
	});
</script>

<button
	{@attach (node) => {
		el = node;
	}}
	onclick={onLeave}
	class="tool-leave"
	class:aimed
	{style}
>
	✕<span>{label}</span>
	{#if engine.lock === 'searching'}<small>Nod first to take control</small>{/if}
</button>

<style>
	.tool-leave {
		position: absolute;
		right: 2rem;
		top: 1.5rem;
		z-index: 1;
		display: flex;
		height: 7rem;
		width: 10rem;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		border-radius: 1rem;
		border: 4px solid #94a3b8;
		background: #334155;
		color: white;
		font-size: 2rem;
		font-weight: 800;
		line-height: 1;
		transition: transform 90ms ease-out;
	}
	.tool-leave span {
		margin-top: 0.3rem;
		font-size: 1.1rem;
	}
	.tool-leave small {
		margin-top: 0.2rem;
		font-size: 0.7rem;
		font-weight: 500;
	}
	.aimed {
		transform: scale(calc(1.06 - var(--press, 0) * 0.06));
		box-shadow:
			0 0 0 4px #fde047,
			0 0 45px 14px rgb(253 224 71 / 0.75);
	}
</style>
