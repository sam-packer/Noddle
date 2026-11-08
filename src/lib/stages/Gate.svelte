<script lang="ts">
	import { engine } from '../vision/engine.svelte';
	import HeadCue from './HeadCue.svelte';

	const anyInBounds = $derived(engine.faces.some((f) => f.inBounds));
	const ready = $derived(engine.status === 'ready' && anyInBounds);
	/** With others in view, it has to be clear that only one of them is the player. */
	const crowd = $derived(engine.faces.length > 1);
</script>

<div class="flex h-full flex-col items-center justify-center gap-8 text-center">
	<h1 class="text-5xl font-bold" class:text-slate-500={ready}>Stand where the camera can see you</h1>
	<!-- Side by side from the start, so the preview doesn't jump when the picture appears. -->
	<div class="flex items-center justify-center gap-8">
		<canvas
			{@attach (c) => engine.addPreview(c)}
			width="640"
			height="360"
			class="h-auto w-[min(640px,46vw)] rounded-xl border-2 border-slate-700"
		></canvas>
		<div class="flex w-[min(38vw,62vh)] flex-col items-center gap-4">
			{#if engine.status === 'loading'}
				<p class="text-2xl text-slate-300">{engine.loadMessage}…</p>
			{:else if engine.status === 'error'}
				<p class="text-2xl text-red-400">Could not start the camera or face tracking.</p>
			{:else if engine.faces.length === 0}
				<p class="text-3xl text-slate-300">Put your face inside the blue box</p>
			{:else if !anyInBounds}
				<p class="text-3xl text-amber-300">Step closer and face the screen</p>
			{:else}
				<p class="text-5xl font-bold text-emerald-300">
					{#if crowd}<span class="text-yellow-300">Yellow box:</span>{/if}
					Nod to take control
				</p>
				<HeadCue gesture="nod" size="min(38vw, 62vh)" />
			{/if}
		</div>
	</div>
</div>
