import { json, error } from '@sveltejs/kit';
import { state, isHost, notifyProgress, notify, persist } from '$lib/server/state.js';
import type { RequestHandler } from './$types.js';

// The host owns the only real player, so it alone knows the playback position.
// It POSTs here on a throttled interval; we stamp the receipt time and fan the
// position out on a dedicated, lightweight SSE event (never the full state).
export const POST: RequestHandler = async ({ request, locals }) => {
	const sid = locals.sid;
	if (!isHost(sid)) throw error(403, 'Only the host reports progress');

	let position: unknown;
	let duration: unknown;
	try {
		({ position, duration } = (await request.json()) as {
			position?: unknown;
			duration?: unknown;
		});
	} catch {
		throw error(400, 'Invalid request body');
	}

	if (typeof position !== 'number' || typeof duration !== 'number') {
		throw error(400, 'position and duration must be numbers');
	}
	if (!Number.isFinite(position) || !Number.isFinite(duration) || duration < 0) {
		throw error(400, 'Invalid position or duration');
	}

	// Stale report after a song change — ignore rather than broadcast a ghost.
	if (!state.nowPlaying) return json({ ok: true });

	state.progress = {
		position,
		duration,
		paused: state.isPaused,
		updatedAt: Date.now()
	};
	notifyProgress();

	// Learn the song's duration the first time the host reports it, so the queue
	// and history can show it. Only push full state on the transition from null.
	const dur = Math.round(duration);
	if (dur > 0 && state.nowPlaying.durationSec !== dur) {
		state.nowPlaying.durationSec = dur;
		persist();
		notify();
	}

	return json({ ok: true });
};
