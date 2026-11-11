<script lang="ts" module>
	export type MenuChoice = 'uno' | 'scrabble' | 'multiplayer' | 'demo';
</script>

<script lang="ts">
	import { target, targets } from '../input/targets.svelte';

	let { onChoose }: { onChoose: (choice: MenuChoice) => void } = $props();

	type Button = { id: string; title: string; text: string; color: string; confirm: () => void };

	let pickingGame = $state(false);

	// In a row across the middle: no neck strain, and far enough apart that a nod can't slide across.
	const HOME: Button[] = [
		{
			id: 'single',
			title: 'Single player',
			text: 'Against bots',
			color: '#b91c1c',
			confirm: () => (pickingGame = true)
		},
		{
			id: 'multiplayer',
			title: 'Multiplayer',
			text: 'Each on their own laptop',
			color: '#1d4ed8',
			confirm: () => onChoose('multiplayer')
		},
		{ id: 'demo', title: 'Demo', text: 'The guided tour', color: '#334155', confirm: () => onChoose('demo') }
	];
	// Back sits where Single player was, so a second nod by accident doesn't start a game.
	const GAMES: Button[] = [
		{
			id: 'back',
			title: '✕ Back',
			text: 'To the menu',
			color: '#334155',
			confirm: () => (pickingGame = false)
		},
		{ id: 'uno', title: 'Uno', text: 'Against three bots', color: '#b91c1c', confirm: () => onChoose('uno') },
		{ id: 'scrabble', title: 'Scrabble', text: 'Against a bot', color: '#b45309', confirm: () => onChoose('scrabble') }
	];

	const buttons = $derived(pickingGame ? GAMES : HOME);

	$effect(() => (pickingGame ? targets.claimCancel(() => (pickingGame = false)) : undefined));
</script>

<div class="relative h-full w-full">
	<p class="absolute top-[10%] w-full text-center text-5xl font-bold">
		{pickingGame ? 'Which game?' : 'What would you like to play?'}
	</p>
	<div class="row">
		{#each buttons as button (button.id)}
			<button
				use:target={{ id: `menu-${button.id}`, legal: true, confirm: button.confirm }}
				class="choice"
				style:background={button.color}
			>
				<span class="title">{button.title}</span>
				<span class="text">{button.text}</span>
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
		width: 27vw;
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
	.choice:global([data-focused]) {
		transform: scale(calc(1.06 - var(--press, 0) * 0.06));
		box-shadow:
			0 0 0 4px #fde047,
			0 0 45px 14px rgb(253 224 71 / 0.75);
	}
</style>
