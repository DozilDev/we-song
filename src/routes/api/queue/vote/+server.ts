import { json, error } from '@sveltejs/kit';
import { state, serialize, persist, notify } from '$lib/server/state.js';
import type { RequestHandler } from './$types.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	const sid = locals.sid;

	let id: unknown;
	try {
		({ id } = (await request.json()) as { id?: unknown });
	} catch {
		throw error(400, 'Invalid request body');
	}

	if (typeof id !== 'string') throw error(400, 'Song id is required');

	const song = state.queue.find((s) => s.id === id);
	if (!song) throw error(404, 'Song not found in queue');

	// Votes are keyed by session id, so one client = one vote. Toggling removes
	// it. Renaming can no longer be used to stuff the ballot.
	const voteIndex = song.upvotes.indexOf(sid);
	if (voteIndex === -1) song.upvotes.push(sid);
	else song.upvotes.splice(voteIndex, 1);

	// Re-sort: most-upvoted first, ties broken by insertion order (fairness).
	state.queue.sort((a, b) => {
		if (a.upvotes.length !== b.upvotes.length) return b.upvotes.length - a.upvotes.length;
		return a.addedAt - b.addedAt;
	});

	persist();
	notify();
	return json(serialize(sid));
};
