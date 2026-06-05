import { readFileSync, writeFileSync } from 'node:fs';
import type {
	AppState,
	ChatItem,
	ChatItemView,
	HistoryEntry,
	HistoryEntryView,
	ReactionEvent,
	ServerState,
	Song,
	SongView,
	StatView,
	StatsView
} from '$lib/types.js';

// --- Limits ----------------------------------------------------------------
export const MAX_QUEUE = 100;
export const MAX_NAME = 40;
export const MAX_TITLE = 200;
export const MAX_HISTORY = 30;
export const MAX_CHAT = 50;
export const MAX_MESSAGE = 200;
/** Minimum gap between two song additions from the same client. */
const ADD_COOLDOWN_MS = 1500;
/** Minimum gap between two chat/reaction sends from the same client. */
const CHAT_COOLDOWN_MS = 700;

/** Emoji a client is allowed to react with. Anything else is rejected. */
export const ALLOWED_REACTIONS = new Set(['👏', '🔥', '❤️', '😂', '🎉', '🕺', '🎶']);

// --- State -----------------------------------------------------------------
export const state: ServerState = {
	queue: [],
	nowPlaying: null,
	isPaused: false,
	host: null,
	history: [],
	chat: [],
	progress: null
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

const lastChat = new Map<string, number>();

export function withinChatCooldown(sid: string, now: number): boolean {
	return now - (lastChat.get(sid) ?? 0) < CHAT_COOLDOWN_MS;
}

export function markChat(sid: string, now: number): void {
	lastChat.set(sid, now);
}

// --- Contribution stats (ephemeral, keyed by session id) -------------------
// Keyed by the trusted session id so names can't be used to inflate anyone's
// numbers. The display name is best-effort (the latest one seen for that sid).
interface SidStats {
	name: string;
	songsAdded: number;
	votesReceived: number;
}
const stats = new Map<string, SidStats>();

function statsFor(sid: string, name: string): SidStats {
	let s = stats.get(sid);
	if (!s) {
		s = { name, songsAdded: 0, votesReceived: 0 };
		stats.set(sid, s);
	} else if (name) {
		s.name = name;
	}
	return s;
}

/** Record that `sid` (display name `name`) added a song. */
export function incSongsAdded(sid: string, name: string): void {
	statsFor(sid, name).songsAdded += 1;
}

/** Credit `votes` upvotes to the adder of a song that just left the queue. */
export function addVotesReceived(sid: string, name: string, votes: number): void {
	if (votes > 0) statsFor(sid, name).votesReceived += votes;
}

// --- History / chat mutators -----------------------------------------------

/** Record a finished song in the bounded recently-played list (newest first). */
export function pushHistory(song: Song): void {
	state.history.unshift({
		videoId: song.videoId,
		url: song.url,
		title: song.title,
		addedBy: song.addedBy,
		playedAt: Date.now(),
		durationSec: song.durationSec
	});
	if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
}

/** Append a chat message, trimming the oldest beyond the bound. */
export function pushChat(item: ChatItem): void {
	state.chat.push(item);
	if (state.chat.length > MAX_CHAT) state.chat.shift();
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
		mine: song.addedBySid === sid,
		durationSec: song.durationSec
	};
}

function toHistoryView(entry: HistoryEntry): HistoryEntryView {
	return {
		videoId: entry.videoId,
		url: entry.url,
		title: entry.title,
		addedBy: entry.addedBy,
		playedAt: entry.playedAt,
		durationSec: entry.durationSec
	};
}

function toChatView(item: ChatItem, sid: string): ChatItemView {
	return {
		id: item.id,
		from: item.from,
		text: item.text,
		at: item.at,
		mine: item.fromSid === sid
	};
}

/**
 * Build the contribution stats view. Combines the running per-sid tally (for
 * songs that already left the queue) with the votes currently sitting on live
 * queue / now-playing songs, so counts stay accurate without persisting votes.
 */
function buildStats(sid: string): StatsView {
	// Start from the running tally (songs added + votes already banked).
	const live = new Map<string, SidStats>();
	for (const [k, v] of stats) live.set(k, { ...v });

	// Add votes from songs still in play so they're reflected immediately.
	const tallyLiveVotes = (song: Song | null) => {
		if (!song) return;
		const entry = live.get(song.addedBySid) ?? {
			name: song.addedBy,
			songsAdded: 0,
			votesReceived: 0
		};
		if (song.addedBy) entry.name = entry.name || song.addedBy;
		entry.votesReceived += song.upvotes.length;
		live.set(song.addedBySid, entry);
	};
	for (const s of state.queue) tallyLiveVotes(s);
	tallyLiveVotes(state.nowPlaying);

	const entries = [...live.entries()].filter(([, v]) => v.songsAdded > 0 || v.votesReceived > 0);

	const topContributor =
		entries.length > 0
			? entries.reduce((a, b) => (b[1].songsAdded > a[1].songsAdded ? b : a))[1].name
			: null;
	const mostLiked =
		entries.length > 0
			? entries.reduce((a, b) => (b[1].votesReceived > a[1].votesReceived ? b : a))[1].name
			: null;

	const mine = live.get(sid) ?? { name: '', songsAdded: 0, votesReceived: 0 };

	const leaderboard: StatView[] = entries
		.map(([, v]) => ({ name: v.name, songsAdded: v.songsAdded, votesReceived: v.votesReceived }))
		.sort((a, b) => b.songsAdded - a.songsAdded || b.votesReceived - a.votesReceived)
		.slice(0, 5);

	return {
		topContributor,
		mostLiked,
		me: { name: mine.name, songsAdded: mine.songsAdded, votesReceived: mine.votesReceived },
		leaderboard
	};
}

/** Build the client-facing view of the current state for a given session. */
export function serialize(sid: string): AppState {
	return {
		queue: state.queue.map((s) => toView(s, sid)),
		nowPlaying: state.nowPlaying ? toView(state.nowPlaying, sid) : null,
		isPaused: state.isPaused,
		host: state.host?.name ?? null,
		isHost: !!state.host && state.host.sid === sid,
		history: state.history.map(toHistoryView),
		chat: state.chat.map((c) => toChatView(c, sid)),
		stats: buildStats(sid)
	};
}

export function isHost(sid: string): boolean {
	return !!state.host && state.host.sid === sid;
}

// --- Realtime fan-out (Server-Sent Events) ---------------------------------
// Every open SSE connection registers a subscriber. On any state change we push
// a freshly-serialized view to each one (personalized by their session id).
// Two extra, lightweight channels exist alongside the full-state `send`:
//   - progress: the now-playing position, broadcast far more often than state
//     changes, so routing it through the full serialize would be wasteful.
//   - reaction: transient floating emoji that are never stored in state.
export interface Subscriber {
	sid: string;
	send: () => void;
	sendProgress: () => void;
	sendReaction: (r: ReactionEvent) => void;
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

/** Push only the lightweight playback-progress event to every client. */
export function notifyProgress(): void {
	for (const sub of subscribers) {
		try {
			sub.sendProgress();
		} catch {
			subscribers.delete(sub);
		}
	}
}

/** Fan out a transient emoji reaction to every client. */
export function notifyReaction(reaction: ReactionEvent): void {
	for (const sub of subscribers) {
		try {
			sub.sendReaction(reaction);
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

/** Shape written to disk. Progress is ephemeral and deliberately excluded. */
interface PersistShape {
	queue: Song[];
	nowPlaying: Song | null;
	isPaused: boolean;
	host: ServerState['host'];
	history: HistoryEntry[];
	chat: ChatItem[];
	stats: Array<[string, SidStats]>;
}

/** Backfill fields that may be missing from an older persisted Song. */
function reviveSong(song: Song): Song {
	return { ...song, durationSec: song.durationSec ?? null };
}

function load(): void {
	if (!DATA_FILE) return;
	try {
		const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as Partial<PersistShape>;
		state.queue = Array.isArray(parsed.queue) ? parsed.queue.map(reviveSong) : [];
		state.nowPlaying = parsed.nowPlaying ? reviveSong(parsed.nowPlaying) : null;
		state.isPaused = !!parsed.isPaused;
		state.host = parsed.host ?? null;
		state.history = Array.isArray(parsed.history) ? parsed.history : [];
		state.chat = Array.isArray(parsed.chat) ? parsed.chat : [];
		state.progress = null; // never restore a stale position
		stats.clear();
		if (Array.isArray(parsed.stats)) {
			for (const [k, v] of parsed.stats) stats.set(k, v);
		}
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
			const payload: PersistShape = {
				queue: state.queue,
				nowPlaying: state.nowPlaying,
				isPaused: state.isPaused,
				host: state.host,
				history: state.history,
				chat: state.chat,
				stats: [...stats.entries()]
			};
			writeFileSync(DATA_FILE, JSON.stringify(payload));
		} catch {
			// Ignore — persistence is best-effort.
		}
	}, 250);
}

load();
