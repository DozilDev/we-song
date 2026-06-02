import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { state } from '$lib/server/state.js';
import type { RequestHandler } from './$types.js';

export const POST: RequestHandler = async ({ request }: RequestEvent) => {
	const { id, name } = (await request.json()) as { id: string; name: string };

	if (!name) {
		throw error(400, 'Name is required to vote');
	}

	const song = state.queue.find((s) => s.id === id);
	if (!song) {
		throw error(404, 'Song not found in queue');
	}

	// Ensure upvotes array exists
	if (!song.upvotes) {
		song.upvotes = [];
	}

	const voteIndex = song.upvotes.indexOf(name);
	if (voteIndex === -1) {
		// User has not voted yet, add their name (Upvote)
		song.upvotes.push(name);
	} else {
		// User has already voted, remove their name (Cancel Upvote)
		song.upvotes.splice(voteIndex, 1);
	}

	// Re-sort the queue:
	// 1. By upvote count (descending)
	// 2. By added time (ascending) to maintain queue fairness
	state.queue.sort((a, b) => {
		const aVotes = a.upvotes?.length ?? 0;
		const bVotes = b.upvotes?.length ?? 0;

		if (aVotes !== bVotes) {
			return bVotes - aVotes;
		}
		return a.addedAt - b.addedAt;
	});

	return json(state);
};
