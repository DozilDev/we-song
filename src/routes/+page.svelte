<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly, slide } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { quintOut } from 'svelte/easing';
	import type { AppState } from '$lib/types.js';

	let myName = $state('');
	let nameInput = $state('');
	let nameSet = $state(false);

	let appState = $state<AppState>({
		queue: [],
		nowPlaying: null,
		isPaused: false,
		host: null,
		isHost: false
	});

	let urlInput = $state('');
	let addError = $state('');
	let adding = $state(false);
	let connected = $state(false);

	// Host status is decided by the server from our session cookie, not by name.
	let isHost = $derived(appState.isHost);

	function thumb(videoId: string): string {
		return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
	}

	// YouTube player state (non-reactive)
	let ytPlayer: any = null;
	let ytReady = false;
	let currentVideoId = '';
	let lastPaused = false;

	let es: EventSource | null = null;

	function loadYouTubeAPI(): Promise<void> {
		return new Promise((resolve) => {
			if ((window as any).YT?.Player) return resolve();
			const prev = (window as any).onYouTubeIframeAPIReady;
			(window as any).onYouTubeIframeAPIReady = () => {
				prev?.();
				resolve();
			};
			if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
				const script = document.createElement('script');
				script.src = 'https://www.youtube.com/iframe_api';
				document.head.appendChild(script);
			}
		});
	}

	function initPlayer(node: HTMLElement) {
		let aborted = false;
		const playerDiv = document.createElement('div');
		node.appendChild(playerDiv);

		loadYouTubeAPI().then(() => {
			if (aborted) return;
			ytPlayer = new (window as any).YT.Player(playerDiv, {
				height: '100%',
				width: '100%',
				videoId: appState.nowPlaying?.videoId ?? '',
				playerVars: { autoplay: 1, rel: 0, playsinline: 1 },
				events: {
					onReady: () => {
						ytReady = true;
						currentVideoId = appState.nowPlaying?.videoId ?? '';
						lastPaused = appState.isPaused;
					},
					onStateChange: (e: any) => {
						if (e.data === 0) control('skip');
					}
				}
			});
		});

		return {
			destroy() {
				aborted = true;
				if (ytPlayer) {
					ytPlayer.destroy();
					ytPlayer = null;
					ytReady = false;
					currentVideoId = '';
				}
			}
		};
	}

	// Apply a server state push: sync the host's player, then update the UI.
	function applyState(data: AppState) {
		if (ytReady && ytPlayer) {
			const newVid = data.nowPlaying?.videoId ?? '';
			if (newVid !== currentVideoId) {
				if (newVid) ytPlayer.loadVideoById(newVid);
				else ytPlayer.stopVideo();
				currentVideoId = newVid;
				lastPaused = false;
			}
			if (data.nowPlaying && data.isPaused !== lastPaused) {
				if (data.isPaused) ytPlayer.pauseVideo();
				else ytPlayer.playVideo();
				lastPaused = data.isPaused;
			}
		}
		appState = data;
	}

	function setName() {
		const trimmed = nameInput.trim();
		if (!trimmed) return;
		myName = trimmed;
		localStorage.setItem('we-song-name', trimmed);
		nameSet = true;
	}

	async function addSong() {
		if (!urlInput.trim() || !nameSet) return;
		adding = true;
		addError = '';
		try {
			const res = await fetch('/api/queue', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: urlInput.trim(), name: myName })
			});
			if (res.ok) {
				appState = await res.json();
				urlInput = '';
			} else {
				const data = await res.json().catch(() => null);
				addError = data?.message ?? 'Invalid YouTube URL';
			}
		} catch {
			addError = 'Failed to add song';
		}
		adding = false;
	}

	async function control(action: string) {
		try {
			const res = await fetch('/api/control', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action })
			});
			if (res.ok) appState = await res.json();
		} catch {}
	}

	async function claimHost() {
		const res = await fetch('/api/host', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: myName, action: 'claim' })
		});
		if (res.ok) appState = await res.json();
	}

	async function releaseHost() {
		const res = await fetch('/api/host', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: myName, action: 'release' })
		});
		if (res.ok) appState = await res.json();
	}

	async function voteSong(id: string) {
		if (!nameSet) return;
		try {
			const res = await fetch('/api/queue/vote', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			});
			if (res.ok) appState = await res.json();
		} catch {}
	}

	async function deleteSong(id: string) {
		if (!nameSet) return;
		try {
			const res = await fetch('/api/queue', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			});
			if (res.ok) appState = await res.json();
		} catch {}
	}

	let draggedIndex = $state<number | null>(null);
	let hoveringIndex = $state<number | null>(null);

	async function reorderSong(fromIndex: number, toIndex: number) {
		if (!nameSet || !isHost) return;
		if (fromIndex === toIndex) return;
		try {
			const res = await fetch('/api/queue/reorder', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ fromIndex, toIndex })
			});
			if (res.ok) appState = await res.json();
		} catch {}
	}

	onMount(() => {
		const saved = localStorage.getItem('we-song-name');
		if (saved) {
			myName = saved;
			nameInput = saved;
			nameSet = true;
		}

		// Realtime updates via Server-Sent Events (auto-reconnects on drop).
		es = new EventSource('/api/events');
		es.onopen = () => (connected = true);
		es.onmessage = (e) => {
			connected = true;
			try {
				applyState(JSON.parse(e.data));
			} catch {}
		};
		es.onerror = () => (connected = false);

		// Step down instantly on a graceful close (the server also auto-releases
		// after a grace period if the SSE connection just drops).
		window.addEventListener('beforeunload', () => {
			if (isHost) {
				navigator.sendBeacon(
					'/api/host',
					new Blob([JSON.stringify({ name: myName, action: 'release' })], {
						type: 'application/json'
					})
				);
			}
		});

		return () => es?.close();
	});
</script>

<svelte:head>
	<title>WE SONG</title>
</svelte:head>

<!-- Ambient background -->
<div class="pointer-events-none fixed inset-0 overflow-hidden">
	<div
		class="absolute -top-48 left-1/2 h-[28rem] w-[28rem] -translate-x-1/2 rounded-full bg-violet-600/20 blur-[130px]"
	></div>
	<div
		class="absolute -bottom-32 -right-24 h-80 w-80 rounded-full bg-fuchsia-600/10 blur-[130px]"
	></div>
	<div class="absolute -bottom-40 -left-24 h-72 w-72 rounded-full bg-indigo-600/10 blur-[130px]"></div>
</div>

<main class="relative min-h-screen bg-zinc-950 text-white">
	<div class="mx-auto max-w-2xl space-y-4 px-4 pb-16">
		<!-- Header -->
		<header class="flex items-center justify-between pt-8 pb-2">
			<div>
				<h1
					class="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-violet-400 bg-clip-text text-4xl font-black tracking-tight text-transparent"
				>
					WE SONG
				</h1>
				<p class="mt-1 text-sm text-zinc-500">Team Music Queue</p>
			</div>
			<div
				class="flex items-center gap-2 rounded-full border border-white/5 bg-white/[0.03] px-3 py-1.5 text-xs backdrop-blur-xl"
				title={connected ? 'Live — realtime updates' : 'Reconnecting…'}
			>
				<span class="relative flex h-2 w-2">
					{#if connected}
						<span
							class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"
						></span>
						<span class="relative inline-flex h-2 w-2 rounded-full bg-emerald-400"></span>
					{:else}
						<span class="relative inline-flex h-2 w-2 rounded-full bg-amber-400"></span>
					{/if}
				</span>
				<span class="font-medium text-zinc-400">{connected ? 'Live' : 'Reconnecting'}</span>
			</div>
		</header>

		{#if !nameSet}
			<!-- Name gate -->
			<div
				in:fly={{ y: 12, duration: 350, easing: quintOut }}
				class="rounded-2xl border border-white/5 bg-white/[0.03] p-8 text-center shadow-2xl backdrop-blur-xl"
			>
				<div
					class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-2xl shadow-lg shadow-violet-900/40"
				>
					🎧
				</div>
				<h2 class="text-lg font-bold">Welcome</h2>
				<p class="mt-1 mb-5 text-sm text-zinc-400">Enter your name to join the room</p>
				<form
					onsubmit={(e) => {
						e.preventDefault();
						setName();
					}}
					class="flex gap-2"
				>
					<input
						bind:value={nameInput}
						placeholder="Your name…"
						maxlength="40"
						class="flex-1 rounded-xl border border-white/5 bg-zinc-900/80 px-4 py-3 text-sm placeholder-zinc-600 outline-none transition focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/30"
					/>
					<button
						type="submit"
						disabled={!nameInput.trim()}
						class="rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-3 text-sm font-semibold shadow-lg shadow-violet-900/30 transition hover:brightness-110 active:scale-95 disabled:opacity-40"
					>
						Join
					</button>
				</form>
			</div>
		{:else}
			<!-- Identity bar -->
			<div
				class="flex items-center justify-between rounded-2xl border border-white/5 bg-white/[0.03] px-4 py-3 backdrop-blur-xl"
			>
				<span class="flex items-center gap-2 text-sm text-zinc-400">
					Hi, <span class="font-semibold text-white">{myName}</span>
					{#if isHost}
						<span
							class="rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 px-2 py-0.5 text-[10px] font-bold tracking-wide shadow"
						>
							HOST
						</span>
					{/if}
				</span>
				<button
					onclick={() => (nameSet = false)}
					class="text-xs text-zinc-500 transition hover:text-zinc-300"
				>
					Change name
				</button>
			</div>

			<!-- Now Playing -->
			{#if appState.nowPlaying}
				{@const np = appState.nowPlaying}
				<div
					in:fade={{ duration: 250 }}
					class="overflow-hidden rounded-2xl border border-white/5 bg-white/[0.03] shadow-2xl backdrop-blur-xl"
				>
					<div class="flex items-center justify-between px-5 pt-4">
						<p class="text-xs font-bold tracking-widest text-violet-300/80 uppercase">Now Playing</p>
						{#if !appState.isPaused}
							<div class="eq" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
						{:else}
							<span class="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase"
								>Paused</span
							>
						{/if}
					</div>

					<div class="p-5 pt-3">
						{#if isHost}
							<!-- Host: real player -->
							<div class="mb-4 aspect-video overflow-hidden rounded-xl bg-black shadow-inner" use:initPlayer></div>
							<p class="truncate text-base font-semibold">{np.title}</p>
							<p class="mt-0.5 text-xs text-zinc-500">added by {np.addedBy}</p>
						{:else}
							<!-- Everyone else: thumbnail + info -->
							<a
								href={np.url}
								target="_blank"
								rel="noopener noreferrer"
								class="group flex items-center gap-4"
							>
								<div class="relative h-20 w-32 shrink-0 overflow-hidden rounded-xl bg-zinc-800 shadow-lg">
									<img
										src={thumb(np.videoId)}
										alt=""
										loading="lazy"
										class="h-full w-full object-cover transition duration-300 group-hover:scale-105"
									/>
									<div
										class="absolute inset-0 flex items-center justify-center bg-black/30 text-2xl opacity-90"
									>
										{appState.isPaused ? '⏸' : '▶'}
									</div>
								</div>
								<div class="min-w-0">
									<p class="truncate text-sm font-semibold group-hover:text-violet-300">{np.title}</p>
									<p class="mt-1 text-xs text-zinc-500">added by {np.addedBy}</p>
								</div>
							</a>
						{/if}

						<!-- Playback controls (host only — the host plays the audio) -->
						{#if isHost}
							<div class="mt-4 flex gap-2">
								<button
									onclick={() => control('pause')}
									class="flex-1 rounded-xl border border-white/5 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold transition hover:bg-white/[0.08] active:scale-95"
								>
									{appState.isPaused ? '▶ Resume' : '⏸ Pause'}
								</button>
								<button
									onclick={() => control('skip')}
									class="flex-1 rounded-xl border border-white/5 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold transition hover:bg-white/[0.08] active:scale-95"
								>
									⏭ Skip
								</button>
								<button
									onclick={() => control('stop')}
									class="rounded-xl border border-red-500/20 bg-red-950/40 px-4 py-2.5 text-sm font-semibold text-red-300 transition hover:bg-red-900/50 active:scale-95"
								>
									⏹ Stop
								</button>
							</div>
						{/if}
					</div>
				</div>
			{:else}
				<div
					class="rounded-2xl border border-white/5 bg-white/[0.03] p-10 text-center backdrop-blur-xl"
				>
					<p class="text-3xl opacity-80">🎵</p>
					<p class="mt-2 text-sm text-zinc-500">No song playing — add one below</p>
				</div>
			{/if}

			<!-- Add Song -->
			<div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 backdrop-blur-xl">
				<p class="mb-3 text-xs font-bold tracking-widest text-zinc-500 uppercase">Add Song</p>
				<form
					onsubmit={(e) => {
						e.preventDefault();
						addSong();
					}}
					class="flex flex-col gap-2 sm:flex-row"
				>
					<input
						bind:value={urlInput}
						placeholder="Paste a YouTube link…"
						class="flex-1 rounded-xl border border-white/5 bg-zinc-900/80 px-4 py-2.5 text-sm placeholder-zinc-600 outline-none transition focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/30"
					/>
					<button
						type="submit"
						disabled={adding || !urlInput.trim()}
						class="rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-2.5 text-sm font-semibold shadow-lg shadow-violet-900/30 transition hover:brightness-110 active:scale-95 disabled:opacity-40"
					>
						{adding ? 'Adding…' : '+ Add'}
					</button>
				</form>
				{#if addError}
					<p in:slide={{ duration: 150 }} class="mt-2 text-xs text-red-400">{addError}</p>
				{/if}
			</div>

			<!-- Queue -->
			<div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 backdrop-blur-xl">
				<p class="mb-3 text-xs font-bold tracking-widest text-zinc-500 uppercase">
					Up Next {appState.queue.length > 0 ? `· ${appState.queue.length}` : ''}
				</p>
				{#if appState.queue.length === 0}
					<p class="py-6 text-center text-sm text-zinc-600">Queue is empty</p>
				{:else}
					<ul class="space-y-2">
						{#each appState.queue as song, i (song.id)}
							<li
								animate:flip={{ duration: 260, easing: quintOut }}
								transition:slide={{ duration: 180 }}
								draggable={isHost}
								ondragstart={(e) => {
									if (!isHost) return;
									draggedIndex = i;
									e.dataTransfer?.setData('text/plain', i.toString());
								}}
								ondragover={(e) => {
									if (!isHost || draggedIndex === null) return;
									e.preventDefault();
									hoveringIndex = i;
								}}
								ondragleave={() => {
									if (hoveringIndex === i) hoveringIndex = null;
								}}
								ondragend={() => {
									draggedIndex = null;
									hoveringIndex = null;
								}}
								ondrop={(e) => {
									e.preventDefault();
									if (draggedIndex !== null && isHost) reorderSong(draggedIndex, i);
									draggedIndex = null;
									hoveringIndex = null;
								}}
								class="flex items-center gap-3 rounded-xl p-2.5 transition-all duration-200 select-none
									{isHost ? 'cursor-grab active:cursor-grabbing' : ''}
									{draggedIndex === i
									? 'border border-dashed border-zinc-700 bg-zinc-800/20 opacity-40'
									: 'border border-white/5 bg-white/[0.02]'}
									{hoveringIndex === i && draggedIndex !== i
									? 'scale-[0.99] border-2 border-dashed border-violet-500 bg-violet-500/5'
									: ''}"
							>
								<span class="w-4 shrink-0 text-center text-xs font-semibold text-zinc-600">{i + 1}</span>
								<div class="relative h-11 w-16 shrink-0 overflow-hidden rounded-lg bg-zinc-800">
									<img src={thumb(song.videoId)} alt="" loading="lazy" class="h-full w-full object-cover" />
								</div>
								<div class="min-w-0 flex-1">
									<a
										href={song.url}
										target="_blank"
										rel="noopener noreferrer"
										class="block truncate text-sm font-medium transition hover:text-violet-300"
									>
										{song.title}
									</a>
									<p class="text-xs text-zinc-600">by {song.addedBy}</p>
								</div>

								<div class="flex shrink-0 items-center gap-1.5">
									{#if isHost}
										<button
											onclick={() => reorderSong(i, i - 1)}
											disabled={i === 0}
											class="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-xs text-zinc-400 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-25"
											title="Move up"
										>
											▲
										</button>
										<button
											onclick={() => reorderSong(i, i + 1)}
											disabled={i === appState.queue.length - 1}
											class="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-xs text-zinc-400 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-25"
											title="Move down"
										>
											▼
										</button>
									{/if}

									<button
										onclick={() => voteSong(song.id)}
										class="flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition active:scale-95
											{song.voted
											? 'bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow'
											: 'bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08] hover:text-white'}"
										title="Upvote"
									>
										<span>▲</span>
										<span>{song.votes}</span>
									</button>

									{#if song.mine || isHost}
										<button
											onclick={() => deleteSong(song.id)}
											class="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-zinc-400 transition hover:bg-red-950/60 hover:text-red-400 active:scale-95"
											title="Remove"
										>
											🗑️
										</button>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<!-- Host section -->
			<div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 backdrop-blur-xl">
				<p class="mb-3 text-xs font-bold tracking-widest text-zinc-500 uppercase">Host</p>
				{#if !appState.host}
					<p class="mb-3 text-sm text-zinc-400">No host yet — the host plays music through their browser.</p>
					<button
						onclick={claimHost}
						class="w-full rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2.5 text-sm font-semibold shadow-lg shadow-violet-900/30 transition hover:brightness-110 active:scale-95"
					>
						🎧 Become Host
					</button>
				{:else if isHost}
					<p class="mb-3 text-sm text-zinc-400">You're the host — music plays through your browser.</p>
					<button
						onclick={releaseHost}
						class="w-full rounded-xl border border-white/5 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold transition hover:bg-white/[0.08] active:scale-95"
					>
						Release Host
					</button>
				{:else}
					<p class="flex items-center gap-2 text-sm text-zinc-400">
						<span class="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-xs">🎧</span>
						<span class="font-semibold text-white">{appState.host}</span> is hosting
					</p>
				{/if}
			</div>
		{/if}
	</div>
</main>

<style>
	/* Animated equalizer shown while a song is playing */
	.eq {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 14px;
	}
	.eq span {
		width: 3px;
		height: 100%;
		border-radius: 2px;
		background: linear-gradient(to top, #a78bfa, #e879f9);
		transform-origin: bottom;
		animation: eq 0.9s ease-in-out infinite;
	}
	.eq span:nth-child(2) {
		animation-delay: 0.2s;
	}
	.eq span:nth-child(3) {
		animation-delay: 0.4s;
	}
	.eq span:nth-child(4) {
		animation-delay: 0.6s;
	}
	@keyframes eq {
		0%,
		100% {
			transform: scaleY(0.3);
		}
		50% {
			transform: scaleY(1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.eq span {
			animation: none;
			transform: scaleY(0.6);
		}
	}
</style>
