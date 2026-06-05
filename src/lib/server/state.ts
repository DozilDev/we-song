import { readFileSync, writeFileSync } from 'node:fs';
import type { AppState, ServerState, Song, SongView } from '$lib/types.js';

// --- Limits ----------------------------------------------------------------
export const MAX_QUEUE = 100;
export const MAX_NAME = 40;
export const MAX_TITLE = 200;
/** Minimum gap between two song additions from the same client. */
const ADD_COOLDOWN_MS = 1500;

// --- State -----------------------------------------------------------------
export const state: ServerState = {
	queue: [],
	nowPlaying: null,
	isPaused: false,
	host: null
};

// --- Input helpers ---------------------------------------------------------

/** Normalize a client-supplied display name. Always returns a safe string. */
export function cleanName(name: unknown): string {
	if (typeof name !== 'string') return 'Anonymous';
	const trimmed = name.trim().slice(0, MAX_NAME);
	return trimmed || 'Anonymous';
}

// --- Rate limiting (per session) -------------------------------------------
const lastAdd = new Map<string, number>();

export function withinAddCooldown(sid: string, now: number): boolean {
	return now - (lastAdd.get(sid) ?? 0) < ADD_COOLDOWN_MS;
}

export function markAdded(sid: string, now: number): void {
	lastAdd.set(sid, now);
}

// --- Serialization (server-authoritative view per client) ------------------
function toView(song: Song, sid: string): SongView {
	return {
		id: song.id,
		url: song.url,
		videoId: song.videoId,
		title: song.title,
		addedBy: song.addedBy,
		addedAt: song.addedAt,
		votes: song.upvotes.length,
		voted: song.upvotes.includes(sid),
		mine: song.addedBySid === sid
	};
}

/** Build the client-facing view of the current state for a given session. */
export function serialize(sid: string): AppState {
	return {
		queue: state.queue.map((s) => toView(s, sid)),
		nowPlaying: state.nowPlaying ? toView(state.nowPlaying, sid) : null,
		isPaused: state.isPaused,
		host: state.host?.name ?? null,
		isHost: !!state.host && state.host.sid === sid
	};
}

export function isHost(sid: string): boolean {
	return !!state.host && state.host.sid === sid;
}

// --- Realtime fan-out (Server-Sent Events) ---------------------------------
// Every open SSE connection registers a subscriber. On any state change we push
// a freshly-serialized view to each one (personalized by their session id).
export interface Subscriber {
	sid: string;
	send: () => void;
}

const subscribers = new Set<Subscriber>();

/** Number of live connections per session — a session's presence heartbeat. */
const connections = new Map<string, number>();
/** Pending host auto-release timers, keyed by host session id. */
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Grace period before a disconnected host loses the seat. Covers refreshes,
 * brief network blips, and tab navigation without dropping the host instantly.
 */
const HOST_GRACE_MS = 12_000;

/** Push the current state to every connected client. Safe to call anywhere. */
export function notify(): void {
	for (const sub of subscribers) {
		try {
			sub.send();
		} catch {
			subscribers.delete(sub);
		}
	}
}

export function addSubscriber(sub: Subscriber): void {
	subscribers.add(sub);
	connections.set(sub.sid, (connections.get(sub.sid) ?? 0) + 1);
	// The host reconnected within the grace window — cancel any pending release.
	const pending = releaseTimers.get(sub.sid);
	if (pending) {
		clearTimeout(pending);
		releaseTimers.delete(sub.sid);
	}
}

export function removeSubscriber(sub: Subscriber): void {
	subscribers.delete(sub);
	const remaining = (connections.get(sub.sid) ?? 1) - 1;
	if (remaining > 0) {
		connections.set(sub.sid, remaining);
		return;
	}
	connections.delete(sub.sid);

	// Last connection for this session is gone. If it was the host, release the
	// seat after a grace period so a stuck/closed host browser can't hold it
	// hostage. A reconnect within the window cancels this (see addSubscriber).
	if (state.host?.sid === sub.sid) {
		const timer = setTimeout(() => {
			releaseTimers.delete(sub.sid);
			if (state.host?.sid === sub.sid && !connections.has(sub.sid)) {
				state.host = null;
				persist();
				notify();
			}
		}, HOST_GRACE_MS);
		releaseTimers.set(sub.sid, timer);
	}
}

// --- Best-effort persistence -----------------------------------------------
// Survives server restarts/redeploys. Opt-in via the WE_SONG_DATA env var so
// it never writes files in environments that don't want it. All I/O is wrapped
// so a failing disk can never take down the API.
const DATA_FILE = process.env.WE_SONG_DATA ?? '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): void {
	if (!DATA_FILE) return;
	try {
		const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as Partial<ServerState>;
		state.queue = Array.isArray(parsed.queue) ? parsed.queue : [];
		state.nowPlaying = parsed.nowPlaying ?? null;
		state.isPaused = !!parsed.isPaused;
		state.host = parsed.host ?? null;
	} catch {
		// No file yet / unreadable — start fresh.
	}
}

export function persist(): void {
	if (!DATA_FILE) return;
	if (saveTimer) return; // debounce: at most one write per tick
	saveTimer = setTimeout(() => {
		saveTimer = null;
		try {
			writeFileSync(DATA_FILE, JSON.stringify(state));
		} catch {
			// Ignore — persistence is best-effort.
		}
	}, 250);
}

load();
