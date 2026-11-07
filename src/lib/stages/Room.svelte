<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { PUBLIC_ROOMS_URL } from '$app/env/public';
	import { onDestroy, untrack } from 'svelte';
	import { target, targets } from '../input/targets.svelte';
	import { session as log } from '../session';
	import type { ScrabbleAction, ScrabbleView } from '../games/scrabble/engine';
	import type { UnoAction, UnoView } from '../games/uno/engine';
	import { createRoom, RemoteSession, type GameKind, type LobbyState } from '../session/remote';
	import type { GameSession } from '../session/types';
	import GameExit from './GameExit.svelte';
	import Scrabble from './Scrabble.svelte';
	import Uno from './Uno.svelte';

	let { request, onExit }: { request: { join: string } | null; onExit: () => void } = $props();

	const NAME_KEY = 'noddle.name';
	const ROOMS_URL =
		PUBLIC_ROOMS_URL || (import.meta.env.DEV ? `http://${location.hostname}:8787` : '');
	const CODE_LENGTH = 5;

	function remembered(key: string) {
		try {
			return localStorage.getItem(key) ?? '';
		} catch {
			return '';
		}
	}

	let name = $state(remembered(NAME_KEY));
	let codeInput = $state('');
	let remote = $state<RemoteSession | null>(null);
	let lobby = $state<LobbyState | null>(null);
	let problem = $state('');
	let busy = $state(false);
	let stopLobby: (() => void) | undefined;

	function storage() {
		return localStorage;
	}

	function enter(code: string) {
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// The name just won't be remembered next time.
		}
		const session = new RemoteSession({ baseUrl: ROOMS_URL, code, name, storage: storage() });
		remote = session;
		stopLobby = session.lobby.subscribe((value) => (lobby = value));
		// So a reload, or sending someone this address, comes back to this room.
		replaceState(`/?room=${code}`, {});
		log.event('room', { code });
	}

	async function create(game: GameKind) {
		if (busy) return;
		busy = true;
		problem = '';
		try {
			enter(await createRoom(ROOMS_URL, game));
		} catch {
			problem = "Can't reach the game server. Single player and the demo still work.";
		} finally {
			busy = false;
		}
	}

	function join() {
		const code = codeInput.trim().toUpperCase();
		if (code.length === CODE_LENGTH) enter(code);
		else problem = `Room codes have ${CODE_LENGTH} characters.`;
	}

	let leavingLobby = $state(false);

	function leave() {
		replaceState('/', {});
		onExit();
	}

	// Opened from a shared link, so go straight in.
	const opened = untrack(() => request);
	if (opened) enter(opened.join);

	onDestroy(() => {
		stopLobby?.();
		remote?.close();
	});

	const canStart = $derived(
		!!lobby?.isHost && (lobby.game === 'uno' ? lobby.seats.length >= 1 : lobby.seats.length === 2)
	);
	const inGame = $derived(!!lobby?.hasView && lobby.phase !== 'lobby' && lobby.phase !== 'connecting');
	const link = $derived(lobby ? `${location.origin}/?room=${lobby.code}` : '');

	$effect(() => {
		if (lobby) log.event('lobby', { phase: lobby.phase, seats: lobby.seats.length, status: lobby.status });
	});
</script>

{#if lobby?.error}
	<div class="relative h-full w-full">
		<p class="absolute top-[16%] w-full text-center text-5xl font-bold">{lobby.error}</p>
		<button
			use:target={{ id: 'room-back', legal: true, confirm: leave }}
			class="big exit"
			style="left:35%;width:30vw"
			class:focused={targets.focused === 'room-back'}
		>
			✕ Back to the menu
		</button>
	</div>
{:else if !remote}
	<div class="relative h-full w-full">
		<p class="absolute top-[5%] w-full text-center text-5xl font-bold">Play with friends</p>
		<p class="absolute top-[13%] w-full text-center text-xl text-slate-300">
			Each player needs their own laptop and camera
		</p>
		{#if problem}<p class="absolute top-[19%] w-full text-center text-2xl text-amber-300">{problem}</p>{/if}

		<button
			use:target={{ id: 'room-uno', legal: !busy, confirm: () => create('uno') }}
			class="big"
			style="left:6%;background:#b91c1c"
			class:focused={targets.focused === 'room-uno'}
		>
			New Uno room<small>2 to 4 people. Bots fill the rest</small>
		</button>
		<button
			use:target={{ id: 'room-scrabble', legal: !busy, confirm: () => create('scrabble') }}
			class="big"
			style="left:37%;background:#b45309"
			class:focused={targets.focused === 'room-scrabble'}
		>
			New Scrabble room<small>2 people</small>
		</button>
		<button
			use:target={{ id: 'room-back', legal: true, confirm: leave }}
			class="big exit"
			style="right:6%"
			class:focused={targets.focused === 'room-back'}
		>
			✕ Back
		</button>

		<!-- Typing needs a keyboard, so this waits under the head-controlled choices. Links need no typing. -->
		<form
			class="absolute top-[78%] flex w-full items-center justify-center gap-4 text-xl"
			onsubmit={(e) => {
				e.preventDefault();
				join();
			}}
		>
			<label class="flex items-center gap-2">
				Your name
				<input bind:value={name} maxlength="20" placeholder="Player" class="w-44 rounded bg-slate-800 text-white" />
			</label>
			<label class="flex items-center gap-2">
				Room code
				<input
					bind:value={codeInput}
					maxlength={CODE_LENGTH}
					autocapitalize="characters"
					class="w-32 rounded bg-slate-800 text-white uppercase"
				/>
			</label>
			<button type="submit" class="rounded bg-sky-700 px-5 py-2 font-bold">Join</button>
		</form>
	</div>
{:else if inGame && lobby}
	{#if lobby.game === 'uno'}
		<Uno
			session={remote as unknown as GameSession<UnoView, UnoAction>}
			onDone={leave}
			onExit={leave}
		/>
	{:else}
		<Scrabble session={remote as unknown as GameSession<ScrabbleView, ScrabbleAction>} onExit={leave} />
	{/if}
{:else}
	<div class="relative h-full w-full">
		<p class="absolute top-[6%] w-full text-center text-3xl text-slate-300">Room code</p>
		<p class="code absolute top-[11%] w-full text-center">{lobby?.code ?? ''}</p>
		<p class="absolute top-[25%] w-full text-center text-xl text-slate-300">
			Others can open <span class="font-mono text-white">{link}</span>
		</p>

		<ul class="seats">
			{#each lobby?.seats ?? [] as seat, i (i)}
				<li>{seat.name}{i === lobby?.you ? ' (you)' : ''}</li>
			{/each}
			{#if !lobby?.seats.length}<li class="text-slate-400">Connecting…</li>{/if}
		</ul>

		<!-- A small corner button that asks first, because the room button was just under the pointer. -->
		<GameExit show bind:leaving={leavingLobby} onExit={leave} question="Leave this room?" stay="✕ Stay" />
		{#if lobby?.isHost}
			<button
				use:target={{ id: 'room-start', legal: canStart && !leavingLobby, confirm: () => remote?.start() }}
				class="big"
				style="right:6%;top:38%;height:36vh;background:#15803d"
				class:off={!canStart}
				class:focused={targets.focused === 'room-start'}
			>
				Start
				<small>
					{#if lobby.game === 'uno'}
						Bots take any empty seats
					{:else if canStart}
						Everyone's here
					{:else}
						Waiting for one more player
					{/if}
				</small>
			</button>
		{:else}
			<p class="wait">Waiting for the host to start</p>
		{/if}
	</div>
{/if}

{#if lobby?.status === 'offline' && !lobby.error}
	<div class="fixed inset-x-0 top-0 z-30 bg-amber-500 py-3 text-center text-2xl font-bold text-black">
		Connection lost. Getting you back in…
	</div>
{/if}

<style>
	.big {
		position: absolute;
		top: 26%;
		display: flex;
		height: 44vh;
		width: 26vw;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		border-radius: 1.2rem;
		border: 6px solid white;
		padding: 1rem;
		font-size: 2.2rem;
		font-weight: 800;
		line-height: 1.1;
		transition:
			transform 90ms ease-out,
			opacity 150ms;
	}
	.big small {
		font-size: 1.15rem;
		font-weight: 500;
	}
	.exit {
		background: #334155;
	}
	.off {
		opacity: 0.45;
	}
	.focused {
		transform: scale(calc(1.06 - var(--press, 0) * 0.06));
		box-shadow:
			0 0 0 4px #fde047,
			0 0 45px 14px rgb(253 224 71 / 0.75);
	}
	.code {
		font-family: ui-monospace, monospace;
		font-size: 6rem;
		font-weight: 900;
		letter-spacing: 0.15em;
		line-height: 1;
		color: #fcd34d;
	}
	.seats {
		position: absolute;
		left: 36%;
		right: 36%;
		top: 38%;
		text-align: center;
		font-size: 2rem;
		font-weight: 600;
		line-height: 1.6;
	}
	.wait {
		position: absolute;
		right: 6%;
		top: 52%;
		width: 26vw;
		text-align: center;
		font-size: 1.8rem;
		font-weight: 600;
		color: #cbd5e1;
	}
</style>
