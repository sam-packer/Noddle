import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_ROOMS_URL: {
		public: true,
		// Fixed at build time, so the app never has to ask a server for it before it can start.
		static: true,
		description: 'Address of the rooms worker. Local dev uses port 8787 on this machine when empty.',
		schema: (value) => value ?? ''
	}
});
