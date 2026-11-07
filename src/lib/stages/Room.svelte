<script lang="ts">
	let { onExit }: { request: { join: string } | null; onExit: () => void } = $props();
</script>

<button class="m-8 text-2xl" onclick={onExit}>Multiplayer is coming</button>
