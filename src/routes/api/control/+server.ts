import { json, error } from '@sveltejs/kit';
import {
	state,
	serialize,
	isHost,
	persist,
	notify,
	pushHistory,
	addVotesReceived
} from '$lib/server/state.js';
import type { Song } from '$lib/types.js';
import type { RequestHandler } from './$types.js';

/** Archive a finishing song: record it in history and bank its votes. */
function retire(song: Song): void {
	pushHistory(song);
	addVotesReceived(song.addedBySid, song.addedBy, song.upvotes.length);
}

export const POST: RequestHandler = async ({ request, locals }) => {
	const sid = locals.sid;

	// Playback control affects everyone in the room (skip/pause and especially
	// `stop`, which clears the whole queue). Only the host — who actually plays
	// the audio — may do it.
	if (!isHost(sid)) throw error(403, 'Only the host can control playback');

	let action: unknown;
	try {
		({ action } = (await request.json()) as { action?: unknown });
	} catch {
		throw error(400, 'Invalid request body');
	}

	switch (action) {
		case 'skip':
			if (state.nowPlaying) retire(state.nowPlaying);
			state.nowPlaying = state.queue.shift() ?? null;
			state.isPaused = false;
			state.progress = null;
			break;
		case 'pause':
			if (state.nowPlaying) state.isPaused = !state.isPaused;
			break;
		case 'stop':
			if (state.nowPlaying) retire(state.nowPlaying);
			state.nowPlaying = null;
			state.queue = [];
			state.isPaused = false;
			state.progress = null;
			break;
		default:
			throw error(400, 'Unknown action');
	}

	persist();
	notify();
	return json(serialize(sid));
};
