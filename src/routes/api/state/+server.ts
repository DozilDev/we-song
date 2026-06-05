import { json } from '@sveltejs/kit';
import { serialize } from '$lib/server/state.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = ({ locals }) => {
	return json(serialize(locals.sid), {
		headers: { 'cache-control': 'no-store' }
	});
};
