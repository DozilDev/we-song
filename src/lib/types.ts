// ---------------------------------------------------------------------------
// Internal, server-side types. These hold trust-sensitive fields (session ids)
// that are NEVER sent to clients — see the *View types for what clients see.
// ---------------------------------------------------------------------------

export interface Song {
	id: string;
	url: string;
	videoId: string;
	title: string;
	/** Display name of whoever added the song. Not used for authorization. */
	addedBy: string;
	/** Session id of the adder. Used to authorize deletion. Never serialized. */
	addedBySid: string;
	addedAt: number;
	/** Session ids that have upvoted. Never serialized (only the count is). */
	upvotes: string[];
	/**
	 * Playback length in seconds, learned from the host's player while the song
	 * plays (the oEmbed endpoint doesn't expose it). `null` until known.
	 */
	durationSec: number | null;
}

export interface Host {
	sid: string;
	name: string;
}

/**
 * A song that finished playing. Deliberately omits session ids and votes — it
 * is a display-only record, and a re-add re-attributes the song to the re-adder.
 */
export interface HistoryEntry {
	videoId: string;
	url: string;
	title: string;
	addedBy: string;
	playedAt: number;
	durationSec: number | null;
}

/** A chat message. `fromSid` authorizes the `mine` flag and is never serialized. */
export interface ChatItem {
	id: string;
	from: string;
	fromSid: string;
	text: string;
	at: number;
}

/**
 * Live playback position, reported by the host and fanned out on a dedicated SSE
 * event (never via the full-state push). Ephemeral — never persisted.
 */
export interface PlaybackProgress {
	position: number;
	duration: number;
	paused: boolean;
	/** Server-stamped receipt time, so clients can interpolate between updates. */
	updatedAt: number;
}

/** A transient emoji reaction. Broadcast on its own SSE event; never stored. */
export interface ReactionEvent {
	from: string;
	emoji: string;
	at: number;
}

export interface ServerState {
	queue: Song[];
	nowPlaying: Song | null;
	isPaused: boolean;
	host: Host | null;
	history: HistoryEntry[];
	chat: ChatItem[];
	/** Live position of the now-playing song. Reset to null on every song change. */
	progress: PlaybackProgress | null;
}

// ---------------------------------------------------------------------------
// Client-facing view. This is what every API endpoint returns. It is computed
// per-request from the caller's session id so the UI can be driven entirely by
// server-authoritative booleans (no secrets leak to the browser).
// ---------------------------------------------------------------------------

export interface SongView {
	id: string;
	url: string;
	videoId: string;
	title: string;
	addedBy: string;
	addedAt: number;
	/** Number of upvotes. */
	votes: number;
	/** Whether the requesting client has upvoted this song. */
	voted: boolean;
	/** Whether the requesting client added this song (may delete it). */
	mine: boolean;
	/** Playback length in seconds, or null if not yet known. */
	durationSec: number | null;
}

export interface HistoryEntryView {
	videoId: string;
	url: string;
	title: string;
	addedBy: string;
	playedAt: number;
	durationSec: number | null;
}

export interface ChatItemView {
	id: string;
	from: string;
	text: string;
	at: number;
	/** Whether the requesting client sent this message. */
	mine: boolean;
}

/** One person's contribution tallies. Names only — never session ids. */
export interface StatView {
	name: string;
	songsAdded: number;
	votesReceived: number;
}

export interface StatsView {
	/** Name of the person who has added the most songs, or null. */
	topContributor: string | null;
	/** Name of the person whose songs earned the most votes, or null. */
	mostLiked: string | null;
	/** The requesting client's own tallies. */
	me: StatView;
	/** Top contributors by songs added (names only). */
	leaderboard: StatView[];
}

export interface AppState {
	queue: SongView[];
	nowPlaying: SongView | null;
	isPaused: boolean;
	/** Display name of the current host, or null. */
	host: string | null;
	/** Whether the requesting client is the host. */
	isHost: boolean;
	/** Most-recently-played songs, newest first. */
	history: HistoryEntryView[];
	/** Recent chat messages, oldest first. */
	chat: ChatItemView[];
	/** Contribution stats for the room. */
	stats: StatsView;
}
