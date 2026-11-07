<script lang="ts">
	import { target, targets } from '../input/targets.svelte';

	/**
	 * The way out of a game. Leaving is never one nod away: the button only asks, and the safe answer
	 * sits where a second nod would land.
	 */
	let {
		show,
		leaving = $bindable(false),
		onExit
	}: { show: boolean; leaving?: boolean; onExit: () => void } = $props();
</script>

{#if show && !leaving}
	<button
		use:target={{ id: 'leave', legal: true, confirm: () => (leaving = true) }}
		class="leave"
		class:focused={targets.focused === 'leave'}
	>
		✕<span>Leave</span>
	</button>
{/if}

{#if leaving}
	<div class="veil"></div>
	<p class="ask">Leave this game?</p>
	<button
		use:target={{ id: 'leave-no', legal: true, confirm: () => (leaving = false) }}
		class="answer stay"
		class:focused={targets.focused === 'leave-no'}
	>
		✕ Keep playing
	</button>
	<button
		use:target={{ id: 'leave-yes', legal: true, confirm: onExit }}
		class="answer go"
		class:focused={targets.focused === 'leave-yes'}
	>
		Leave
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
		left: 12%;
		background: #15803d;
	}
	.go {
		right: 12%;
		background: #b91c1c;
	}
	.focused {
		transform: scale(calc(1.06 - var(--press, 0) * 0.06));
		box-shadow:
			0 0 0 4px #fde047,
			0 0 45px 14px rgb(253 224 71 / 0.75);
	}
</style>
