import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { state } from '$lib/server/state.js';
import type { RequestHandler } from './$types.js';

export const POST: RequestHandler = async ({ request }: RequestEvent) => {
	const { fromIndex, toIndex, name } = (await request.json()) as {
		fromIndex: number;
		toIndex: number;
		name: string;
	};

	// Only the host has permission to manually reorder songs in the queue
	if (!state.host || state.host !== name) {
		throw error(403, 'Only the host can reorder songs');
	}

	if (
		fromIndex < 0 ||
		fromIndex >= state.queue.length ||
		toIndex < 0 ||
		toIndex >= state.queue.length
	) {
		throw error(400, 'Invalid indices');
	}

	// Move item from fromIndex to toIndex in the queue array
	const [movedSong] = state.queue.splice(fromIndex, 1);
	state.queue.splice(toIndex, 0, movedSong);

	return json(state);
};
