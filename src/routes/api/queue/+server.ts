import { json, error } from '@sveltejs/kit';
import { randomUUID } from 'crypto';
import { state } from '$lib/server/state.js';
import type { RequestHandler } from './$types.js';

function extractVideoId(url: string): string | null {
	const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
	return m ? m[1] : null;
}

async function fetchTitle(videoId: string): Promise<string> {
	try {
		const res = await fetch(
			`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
		);
		if (res.ok) {
			const data = (await res.json()) as { title: string };
			return data.title;
		}
	} catch {}
	return 'Unknown Title';
}

export const POST: RequestHandler = async ({ request }) => {
	const { url, name } = (await request.json()) as { url: string; name: string };

	const videoId = extractVideoId(url);
	if (!videoId) throw error(400, 'Invalid YouTube URL');

	const title = await fetchTitle(videoId);
	const song = {
		id: randomUUID(),
		url,
		videoId,
		title,
		addedBy: name || 'Anonymous',
		addedAt: Date.now(),
		upvotes: []
	};

	if (!state.nowPlaying) {
		state.nowPlaying = song;
		state.isPaused = false;
	} else {
		state.queue.push(song);
	}

	return json(state);
};

export const DELETE: RequestHandler = async ({ request }) => {
	const { id, name } = (await request.json()) as { id: string; name: string };

	const songIndex = state.queue.findIndex((s) => s.id === id);
	if (songIndex === -1) {
		throw error(404, 'Song not found in queue');
	}

	const song = state.queue[songIndex];

	// Allow removal if the requester added the song or is the host
	if (song.addedBy === name || state.host === name) {
		state.queue.splice(songIndex, 1);
		return json(state);
	}

	throw error(403, 'Unauthorized to remove this song');
};
