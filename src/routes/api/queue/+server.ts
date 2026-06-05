import { json, error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import {
	state,
	serialize,
	isHost,
	persist,
	notify,
	cleanName,
	withinAddCooldown,
	markAdded,
	MAX_QUEUE,
	MAX_TITLE
} from '$lib/server/state.js';
import type { Song } from '$lib/types.js';
import type { RequestHandler } from './$types.js';

// Anchor the match to a real YouTube host so URLs like
// `javascript:alert(1)//youtu.be/<id>` can no longer smuggle a video id past
// validation. We also rebuild a canonical URL from the id before storing it,
// so the value rendered into href is never attacker-controlled.
function extractVideoId(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

	const host = parsed.hostname.replace(/^www\./, '');
	let id: string | null = null;
	if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
		if (parsed.pathname === '/watch') id = parsed.searchParams.get('v');
		else if (parsed.pathname.startsWith('/embed/')) id = parsed.pathname.slice('/embed/'.length);
		else if (parsed.pathname.startsWith('/shorts/')) id = parsed.pathname.slice('/shorts/'.length);
	} else if (host === 'youtu.be') {
		id = parsed.pathname.slice(1);
	}
	return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
}

async function fetchTitle(videoId: string): Promise<string> {
	try {
		const res = await fetch(
			`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
		);
		if (res.ok) {
			const data = (await res.json()) as { title?: string };
			if (typeof data.title === 'string') return data.title;
		}
	} catch {
		// fall through
	}
	return 'Unknown Title';
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		if (body && typeof body === 'object') return body as Record<string, unknown>;
	} catch {
		// fall through
	}
	throw error(400, 'Invalid request body');
}

export const POST: RequestHandler = async ({ request, locals }) => {
	const sid = locals.sid;
	const { url, name } = await readBody(request);

	if (typeof url !== 'string') throw error(400, 'URL is required');

	const videoId = extractVideoId(url);
	if (!videoId) throw error(400, 'Invalid YouTube URL');

	const now = Date.now();
	if (withinAddCooldown(sid, now)) {
		throw error(429, 'Slow down — wait a moment before adding another song');
	}

	// Reject duplicates of the now-playing song or anything already queued.
	const duplicate =
		state.nowPlaying?.videoId === videoId || state.queue.some((s) => s.videoId === videoId);
	if (duplicate) throw error(409, 'That song is already in the queue');

	if (state.queue.length >= MAX_QUEUE) {
		throw error(400, `Queue is full (max ${MAX_QUEUE})`);
	}

	const title = (await fetchTitle(videoId)).slice(0, MAX_TITLE);
	const song: Song = {
		id: randomUUID(),
		url: `https://www.youtube.com/watch?v=${videoId}`,
		videoId,
		title,
		addedBy: cleanName(name),
		addedBySid: sid,
		addedAt: Date.now(),
		upvotes: []
	};

	if (!state.nowPlaying) {
		state.nowPlaying = song;
		state.isPaused = false;
	} else {
		state.queue.push(song);
	}

	markAdded(sid, now);
	persist();
	notify();
	return json(serialize(sid));
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	const sid = locals.sid;
	const { id } = await readBody(request);

	if (typeof id !== 'string') throw error(400, 'Song id is required');

	const songIndex = state.queue.findIndex((s) => s.id === id);
	if (songIndex === -1) throw error(404, 'Song not found in queue');

	// Removal is allowed only for the original adder or the host. Identity is
	// the session id, not a spoofable name.
	const song = state.queue[songIndex];
	if (song.addedBySid !== sid && !isHost(sid)) {
		throw error(403, 'Unauthorized to remove this song');
	}

	state.queue.splice(songIndex, 1);
	persist();
	notify();
	return json(serialize(sid));
};
