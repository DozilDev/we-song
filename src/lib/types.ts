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
}

export interface Host {
	sid: string;
	name: string;
}

export interface ServerState {
	queue: Song[];
	nowPlaying: Song | null;
	isPaused: boolean;
	host: Host | null;
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
}

export interface AppState {
	queue: SongView[];
	nowPlaying: SongView | null;
	isPaused: boolean;
	/** Display name of the current host, or null. */
	host: string | null;
	/** Whether the requesting client is the host. */
	isHost: boolean;
}
