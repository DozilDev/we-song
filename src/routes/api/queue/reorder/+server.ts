import { json, error } from '@sveltejs/kit';
import { state, serialize, isHost, persist, notify } from '$lib/server/state.js';
import type { RequestHandler } from './$types.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	const sid = locals.sid;

	// Manual reordering is a host-only privilege, authorized by session id.
	if (!isHost(sid)) throw error(403, 'Only the host can reorder songs');

	let fromIndex: unknown;
	let toIndex: unknown;
	try {
		({ fromIndex, toIndex } = (await request.json()) as {
			fromIndex?: unknown;
			toIndex?: unknown;
		});
	} catch {
		throw error(400, 'Invalid request body');
	}

	if (
		!Number.isInteger(fromIndex) ||
		!Number.isInteger(toIndex) ||
		(fromIndex as number) < 0 ||
		(fromIndex as number) >= state.queue.length ||
		(toIndex as number) < 0 ||
		(toIndex as number) >= state.queue.length
	) {
		throw error(400, 'Invalid indices');
	}

	const [movedSong] = state.queue.splice(fromIndex as number, 1);
	state.queue.splice(toIndex as number, 0, movedSong);

	persist();
	notify();
	return json(serialize(sid));
};
