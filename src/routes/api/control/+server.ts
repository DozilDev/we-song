import { json, error } from '@sveltejs/kit';
import { state, serialize, isHost, persist, notify } from '$lib/server/state.js';
import type { RequestHandler } from './$types.js';

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
			state.nowPlaying = state.queue.shift() ?? null;
			state.isPaused = false;
			break;
		case 'pause':
			if (state.nowPlaying) state.isPaused = !state.isPaused;
			break;
		case 'stop':
			state.nowPlaying = null;
			state.queue = [];
			state.isPaused = false;
			break;
		default:
			throw error(400, 'Unknown action');
	}

	persist();
	notify();
	return json(serialize(sid));
};
