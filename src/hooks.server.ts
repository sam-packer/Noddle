import type { Handle } from '@sveltejs/kit/hooks';

/** Link previews need full addresses, so the page's tags are filled in with wherever it's served from. */
export const handle: Handle = ({ event, resolve }) =>
	resolve(event, {
		transformPageChunk: ({ html }) => html.replaceAll('%origin%', event.url.origin)
	});
