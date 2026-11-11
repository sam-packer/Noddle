<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { targets } from '../input/targets.svelte';
	import { engine } from '../vision/engine.svelte';
	import ToolLeave from './ToolLeave.svelte';

	let { onClose }: { onClose: () => void } = $props();

	type Spot = { x: number; y: number };
	type Step = { id: string; text: string; seconds: number; dots?: Spot[] };

	/** How long each dot stays up, so the player moves at a natural speed between them. */
	const DOT_MS = 1800;

	const steps: Step[] = [
		{ id: 'still', text: 'Hold your head completely still', seconds: 5 },
		{ id: 'left-right', text: 'Slowly point your head around the screen', seconds: 7 },
		// These two must never count as gestures. Moving from the rack down to the board and
		// back is what a false nod looks like, and a quick move across is a false shake.
		{
			id: 'move-down-up',
			text: 'Follow the dot with your head. No nodding',
			seconds: 11,
			dots: [
				{ x: 35, y: 12 },
				{ x: 45, y: 62 },
				{ x: 60, y: 12 },
				{ x: 40, y: 70 }
			]
		},
		{
			id: 'move-across',
			text: 'Follow the dot with your head. No shaking',
			seconds: 11,
			dots: [
				{ x: 12, y: 30 },
				{ x: 88, y: 30 },
				{ x: 20, y: 30 },
				{ x: 80, y: 30 }
			]
		},
		{ id: 'gentle-nod', text: 'Nod gently, like picking a card. Five separate times', seconds: 11 },
		{ id: 'gentle-shake', text: 'Shake gently, like saying no. Five separate times', seconds: 11 },
		{ id: 'top-nod', text: 'Point at the top of the screen and nod three times', seconds: 7 },
		{ id: 'side-shake', text: 'Point at the middle and shake once, then rest. Three times', seconds: 9 }
	];

	let index = $state(0);
	let status = $state('');
	let dotIndex = $state(0);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dotTimer: ReturnType<typeof setInterval> | undefined;
	const marks: { id: string; t: number }[] = [];

	const dot = $derived(steps[index]?.dots?.[dotIndex % steps[index].dots!.length]);

	function run() {
		clearInterval(dotTimer);
		if (index >= steps.length) {
			finish();
			return;
		}
		marks.push({ id: steps[index].id, t: performance.now() });
		dotIndex = 0;
		if (steps[index].dots) dotTimer = setInterval(() => (dotIndex += 1), DOT_MS);
		timer = setTimeout(() => {
			index += 1;
			run();
		}, steps[index].seconds * 1000);
	}

	async function finish() {
		const frames = engine.stopRecording();
		status = 'Saving…';
		try {
			const res = await fetch('/__recording', {
				method: 'POST',
				body: JSON.stringify({
					marks,
					screen: { width: screen.width, height: screen.height },
					viewport: { width: innerWidth, height: innerHeight },
					resolution: engine.resolution,
					fps: engine.fps,
					frames
				})
			});
			// fetch only fails outright when the network does. A missing endpoint still answers.
			if (!res.ok) throw new Error(`${res.status}`);
			status = 'Saved. Tell Claude it is done.';
		} catch {
			status = 'Could not save the recording.';
		}
		timer = setTimeout(onClose, 2500);
	}

	onMount(() => {
		targets.enabled = false;
		engine.startRecording();
		run();
	});

	onDestroy(() => {
		targets.enabled = true;
		clearTimeout(timer);
		clearInterval(dotTimer);
		engine.stopRecording();
	});
</script>

<div class="fixed inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-slate-950 text-center">
	{#if dot}
		<div
			class="absolute h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500 ring-8 ring-red-500/30"
			style:left="{dot.x}%"
			style:top="{dot.y}%"
		></div>
	{/if}
	{#if index < steps.length}
		<ToolLeave onLeave={onClose} />
		<p class="px-10 text-7xl font-bold text-white">{steps[index].text}</p>
		<p class="text-3xl text-slate-400">Step {index + 1} of {steps.length}</p>
	{:else}
		<p class="text-6xl font-bold text-emerald-300">{status}</p>
	{/if}
</div>
