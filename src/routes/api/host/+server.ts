import { json, error } from '@sveltejs/kit';
import { state, serialize, cleanName, persist, notify } from '$lib/server/state.js';
import type { RequestHandler } from './$types.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	const sid = locals.sid;

	let action: unknown;
	let name: unknown;
	try {
		({ action, name } = (await request.json()) as { action?: unknown; name?: unknown });
	} catch {
		throw error(400, 'Invalid request body');
	}

	if (action === 'claim') {
		// First come, first served — but only when the seat is empty.
		if (!state.host) state.host = { sid, name: cleanName(name) };
	} else if (action === 'release') {
		// Only the current host (by session id) can step down. Sending another
		// person's name no longer releases or hijacks the host seat.
		if (state.host?.sid === sid) state.host = null;
	} else {
		throw error(400, 'Unknown action');
	}

	persist();
	notify();
	return json(serialize(sid));
};
