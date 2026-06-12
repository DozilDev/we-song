import { json, error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import {
	serialize,
	cleanName,
	pushChat,
	notify,
	notifyReaction,
	persist,
	withinChatCooldown,
	markChat,
	ALLOWED_REACTIONS,
	MAX_MESSAGE
} from '$lib/server/state.js';
import type { RequestHandler } from './$types.js';

// Two message kinds share one endpoint:
//   - reaction: a whitelisted emoji, fanned out transiently and never stored.
//   - message:  persisted chat text, included in the full state push.
// Both are rate-limited per session. Text is rendered as text on the client
// (never {@html}), so the only validation here is length + emoji whitelist.
export const POST: RequestHandler = async ({ request, locals }) => {
	const sid = locals.sid;

	let kind: unknown;
	let text: unknown;
	let name: unknown;
	try {
		({ kind, text, name } = (await request.json()) as {
			kind?: unknown;
			text?: unknown;
			name?: unknown;
		});
	} catch {
		throw error(400, 'Invalid request body');
	}

	const now = Date.now();
	if (withinChatCooldown(sid, now)) throw error(429, 'Slow down a moment');

	const from = cleanName(name);

	if (kind === 'reaction') {
		const emoji = typeof text === 'string' ? text : '';
		if (!ALLOWED_REACTIONS.has(emoji)) throw error(400, 'Unsupported reaction');
		markChat(sid, now);
		notifyReaction({ from, emoji, at: now });
		return json({ ok: true });
	}

	if (kind === 'message') {
		const body = typeof text === 'string' ? text.trim().slice(0, MAX_MESSAGE) : '';
		if (!body) throw error(400, 'Message is empty');
		markChat(sid, now);
		pushChat({ id: randomUUID(), from, fromSid: sid, text: body, at: now });
		persist();
		notify();
		return json(serialize(sid));
	}

	throw error(400, 'Unknown message kind');
};
