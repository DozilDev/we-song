import { randomUUID } from 'node:crypto';
import type { Handle } from '@sveltejs/kit';

// Issue a stable, server-controlled session id to every client. This is the
// trusted identity used for all authorization (host, deletion, voting). The
// client-supplied `name` is only ever a display label and is never trusted for
// access decisions, so identity cannot be spoofed by sending someone's name.
export const handle: Handle = async ({ event, resolve }) => {
	let sid = event.cookies.get('sid');
	if (!sid) {
		sid = randomUUID();
		event.cookies.set('sid', sid, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			maxAge: 60 * 60 * 24 * 365
		});
	}
	event.locals.sid = sid;
	return resolve(event);
};
