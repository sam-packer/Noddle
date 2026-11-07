<script lang="ts" module>
	export type MenuChoice = 'uno' | 'scrabble' | 'multiplayer' | 'demo';
</script>

<script lang="ts">
	import { target, targets } from '../input/targets.svelte';

	let { onChoose }: { onChoose: (choice: MenuChoice) => void } = $props();

	// In a row across the middle: no neck strain, and far enough apart that a nod can't slide across.
	const CHOICES: { id: MenuChoice; title: string; text: string; color: string }[] = [
		{ id: 'uno', title: 'Uno', text: 'Against three bots', color: '#b91c1c' },
		{ id: 'scrabble', title: 'Scrabble', text: 'Against a bot', color: '#b45309' },
		{ id: 'multiplayer', title: 'With friends', text: 'Each on their own laptop', color: '#1d4ed8' },
		{ id: 'demo', title: 'Guided demo', text: 'The quick tour', color: '#334155' }
	];
</script>

<div class="relative h-full w-full">
	<p class="absolute top-[10%] w-full text-center text-5xl font-bold">What would you like to play?</p>
	<div class="row">
		{#each CHOICES as choice (choice.id)}
			<button
				use:target={{ id: `menu-${choice.id}`, legal: true, confirm: () => onChoose(choice.id) }}
				class="choice"
				class:focused={targets.focused === `menu-${choice.id}`}
				style:background={choice.color}
			>
				<span class="title">{choice.title}</span>
				<span class="text">{choice.text}</span>
			</button>
		{/each}
	</div>
</div>

<style>
	.row {
		position: absolute;
		left: 0;
		right: 0;
		top: 28%;
		display: flex;
		justify-content: center;
		gap: 3vw;
		padding: 0 3vw;
	}
	.choice {
		display: flex;
		height: 44vh;
		width: 20vw;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		border-radius: 1.2rem;
		border: 6px solid white;
		padding: 1rem;
		transition: transform 90ms ease-out;
	}
	.title {
		font-size: 2.6rem;
		font-weight: 800;
		line-height: 1.1;
	}
	.text {
		font-size: 1.25rem;
		font-weight: 500;
	}
	.focused {
		transform: scale(calc(1.06 - var(--press, 0) * 0.06));
		box-shadow:
			0 0 0 4px #fde047,
			0 0 45px 14px rgb(253 224 71 / 0.75);
	}
</style>
