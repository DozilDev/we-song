<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly, slide } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { quintOut } from 'svelte/easing';
	import type { AppState, ReactionEvent } from '$lib/types.js';
	import { qrMatrix } from '$lib/qr.js';
	import { locale, t, initLocale, setLocale } from '$lib/i18n';
	import type { Locale } from '$lib/i18n';

	let myName = $state('');
	let nameInput = $state('');
	let nameSet = $state(false);

	let appState = $state<AppState>({
		queue: [],
		nowPlaying: null,
		isPaused: false,
		host: null,
		isHost: false,
		history: [],
		chat: [],
		stats: { topContributor: null, mostLiked: null, me: { name: '', songsAdded: 0, votesReceived: 0 }, leaderboard: [] }
	});

	let urlInput = $state('');
	let addError = $state('');
	let adding = $state(false);
	let connected = $state(false);

	// Host status is decided by the server from our session cookie, not by name.
	let isHost = $derived(appState.isHost);

	// Reaction emoji available to everyone. Must match ALLOWED_REACTIONS server-side.
	const REACTIONS = ['👏', '🔥', '❤️', '😂', '🎉', '🕺', '🎶'];

	function thumb(videoId: string): string {
		return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
	}

	function fmtTime(sec: number): string {
		if (!Number.isFinite(sec) || sec < 0) return '0:00';
		const s = Math.floor(sec % 60);
		const m = Math.floor(sec / 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	function fmtAgo(ts: number): string {
		const diff = Math.max(0, Date.now() - ts);
		const min = Math.floor(diff / 60000);
		if (min < 1) return 'just now';
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		return `${Math.floor(hr / 24)}d ago`;
	}

	// YouTube player state (non-reactive)
	let ytPlayer: any = null;
	let ytReady = false;
	let currentVideoId = '';
	let lastPaused = false;

	let es: EventSource | null = null;

	// --- Playback progress (synced across clients) ---------------------------
	// The host reads its real player; everyone else interpolates from the latest
	// server `progress` event so the bar advances smoothly between updates.
	let progressPosition = $state(0);
	let progressDuration = $state(0);
	let progressAnchor: { position: number; duration: number; paused: boolean; at: number } | null = null;
	let shownVideoId = '';

	function reportProgress() {
		if (!isHost || !ytReady || !ytPlayer?.getCurrentTime) return;
		const position = ytPlayer.getCurrentTime() ?? 0;
		const duration = ytPlayer.getDuration?.() ?? 0;
		if (!duration) return;
		fetch('/api/progress', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ position, duration })
		}).catch(() => {});
	}

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
						reportProgress();
					},
					onStateChange: (e: any) => {
						if (e.data === 0) control('skip');
						// PLAYING(1) / PAUSED(2): push a fresh position so others sync promptly.
						else if (e.data === 1 || e.data === 2) reportProgress();
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
				reportProgress();
			}
		}
		// Reset the progress bar whenever the playing song changes.
		const vid = data.nowPlaying?.videoId ?? '';
		if (vid !== shownVideoId) {
			shownVideoId = vid;
			progressAnchor = null;
			progressPosition = 0;
			progressDuration = data.nowPlaying?.durationSec ?? 0;
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

	async function addSong(url: string = urlInput) {
		const trimmed = url.trim();
		if (!trimmed || !nameSet) return;
		adding = true;
		addError = '';
		try {
			const res = await fetch('/api/queue', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: trimmed, name: myName })
			});
			if (res.ok) {
				applyState(await res.json());
				if (url === urlInput) urlInput = '';
			} else {
				const data = await res.json().catch(() => null);
				addError = data?.message ?? $t.invalidUrl;
			}
		} catch {
			addError = $t.failedAdd;
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
			if (res.ok) applyState(await res.json());
		} catch {}
	}

	async function claimHost() {
		const res = await fetch('/api/host', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: myName, action: 'claim' })
		});
		if (res.ok) applyState(await res.json());
	}

	async function releaseHost() {
		const res = await fetch('/api/host', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: myName, action: 'release' })
		});
		if (res.ok) applyState(await res.json());
	}

	async function voteSong(id: string) {
		if (!nameSet) return;
		try {
			const res = await fetch('/api/queue/vote', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			});
			if (res.ok) applyState(await res.json());
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
			if (res.ok) applyState(await res.json());
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
			if (res.ok) applyState(await res.json());
		} catch {}
	}

	// --- Queue filter (client-only) ------------------------------------------
	let queueFilter = $state('');
	let filtering = $derived(queueFilter.trim().length > 0);
	let filteredQueue = $derived(
		filtering
			? appState.queue.filter((s) => {
					const q = queueFilter.trim().toLowerCase();
					return s.title.toLowerCase().includes(q) || s.addedBy.toLowerCase().includes(q);
				})
			: appState.queue
	);

	// --- Collapsible panels --------------------------------------------------
	let showHistory = $state(false);
	let showStats = $state(false);
	let showChat = $state(false);
	let showShare = $state(false);

	// --- Chat ----------------------------------------------------------------
	let chatInput = $state('');
	async function sendChat() {
		const text = chatInput.trim();
		if (!text || !nameSet) return;
		chatInput = '';
		try {
			await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ kind: 'message', text, name: myName })
			});
		} catch {}
	}

	async function sendReaction(emoji: string) {
		if (!nameSet) return;
		try {
			await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ kind: 'reaction', text: emoji, name: myName })
			});
		} catch {}
	}

	// --- Floating reactions --------------------------------------------------
	let floaters = $state<{ id: number; emoji: string; from: string; left: number }[]>([]);
	let floaterSeq = 0;
	function spawnFloater(r: ReactionEvent) {
		const id = floaterSeq++;
		const left = 8 + Math.random() * 84; // vw position
		floaters = [...floaters, { id, emoji: r.emoji, from: r.from, left }];
		if (floaters.length > 30) floaters = floaters.slice(-30);
		setTimeout(() => {
			floaters = floaters.filter((f) => f.id !== id);
		}, 2400);
	}

	// --- Share / QR ----------------------------------------------------------
	let shareUrl = $state('');
	let copied = $state(false);
	let qrCells = $derived(shareUrl ? qrMatrix(shareUrl) : []);
	function openShare() {
		shareUrl = window.location.href;
		copied = false;
		showShare = true;
	}
	async function copyShare() {
		try {
			await navigator.clipboard.writeText(shareUrl);
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} catch {}
	}

	onMount(() => {
		initLocale();
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
		es.addEventListener('progress', (e) => {
			try {
				const p = JSON.parse((e as MessageEvent).data);
				if (p) progressAnchor = { ...p, at: performance.now() };
				else progressAnchor = null;
			} catch {}
		});
		es.addEventListener('reaction', (e) => {
			try {
				spawnFloater(JSON.parse((e as MessageEvent).data));
			} catch {}
		});

		// Drive the progress bar locally (smooth between sparse server updates).
		const ticker = setInterval(() => {
			if (!appState.nowPlaying) {
				progressPosition = 0;
				return;
			}
			if (isHost && ytReady && ytPlayer?.getCurrentTime) {
				progressPosition = ytPlayer.getCurrentTime() ?? 0;
				progressDuration = ytPlayer.getDuration?.() ?? progressDuration;
			} else if (progressAnchor) {
				progressDuration = progressAnchor.duration;
				const elapsed = progressAnchor.paused ? 0 : (performance.now() - progressAnchor.at) / 1000;
				progressPosition = Math.min(progressAnchor.position + elapsed, progressAnchor.duration);
			}
		}, 250);

		// Host pushes its position periodically so others can interpolate.
		const reporter = setInterval(() => {
			if (isHost && ytReady && !appState.isPaused) reportProgress();
		}, 2000);

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

		return () => {
			es?.close();
			clearInterval(ticker);
			clearInterval(reporter);
		};
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

<!-- Floating reactions layer -->
<div class="pointer-events-none fixed inset-0 z-50 overflow-hidden">
	{#each floaters as f (f.id)}
		<div class="floater absolute bottom-24 flex flex-col items-center" style="left: {f.left}vw">
			<span class="text-3xl drop-shadow-lg">{f.emoji}</span>
			<span class="mt-0.5 max-w-20 truncate text-[10px] font-medium text-white/70">{f.from}</span>
		</div>
	{/each}
</div>

<main class="relative min-h-screen bg-zinc-950 text-white">
	<div class="mx-auto max-w-2xl space-y-4 px-4 pb-16">
		<!-- Header -->
		<header class="flex flex-wrap items-center justify-between gap-2 pt-8 pb-2">
			<div>
				<h1
					class="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-violet-400 bg-clip-text text-3xl font-black tracking-tight text-transparent sm:text-4xl"
				>
					WE SONG
				</h1>
				<p class="mt-1 text-sm text-zinc-500">{$t.subtitle}</p>
			</div>
			<div class="flex items-center gap-2">
				<button
					onclick={openShare}
					title={$t.shareTitle}
					class="flex items-center justify-center rounded-full border border-white/5 bg-white/[0.03] p-2 text-zinc-400 backdrop-blur-xl transition hover:border-white/10 hover:bg-white/[0.06] hover:text-white"
					aria-label={$t.share}
				>
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
					</svg>
				</button>
				<a
					href="https://github.com/DozilDev/we-song"
					target="_blank"
					rel="noopener noreferrer"
					title="View on GitHub — PRs welcome!"
					class="flex items-center justify-center rounded-full border border-white/5 bg-white/[0.03] p-2 text-zinc-400 backdrop-blur-xl transition hover:border-white/10 hover:bg-white/[0.06] hover:text-white"
				>
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
					</svg>
				</a>
				<!-- Language select -->
				<select
					value={$locale}
					onchange={(e) => setLocale((e.currentTarget as HTMLSelectElement).value as Locale)}
					class="cursor-pointer appearance-none rounded-full border border-white/5 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-zinc-300 backdrop-blur-xl outline-none transition hover:border-white/10 hover:bg-white/[0.06] hover:text-white"
				>
					<option value="en">EN — English</option>
					<option value="th">TH — ภาษาไทย</option>
					<option value="th_n">TH — เหนือ</option>
					<option value="th_s">TH — ใต้</option>
					<option value="th_e">TH — อีสาน</option>
				</select>
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
					<span class="font-medium text-zinc-400">{connected ? $t.live : $t.reconnecting}</span>
				</div>
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
				<h2 class="text-lg font-bold">{$t.welcome}</h2>
				<p class="mt-1 mb-5 text-sm text-zinc-400">{$t.welcomeDesc}</p>
				<form
					onsubmit={(e) => {
						e.preventDefault();
						setName();
					}}
					class="flex gap-2"
				>
					<input
						bind:value={nameInput}
						placeholder={$t.namePlaceholder}
						maxlength="40"
						class="flex-1 rounded-xl border border-white/5 bg-zinc-900/80 px-4 py-3 text-sm placeholder-zinc-600 outline-none transition focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/30"
					/>
					<button
						type="submit"
						disabled={!nameInput.trim()}
						class="rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-3 text-sm font-semibold shadow-lg shadow-violet-900/30 transition hover:brightness-110 active:scale-95 disabled:opacity-40"
					>
						{$t.join}
					</button>
				</form>
			</div>
		{:else}
			<!-- Identity bar -->
			<div
				class="flex items-center justify-between rounded-2xl border border-white/5 bg-white/[0.03] px-4 py-3 backdrop-blur-xl"
			>
				<span class="flex items-center gap-2 text-sm text-zinc-400">
					{$t.hi} <span class="font-semibold text-white">{myName}</span>
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
					{$t.changeName}
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
						<p class="text-xs font-bold tracking-widest text-violet-300/80 uppercase">{$t.nowPlaying}</p>
						{#if !appState.isPaused}
							<div class="eq" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
						{:else}
							<span class="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase"
								>{$t.paused}</span
							>
						{/if}
					</div>

					<div class="p-5 pt-3">
						{#if isHost}
							<!-- Host: real player -->
							<div class="mb-4 aspect-video overflow-hidden rounded-xl bg-black shadow-inner" use:initPlayer></div>
							<p class="truncate text-base font-semibold">{np.title}</p>
							<p class="mt-0.5 text-xs text-zinc-500">{$t.addedBy} {np.addedBy}</p>
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
									<p class="mt-1 text-xs text-zinc-500">{$t.addedBy} {np.addedBy}</p>
								</div>
							</a>
						{/if}

						<!-- Progress bar (synced across all clients) -->
						{#if progressDuration > 0}
							<div class="mt-4">
								<div class="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
									<div
										class="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-[width] duration-300 ease-linear"
										style="width: {Math.min(100, (progressPosition / progressDuration) * 100)}%"
									></div>
								</div>
								<div class="mt-1 flex justify-between text-[10px] font-medium tabular-nums text-zinc-500">
									<span>{fmtTime(progressPosition)}</span>
									<span>{fmtTime(progressDuration)}</span>
								</div>
							</div>
						{/if}

						<!-- Playback controls (host only — the host plays the audio) -->
						{#if isHost}
							<div class="mt-4 flex flex-wrap gap-2">
								<button
									onclick={() => control('pause')}
									class="flex-1 rounded-xl border border-white/5 bg-white/[0.04] px-3 py-2.5 text-sm font-semibold transition hover:bg-white/[0.08] active:scale-95 sm:px-4"
								>
									{appState.isPaused ? $t.resume : $t.pause}
								</button>
								<button
									onclick={() => control('skip')}
									class="flex-1 rounded-xl border border-white/5 bg-white/[0.04] px-3 py-2.5 text-sm font-semibold transition hover:bg-white/[0.08] active:scale-95 sm:px-4"
								>
									{$t.skip}
								</button>
								<button
									onclick={() => control('stop')}
									class="rounded-xl border border-red-500/20 bg-red-950/40 px-3 py-2.5 text-sm font-semibold text-red-300 transition hover:bg-red-900/50 active:scale-95 sm:px-4"
								>
									{$t.stop}
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
					<p class="mt-2 text-sm text-zinc-500">{$t.noSong}</p>
				</div>
			{/if}

			<!-- Reactions bar -->
			<div class="flex flex-wrap items-center justify-center gap-1.5 rounded-2xl border border-white/5 bg-white/[0.03] p-2.5 backdrop-blur-xl">
				{#each REACTIONS as emoji (emoji)}
					<button
						onclick={() => sendReaction(emoji)}
						class="flex h-10 w-10 items-center justify-center rounded-xl text-xl transition hover:bg-white/[0.08] active:scale-90 sm:h-9 sm:w-9"
						title="{$t.react} {emoji}"
					>
						{emoji}
					</button>
				{/each}
			</div>

			<!-- Add Song -->
			<div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 backdrop-blur-xl">
				<p class="mb-3 text-xs font-bold tracking-widest text-zinc-500 uppercase">{$t.addSong}</p>
				<form
					onsubmit={(e) => {
						e.preventDefault();
						addSong();
					}}
					class="flex flex-col gap-2 sm:flex-row"
				>
					<input
						bind:value={urlInput}
						placeholder={$t.urlPlaceholder}
						class="flex-1 rounded-xl border border-white/5 bg-zinc-900/80 px-4 py-2.5 text-sm placeholder-zinc-600 outline-none transition focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/30"
					/>
					<button
						type="submit"
						disabled={adding || !urlInput.trim()}
						class="rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-2.5 text-sm font-semibold shadow-lg shadow-violet-900/30 transition hover:brightness-110 active:scale-95 disabled:opacity-40"
					>
						{adding ? $t.adding : $t.add}
					</button>
				</form>
				{#if addError}
					<p in:slide={{ duration: 150 }} class="mt-2 text-xs text-red-400">{addError}</p>
				{/if}
			</div>

			<!-- Queue -->
			<div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 backdrop-blur-xl">
				<div class="mb-3 flex items-center justify-between gap-2">
					<p class="text-xs font-bold tracking-widest text-zinc-500 uppercase">
						{$t.upNext} {appState.queue.length > 0 ? `· ${appState.queue.length}` : ''}
					</p>
					{#if appState.queue.length > 0}
						<input
							bind:value={queueFilter}
							placeholder={$t.filterPlaceholder}
							class="w-28 rounded-lg border border-white/5 bg-zinc-900/80 px-2.5 py-1 text-xs placeholder-zinc-600 outline-none transition focus:w-36 focus:border-violet-500/50"
						/>
					{/if}
				</div>
				{#if filtering && isHost}
					<p class="mb-2 text-[11px] text-amber-400/80">{$t.filterPaused}</p>
				{/if}
				{#if appState.queue.length === 0}
					<p class="py-6 text-center text-sm text-zinc-600">{$t.queueEmpty}</p>
				{:else if filteredQueue.length === 0}
					<p class="py-6 text-center text-sm text-zinc-600">
						{$t.noMatches} ·
						<button onclick={() => (queueFilter = '')} class="text-violet-400 hover:underline">{$t.clear}</button>
					</p>
				{:else}
					<ul class="space-y-2">
						{#each filteredQueue as song, i (song.id)}
							<li
								animate:flip={{ duration: 260, easing: quintOut }}
								transition:slide={{ duration: 180 }}
								draggable={isHost && !filtering}
								ondragstart={(e) => {
									if (!isHost || filtering) return;
									draggedIndex = i;
									e.dataTransfer?.setData('text/plain', i.toString());
								}}
								ondragover={(e) => {
									if (!isHost || filtering || draggedIndex === null) return;
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
									if (draggedIndex !== null && isHost && !filtering) reorderSong(draggedIndex, i);
									draggedIndex = null;
									hoveringIndex = null;
								}}
								class="flex items-center gap-2 rounded-xl p-2.5 transition-all duration-200 select-none sm:gap-3
									{isHost && !filtering ? 'cursor-grab active:cursor-grabbing' : ''}
									{draggedIndex === i
									? 'border border-dashed border-zinc-700 bg-zinc-800/20 opacity-40'
									: 'border border-white/5 bg-white/[0.02]'}
									{hoveringIndex === i && draggedIndex !== i
									? 'scale-[0.99] border-2 border-dashed border-violet-500 bg-violet-500/5'
									: ''}"
							>
								<span class="w-4 shrink-0 text-center text-xs font-semibold text-zinc-600">{i + 1}</span>
								<div class="relative h-10 w-14 shrink-0 overflow-hidden rounded-lg bg-zinc-800 sm:h-11 sm:w-16">
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
									<p class="text-xs text-zinc-600">
										{$t.by} {song.addedBy}{#if song.durationSec} · {fmtTime(song.durationSec)}{/if}
									</p>
								</div>

								<div class="flex shrink-0 items-center gap-1 sm:gap-1.5">
									{#if isHost && !filtering}
										<button
											onclick={() => reorderSong(i, i - 1)}
											disabled={i === 0}
											class="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-xs text-zinc-400 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-25"
											title={$t.moveUp}
										>
											▲
										</button>
										<button
											onclick={() => reorderSong(i, i + 1)}
											disabled={i === filteredQueue.length - 1}
											class="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-xs text-zinc-400 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-25"
											title={$t.moveDown}
										>
											▼
										</button>
									{/if}

									<button
										onclick={() => voteSong(song.id)}
										class="flex h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition active:scale-95 sm:h-8
											{song.voted
											? 'bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow'
											: 'bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08] hover:text-white'}"
										title={$t.upvote}
									>
										<span>▲</span>
										<span>{song.votes}</span>
									</button>

									{#if song.mine || isHost}
										<button
											onclick={() => deleteSong(song.id)}
											class="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.04] text-zinc-400 transition hover:bg-red-950/60 hover:text-red-400 active:scale-95 sm:h-8 sm:w-8"
											title={$t.remove}
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

			<!-- Recently played -->
			{#if appState.history.length > 0}
				<div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 backdrop-blur-xl">
					<button
						onclick={() => (showHistory = !showHistory)}
						class="flex w-full items-center justify-between text-xs font-bold tracking-widest text-zinc-500 uppercase"
					>
						<span>{$t.recentlyPlayed} · {appState.history.length}</span>
						<span class="text-zinc-600">{showHistory ? '▾' : '▸'}</span>
					</button>
					{#if showHistory}
						<ul class="mt-3 space-y-2" transition:slide={{ duration: 180 }}>
							{#each appState.history as h (h.playedAt + h.videoId)}
								<li class="flex items-center gap-2 rounded-xl border border-white/5 bg-white/[0.02] p-2.5 sm:gap-3">
									<div class="relative h-10 w-14 shrink-0 overflow-hidden rounded-lg bg-zinc-800 sm:h-11 sm:w-16">
										<img src={thumb(h.videoId)} alt="" loading="lazy" class="h-full w-full object-cover opacity-70" />
									</div>
									<div class="min-w-0 flex-1">
										<a href={h.url} target="_blank" rel="noopener noreferrer" class="block truncate text-sm font-medium text-zinc-300 transition hover:text-violet-300">{h.title}</a>
										<p class="text-xs text-zinc-600">
											{h.addedBy} · {fmtAgo(h.playedAt)}{#if h.durationSec} · {fmtTime(h.durationSec)}{/if}
										</p>
									</div>
									<button
										onclick={() => addSong(h.url)}
										class="flex h-9 shrink-0 items-center gap-1 rounded-lg bg-white/[0.04] px-3 text-xs font-semibold text-zinc-300 transition hover:bg-white/[0.08] hover:text-white active:scale-95"
										title={$t.reAdd}
									>
										{$t.reAdd}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}

			<!-- Chat -->
			<div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 backdrop-blur-xl">
				<button
					onclick={() => (showChat = !showChat)}
					class="flex w-full items-center justify-between text-xs font-bold tracking-widest text-zinc-500 uppercase"
				>
					<span>{$t.chat} {appState.chat.length > 0 ? `· ${appState.chat.length}` : ''}</span>
					<span class="text-zinc-600">{showChat ? '▾' : '▸'}</span>
				</button>
				{#if showChat}
					<div transition:slide={{ duration: 180 }}>
						<div class="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
							{#if appState.chat.length === 0}
								<p class="py-4 text-center text-sm text-zinc-600">{$t.noMessages}</p>
							{:else}
								{#each appState.chat as m (m.id)}
									<div class="flex flex-col {m.mine ? 'items-end' : 'items-start'}">
										<div class="max-w-[80%] rounded-2xl px-3 py-1.5 text-sm {m.mine ? 'bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white' : 'bg-white/[0.05] text-zinc-200'}">
											{#if !m.mine}<span class="mr-1 text-[10px] font-semibold text-violet-300/80">{m.from}</span>{/if}
											{m.text}
										</div>
									</div>
								{/each}
							{/if}
						</div>
						<form
							onsubmit={(e) => {
								e.preventDefault();
								sendChat();
							}}
							class="mt-3 flex gap-2"
						>
							<input
								bind:value={chatInput}
								placeholder={$t.messagePlaceholder}
								maxlength="200"
								class="flex-1 rounded-xl border border-white/5 bg-zinc-900/80 px-4 py-2.5 text-sm placeholder-zinc-600 outline-none transition focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/30"
							/>
							<button
								type="submit"
								disabled={!chatInput.trim()}
								class="rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2.5 text-sm font-semibold shadow transition hover:brightness-110 active:scale-95 disabled:opacity-40"
							>
								{$t.send}
							</button>
						</form>
					</div>
				{/if}
			</div>

			<!-- Stats -->
			<div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 backdrop-blur-xl">
				<button
					onclick={() => (showStats = !showStats)}
					class="flex w-full items-center justify-between text-xs font-bold tracking-widest text-zinc-500 uppercase"
				>
					<span>{$t.stats}</span>
					<span class="text-zinc-600">{showStats ? '▾' : '▸'}</span>
				</button>
				{#if showStats}
					<div transition:slide={{ duration: 180 }} class="mt-3 space-y-3">
						<div class="flex gap-2">
							<div class="flex-1 rounded-xl border border-white/5 bg-white/[0.02] p-3 text-center">
								<p class="text-2xl font-black text-violet-300">{appState.stats.me.songsAdded}</p>
								<p class="text-[10px] tracking-wide text-zinc-500 uppercase">{$t.youAdded}</p>
							</div>
							<div class="flex-1 rounded-xl border border-white/5 bg-white/[0.02] p-3 text-center">
								<p class="text-2xl font-black text-fuchsia-300">{appState.stats.me.votesReceived}</p>
								<p class="text-[10px] tracking-wide text-zinc-500 uppercase">{$t.votesReceivedLabel}</p>
							</div>
						</div>
						{#if appState.stats.topContributor}
							<p class="text-sm text-zinc-400">{$t.topContributor} <span class="font-semibold text-white">{appState.stats.topContributor}</span></p>
						{/if}
						{#if appState.stats.mostLiked}
							<p class="text-sm text-zinc-400">{$t.mostLiked} <span class="font-semibold text-white">{appState.stats.mostLiked}</span></p>
						{/if}
						{#if appState.stats.leaderboard.length > 0}
							<ul class="space-y-1">
								{#each appState.stats.leaderboard as row, i (row.name + i)}
									<li class="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-1.5 text-sm">
										<span class="flex items-center gap-2">
											<span class="w-5 text-center">{['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`}</span>
											<span class="text-zinc-300">{row.name}</span>
										</span>
										<span class="text-xs text-zinc-500">{row.songsAdded} {$t.songsUnit} · {row.votesReceived} ▲</span>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Host section -->
			<div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 backdrop-blur-xl">
				<p class="mb-3 text-xs font-bold tracking-widest text-zinc-500 uppercase">{$t.host}</p>
				{#if !appState.host}
					<p class="mb-3 text-sm text-zinc-400">{$t.noHostDesc}</p>
					<button
						onclick={claimHost}
						class="w-full rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2.5 text-sm font-semibold shadow-lg shadow-violet-900/30 transition hover:brightness-110 active:scale-95"
					>
						{$t.becomeHost}
					</button>
				{:else if isHost}
					<p class="mb-3 text-sm text-zinc-400">{$t.youreHostDesc}</p>
					<button
						onclick={releaseHost}
						class="w-full rounded-xl border border-white/5 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold transition hover:bg-white/[0.08] active:scale-95"
					>
						{$t.releaseHost}
					</button>
				{:else}
					<p class="flex items-center gap-2 text-sm text-zinc-400">
						<span class="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-xs">🎧</span>
						<span class="font-semibold text-white">{appState.host}</span> {$t.isHosting}
					</p>
				{/if}
			</div>
		{/if}
	</div>
</main>

<!-- Share modal -->
{#if showShare}
	<div
		class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
		transition:fade={{ duration: 150 }}
		onclick={() => (showShare = false)}
		role="presentation"
	>
		<div
			class="w-full max-w-xs rounded-2xl border border-white/10 bg-zinc-900 p-6 text-center shadow-2xl"
			onclick={(e) => e.stopPropagation()}
			role="presentation"
		>
			<h2 class="text-lg font-bold">{$t.shareTitle}</h2>
			<p class="mt-1 mb-4 text-xs text-zinc-500">{$t.shareDesc}</p>
			{#if qrCells.length > 0}
				<div class="mx-auto mb-4 w-fit rounded-xl bg-white p-3">
					<svg
						width="180"
						height="180"
						viewBox="0 0 {qrCells.length} {qrCells.length}"
						shape-rendering="crispEdges"
						aria-label="QR code"
					>
						{#each qrCells as row, y (y)}
							{#each row as cell, x (x)}
								{#if cell}
									<rect x={x} y={y} width="1" height="1" fill="#000" />
								{/if}
							{/each}
						{/each}
					</svg>
				</div>
			{/if}
			<div class="flex gap-2">
				<input
					readonly
					value={shareUrl}
					onfocus={(e) => e.currentTarget.select()}
					class="min-w-0 flex-1 rounded-xl border border-white/5 bg-zinc-950 px-3 py-2 text-xs text-zinc-300 outline-none"
				/>
				<button
					onclick={copyShare}
					class="shrink-0 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2 text-xs font-semibold transition hover:brightness-110 active:scale-95"
				>
					{copied ? $t.copied : $t.copy}
				</button>
			</div>
			<button
				onclick={() => (showShare = false)}
				class="mt-4 text-xs text-zinc-500 transition hover:text-zinc-300"
			>
				{$t.close}
			</button>
		</div>
	</div>
{/if}

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

	/* Floating emoji reactions */
	.floater {
		animation: floatUp 2.4s ease-out forwards;
	}
	@keyframes floatUp {
		0% {
			transform: translateY(0) scale(0.6);
			opacity: 0;
		}
		15% {
			opacity: 1;
			transform: translateY(-10px) scale(1.1);
		}
		100% {
			transform: translateY(-45vh) scale(1);
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.eq span {
			animation: none;
			transform: scaleY(0.6);
		}
		.floater {
			animation-duration: 1.2s;
		}
	}
</style>
