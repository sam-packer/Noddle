<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { PUBLIC_ROOMS_URL } from '$app/env/public';
	import { onDestroy, untrack } from 'svelte';
	import { target, targets } from '../input/targets.svelte';
	import { session as log } from '../session';
	import { createRoom, RemoteSession, type GameKind, type LobbyState } from '../session/remote';
	import GameExit from './GameExit.svelte';
	import Scrabble from './Scrabble.svelte';
	import Uno from './Uno.svelte';

	let { request, onExit }: { request: { join: string } | null; onExit: () => void } = $props();

	const NAME_KEY = 'noddle.name';
	const ROOMS_URL =
		PUBLIC_ROOMS_URL || (import.meta.env.DEV ? `http://${location.hostname}:8787` : '');
	const CODE_LENGTH = 5;
	/**
	 * Every character a code can hold, from CODE_LETTERS in workers/rooms/src/index.ts, which leaves
	 * out I, L, O, 0 and 1. Each group fits across the screen at a size that's easy to point at.
	 */
	const CODE_GROUPS = ['ABCDEF', 'GHJKMN', 'PQRSTU', 'VWXYZ', '2345', '6789'];

	function remembered(key: string) {
		try {
			return localStorage.getItem(key) ?? '';
		} catch {
			return '';
		}
	}

	/** Typing a name takes hands, so nobody is asked for one. The server calls a blank name Player. */
	const name = remembered(NAME_KEY);
	let remote = $state<RemoteSession | null>(null);
	let lobby = $state<LobbyState | null>(null);
	let problem = $state('');
	let busy = $state(false);
	let stopLobby: (() => void) | undefined;
	let gone = false;
	/** Picking a code by head: a group of characters, then the character. */
	let joining = $state(false);
	let picked = $state('');
	let codeGroup = $state<string | null>(null);
	const codeReady = $derived(picked.length === CODE_LENGTH);
	/** A room that turned this code away. Anything that goes wrong after joining isn't about the code. */
	const canFixCode = $derived(codeReady && lobby?.phase === 'connecting');
	const canStepBack = $derived(!!codeGroup || picked.length > 0);
	const codePrompt = $derived(
		codeReady
			? 'Join this room?'
			: codeGroup
				? `Which one is character ${picked.length + 1}?`
				: `Pick the group with character ${picked.length + 1}`
	);

	function storage() {
		return localStorage;
	}

	function enter(code: string) {
		joining = false;
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
			const code = await createRoom(ROOMS_URL, game);
			// The player may have backed out while waiting.
			if (!gone) enter(code);
		} catch {
			problem = "Can't reach the game server. Single player and the demo still work.";
		} finally {
			busy = false;
		}
	}

	function pickCharacter(character: string) {
		picked += character;
		codeGroup = null;
	}

	function codeStepBack() {
		if (codeGroup) codeGroup = null;
		else picked = picked.slice(0, -1);
	}

	function closeCodePicker() {
		joining = false;
		picked = '';
		codeGroup = null;
	}

	/** The code didn't work, so go back to it to fix it. It's probably one character out. */
	function retryCode() {
		stopLobby?.();
		remote?.close();
		remote = null;
		lobby = null;
		replaceState('/', {});
		joining = true;
	}

	$effect(() => (joining ? targets.claimCancel(codeStepBack) : undefined));

	let leavingLobby = $state(false);

	function leave() {
		replaceState('/', {});
		onExit();
	}

	// Opened from a shared link, so go straight in.
	const opened = untrack(() => request);
	if (opened) enter(opened.join);

	onDestroy(() => {
		gone = true;
		stopLobby?.();
		remote?.close();
	});

	const canStart = $derived(
		!!lobby?.isHost && (lobby.game === 'uno' ? lobby.seats.length >= 1 : lobby.seats.length === 2)
	);
	const inGame = $derived(!!lobby?.hasView && lobby.phase !== 'lobby' && lobby.phase !== 'connecting');
	// Each is the same object for as long as the room lasts, so a screen keeps its session.
	const unoSession = $derived(inGame && lobby?.game === 'uno' ? (remote?.as('uno') ?? null) : null);
	const scrabbleSession = $derived(inGame && lobby?.game === 'scrabble' ? (remote?.as('scrabble') ?? null) : null);
	const link = $derived(lobby ? `${location.origin}/?room=${lobby.code}` : '');

	$effect(() => {
		if (lobby) log.event('lobby', { phase: lobby.phase, seats: lobby.seats.length, status: lobby.status });
	});
</script>

{#if lobby?.error}
	<div class="relative h-full w-full">
		<p class="absolute top-[16%] w-full text-center text-5xl font-bold">{lobby.error}</p>
		{#if canFixCode}
			<button
				use:target={{ id: 'room-error-retry', legal: true, confirm: retryCode }}
				class="big"
				style="left:14%;width:30vw;background:#1d4ed8"
				class:focused={targets.focused === 'room-error-retry'}
			>
				Fix the code<small>{picked}</small>
			</button>
		{/if}
		<button
			use:target={{ id: 'room-error-back', legal: true, confirm: leave }}
			class="big exit"
			style={canFixCode ? 'right:14%;width:30vw' : 'left:35%;width:30vw'}
			class:focused={targets.focused === 'room-error-back'}
		>
			✕ Back to the menu
		</button>
	</div>
{:else if !remote && joining}
	<div class="relative h-full w-full">
		<p class="absolute top-[4%] w-full text-center text-4xl font-bold">{codePrompt}</p>
		<div class="slots" aria-label="Room code so far">
			{#each { length: CODE_LENGTH } as _, i (i)}
				<span class="slot" class:next={i === picked.length}>{picked[i] ?? ''}</span>
			{/each}
		</div>

		{#if canStepBack}
			<button
				use:target={{ id: 'code-back', legal: true, confirm: codeStepBack }}
				class="corner"
				style="left:2rem"
				class:focused={targets.focused === 'code-back'}
			>
				{codeGroup ? '‹ Back' : `‹ Undo ${picked[picked.length - 1]}`}
			</button>
		{/if}
		<button
			use:target={{ id: 'code-leave', legal: true, confirm: closeCodePicker }}
			class="corner"
			style="right:2rem;background:#b91c1c"
			class:focused={targets.focused === 'code-leave'}
		>
			✕ Leave
		</button>

		<div class="choices">
			{#if codeReady}
				<button
					use:target={{ id: 'code-join', legal: true, confirm: () => enter(picked) }}
					class="choice join"
					class:focused={targets.focused === 'code-join'}
				>
					Join {picked}
				</button>
			{:else if codeGroup}
				{#each [...codeGroup] as character (character)}
					<button
						use:target={{ id: `code-${character}`, legal: true, confirm: () => pickCharacter(character) }}
						class="choice"
						class:focused={targets.focused === `code-${character}`}
					>
						{character}
					</button>
				{/each}
			{:else}
				{#each CODE_GROUPS as group (group)}
					<button
						use:target={{ id: `code-group-${group}`, legal: true, confirm: () => (codeGroup = group) }}
						class="choice group"
						class:focused={targets.focused === `code-group-${group}`}
					>
						<!-- Every character, not a range, because a range would suggest the ones codes skip. -->
						{#each [...group] as character (character)}<span>{character}</span>{/each}
					</button>
				{/each}
			{/if}
		</div>
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
			style="left:4%;width:20vw;background:#b91c1c"
			class:focused={targets.focused === 'room-uno'}
		>
			New Uno room<small>2 to 4 people. Bots fill the rest</small>
		</button>
		<button
			use:target={{ id: 'room-scrabble', legal: !busy, confirm: () => create('scrabble') }}
			class="big"
			style="left:28%;width:20vw;background:#b45309"
			class:focused={targets.focused === 'room-scrabble'}
		>
			New Scrabble room<small>2 people</small>
		</button>
		<button
			use:target={{ id: 'room-join', legal: !busy, confirm: () => (joining = true) }}
			class="big"
			style="left:52%;width:20vw;background:#1d4ed8"
			class:focused={targets.focused === 'room-join'}
		>
			Join with a code<small>Someone else's room</small>
		</button>
		<button
			use:target={{ id: 'room-back', legal: true, confirm: leave }}
			class="big exit"
			style="left:76%;width:20vw"
			class:focused={targets.focused === 'room-back'}
		>
			✕ Back
		</button>
	</div>
{:else if unoSession}
	<Uno session={unoSession} onDone={leave} onExit={leave} />
{:else if scrabbleSession}
	<Scrabble session={scrabbleSession} onExit={leave} />
{:else}
	<div class="relative h-full w-full">
		<p class="absolute top-[6%] w-full text-center text-3xl text-slate-300">Room code</p>
		<p class="code absolute top-[11%] w-full text-center">{lobby?.code ?? ''}</p>
		<p class="absolute top-[25%] w-full text-center text-xl text-slate-300">
			Others can open <span class="font-mono text-white">{link}</span>, or choose Join with a code
		</p>

		<ul class="seats">
			{#each lobby?.seats ?? [] as seat, i (i)}
				<li class:away={!seat.connected}>
					{seat.name}{i === lobby?.you ? ' (you)' : ''}{seat.connected ? '' : ' (away)'}
				</li>
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
		{:else if lobby?.phase === 'lobby'}
			<p class="wait">Waiting for the host to start</p>
		{/if}
	</div>
{/if}

{#if lobby?.status === 'offline' && !lobby.error}
	<div class="offline">
		{lobby.phase === 'connecting' ? "Can't reach the game server. Still trying…" : 'Connection lost. Getting you back in…'}
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
	.slots {
		position: absolute;
		top: 12%;
		width: 100%;
		display: flex;
		justify-content: center;
		gap: 0.75rem;
	}
	.slot {
		display: flex;
		height: 5.5rem;
		width: 4.5rem;
		align-items: center;
		justify-content: center;
		border-radius: 0.6rem;
		border: 3px solid #475569;
		background: #1e293b;
		color: #fcd34d;
		font-family: ui-monospace, monospace;
		font-size: 3.2rem;
		font-weight: 900;
	}
	.slot.next {
		border-color: #fcd34d;
	}
	.corner {
		position: absolute;
		top: 1.5rem;
		height: 7rem;
		width: 11rem;
		border-radius: 1rem;
		border: 5px solid white;
		background: #334155;
		font-size: 1.6rem;
		font-weight: 800;
		transition: transform 90ms ease-out;
	}
	/* High on the screen, and as far apart as the row allows, like the blank tile picker in Scrabble. */
	.choices {
		position: absolute;
		left: 3%;
		right: 3%;
		top: 30%;
		display: flex;
		justify-content: center;
		gap: 3vw;
	}
	.choice {
		height: 36vh;
		width: 13vw;
		border-radius: 1.2rem;
		border: 6px solid white;
		background: #fcd34d;
		color: #1c1917;
		font-family: ui-monospace, monospace;
		font-size: 4.5rem;
		font-weight: 800;
		transition: transform 90ms ease-out;
	}
	.choice.group {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		place-items: center;
		align-content: center;
		row-gap: 0.75rem;
		padding: 0.5rem;
		font-size: 2.8rem;
		line-height: 1;
	}
	.choice.join {
		width: 44vw;
		background: #15803d;
		color: white;
		font-size: 3.5rem;
	}
	.offline {
		position: fixed;
		left: 50%;
		top: 0;
		z-index: 45;
		translate: -50% 0;
		border-radius: 0 0 0.8rem 0.8rem;
		background: #f59e0b;
		padding: 0.75rem 2rem;
		color: black;
		font-size: 1.5rem;
		font-weight: 700;
		white-space: nowrap;
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
	.away {
		color: #94a3b8;
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
