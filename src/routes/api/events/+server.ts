import {
	serialize,
	addSubscriber,
	removeSubscriber,
	state,
	type Subscriber
} from '$lib/server/state.js';
import type { ReactionEvent } from '$lib/types.js';
import type { RequestHandler } from './$types.js';

// Realtime state stream. Replaces client polling: clients open one EventSource
// and the server pushes a fresh, per-session view on every change. The lifetime
// of this connection also acts as the host's presence heartbeat (see
// addSubscriber/removeSubscriber in state.ts).
export const GET: RequestHandler = ({ locals }) => {
	const sid = locals.sid;
	const encoder = new TextEncoder();
	let sub: Subscriber;
	let ping: ReturnType<typeof setInterval>;

	const stream = new ReadableStream({
		start(controller) {
			const enqueue = (chunk: string) => controller.enqueue(encoder.encode(chunk));
			const send = () => enqueue(`data: ${JSON.stringify(serialize(sid))}\n\n`);
			// Named events ride the same connection but bypass the full-state push:
			// progress fires often, reactions are transient. Clients listen for them
			// separately (addEventListener) from the default `message` event.
			const sendProgress = () =>
				enqueue(`event: progress\ndata: ${JSON.stringify(state.progress)}\n\n`);
			const sendReaction = (r: ReactionEvent) =>
				enqueue(`event: reaction\ndata: ${JSON.stringify(r)}\n\n`);

			sub = { sid, send, sendProgress, sendReaction };
			addSubscriber(sub);

			// Tell the browser how fast to reconnect, then push initial state.
			enqueue('retry: 3000\n\n');
			send();

			// Keep-alive comment so proxies don't drop an idle connection and so a
			// dead socket surfaces as a write error (-> cleanup via cancel).
			ping = setInterval(() => {
				try {
					enqueue(': ping\n\n');
				} catch {
					// connection gone; cancel() will clean up
				}
			}, 25_000);
		},
		cancel() {
			clearInterval(ping);
			removeSubscriber(sub);
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			// Disable proxy buffering (nginx) so events flush immediately.
			'x-accel-buffering': 'no'
		}
	});
};
