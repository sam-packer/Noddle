<script lang="ts">
	import { target, targets } from '../input/targets.svelte';
	import { engine } from '../vision/engine.svelte';

	let { onDone }: { onDone: () => void } = $props();

	const spots = [
		{ x: 10, y: 20 },
		{ x: 90, y: 20 },
		{ x: 90, y: 58 },
		{ x: 10, y: 58 },
		{ x: 50, y: 58 }
	];

	let step = $state(0);
	const finished = $derived(step >= spots.length);
	/** Fills as the head moves, and is full once the nod is big enough to count. */
	const nodMeter = $derived(targets.focused ? engine.nodProgress : 0);
	const needsAim = $derived(!finished && targets.missedNods > 0 && !targets.focused);

	$effect(() => (finished ? targets.claimCancel(onDone) : undefined));
</script>

<div class="relative h-full w-full">
	<div class="absolute top-[8%] left-1/2 w-3/5 -translate-x-1/2 text-center">
		{#if finished}
			<p class="text-5xl font-bold">Shake your head to go back</p>
			<p class="mt-3 text-2xl text-slate-300">Make it a quick one: to the side and back. Then let's play</p>
		{:else}
			<p class="text-5xl font-bold">Point your head at the glowing card, then nod</p>
			<p class="mt-3 text-2xl text-slate-300">
				{needsAim ? 'Almost! Point at the glowing card first' : 'A small nod is plenty: down and back up'}
			</p>
			<div class="meter" aria-hidden="true">
				<div class="fill" class:full={nodMeter >= 1} style:width="{nodMeter * 100}%"></div>
			</div>
		{/if}
	</div>

	{#each spots as spot, i (i)}
		<button
			use:target={{
				id: `spot-${i}`,
				legal: step === i,
				calib: true,
				confirm: () => (step = i + 1)
			}}
			class="absolute h-44 w-32 -translate-x-1/2 -translate-y-1/2 rounded-xl border-4 text-5xl font-bold transition-all"
			class:glow={step === i}
			class:focused={targets.focused === `spot-${i}`}
			class:done={step > i}
			class:idle={step < i}
			class:hidden-spot={finished && i < spots.length - 1}
			style:left="{spot.x}%"
			style:top="{spot.y}%"
			aria-label="Card {i + 1}"
		>
			{step > i ? '✓' : ''}
		</button>
	{/each}
</div>

<style>
	.glow {
		background: #f59e0b;
		border-color: #fde68a;
		box-shadow: 0 0 50px 12px rgb(251 191 36 / 0.7);
	}
	/* Lights up only while the pointer is on it, so a nod clearly has something to land on. */
	.focused {
		background: #fde047;
		border-color: white;
		box-shadow:
			0 0 0 6px white,
			0 0 70px 22px rgb(253 224 71 / 0.9);
		transform: translateY(calc(var(--press, 0) * 1.2rem)) scale(calc(1.1 - var(--press, 0) * 0.08));
	}
	.meter {
		height: 0.9rem;
		width: 60%;
		margin: 0.9rem auto 0;
		overflow: hidden;
		border-radius: 0.5rem;
		background: #1e293b;
	}
	.fill {
		height: 100%;
		background: #fbbf24;
		transition: width 60ms linear;
	}
	.fill.full {
		background: #34d399;
	}
	.done {
		background: #065f46;
		border-color: #34d399;
		color: #a7f3d0;
	}
	.idle {
		background: #1e293b;
		border-color: #334155;
	}
	.hidden-spot {
		opacity: 0.25;
	}
</style>
