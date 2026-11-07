<script lang="ts">
	import { target, targets } from '../input/targets.svelte';

	/**
	 * The way out of anything that takes the player back to the menu. Leaving is never one nod away:
	 * the button only asks, and the safe answer is the one nearer that button, so a head drifting
	 * down from it reaches the stay answer first.
	 */
	let {
		show,
		leaving = $bindable(false),
		onExit,
		question = 'Leave this game?',
		stay = '✕ Keep playing',
		label = 'Leave',
		icon = '✕',
		bottom = false
	}: {
		show: boolean;
		leaving?: boolean;
		onExit: () => void;
		question?: string;
		stay?: string;
		label?: string;
		icon?: string;
		/** For a screen with something else in the top corner. */
		bottom?: boolean;
	} = $props();
</script>

{#if show && !leaving}
	<button
		use:target={{ id: 'leave', legal: true, deliberate: true, confirm: () => (leaving = true) }}
		class="leave"
		class:bottom
		class:focused={targets.focused === 'leave'}
	>
		{icon}<span>{label}</span>
	</button>
{/if}

{#if leaving}
	<div class="veil"></div>
	<p class="ask">{question}</p>
	<button
		use:target={{ id: 'leave-no', legal: true, confirm: () => (leaving = false) }}
		class="answer stay"
		class:focused={targets.focused === 'leave-no'}
	>
		{stay}
	</button>
	<button
		use:target={{ id: 'leave-yes', legal: true, confirm: onExit }}
		class="answer go"
		class:focused={targets.focused === 'leave-yes'}
	>
		{label}
	</button>
{/if}

<style>
	.leave {
		position: fixed;
		right: 2rem;
		top: 1.5rem;
		z-index: 6;
		display: flex;
		height: 6rem;
		width: 7rem;
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
	.leave.bottom {
		top: auto;
		bottom: 1.5rem;
	}
	.leave span {
		margin-top: 0.3rem;
		font-size: 1rem;
	}
	.veil {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: rgb(2 6 23 / 0.8);
	}
	.ask {
		position: fixed;
		inset-inline: 0;
		top: 12%;
		z-index: 41;
		text-align: center;
		font-size: 3rem;
		font-weight: 700;
		color: white;
	}
	.answer {
		position: fixed;
		top: 32%;
		z-index: 41;
		height: 36vh;
		width: 30vw;
		border-radius: 1.2rem;
		border: 6px solid white;
		color: white;
		font-size: 2.6rem;
		font-weight: 800;
		transition: transform 90ms ease-out;
	}
	.stay {
		right: 12%;
		background: #15803d;
	}
	.go {
		left: 12%;
		background: #b91c1c;
	}
	.focused {
		transform: scale(calc(1.06 - var(--press, 0) * 0.06));
		box-shadow:
			0 0 0 4px #fde047,
			0 0 45px 14px rgb(253 224 71 / 0.75);
	}
</style>
