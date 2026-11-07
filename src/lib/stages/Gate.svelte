<script lang="ts">
	import { engine } from '../vision/engine.svelte';

	const anyInBounds = $derived(engine.faces.some((f) => f.inBounds));
</script>

<div class="flex h-full flex-col items-center justify-center gap-6 text-center">
	<h1 class="text-5xl font-bold">Stand where the camera can see you</h1>
	<canvas {@attach (c) => engine.addPreview(c)} width="640" height="360" class="rounded-xl border-2 border-slate-700"
	></canvas>
	{#if engine.status === 'loading'}
		<p class="text-2xl text-slate-300">{engine.loadMessage}…</p>
	{:else if engine.status === 'error'}
		<p class="text-2xl text-red-400">Could not start tracking. See the panel for details.</p>
	{:else if engine.faces.length === 0}
		<p class="text-2xl text-slate-300">Put your face inside the blue box</p>
	{:else if !anyInBounds}
		<p class="text-2xl text-amber-300">Step closer and face the screen</p>
	{:else}
		<p class="text-4xl font-semibold text-emerald-300">Nod to take control (or press Enter)</p>
	{/if}
</div>
