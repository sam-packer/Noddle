import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** Dev only: saves a recorded tracking session, so it can be analysed without a browser. */
function saveRecordings(): Plugin {
	return {
		name: 'save-recordings',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use('/__recording', (req, res) => {
				let body = '';
				req.on('data', (chunk) => (body += chunk));
				req.on('end', () => {
					mkdirSync('.recordings', { recursive: true });
					writeFileSync(`.recordings/${Date.now()}.json`, body);
					res.end('saved');
				});
			});

			// Every play session, appended as it happens so a crash loses almost nothing.
			server.middlewares.use('/__session', (req, res) => {
				const url = new URL(req.url ?? '', 'http://local');
				const id = (url.searchParams.get('id') ?? 'unknown').replace(/\W/g, '');
				mkdirSync('.recordings/sessions', { recursive: true });
				const chunks: Buffer[] = [];
				req.on('data', (chunk) => chunks.push(chunk));
				req.on('end', () => {
					appendFileSync(`.recordings/sessions/${id}.jsonl`, Buffer.concat(chunks));
					res.end('ok');
				});
			});

			// Eye comparison runs: the numbers, and the magnified clip. Never leaves this machine.
			server.middlewares.use('/__eyes', (req, res) => {
				const url = new URL(req.url ?? '', 'http://local');
				const id = (url.searchParams.get('id') ?? 'unknown').replace(/\W/g, '');
				const ext = (url.searchParams.get('ext') ?? 'json').replace(/\W/g, '');
				mkdirSync('.recordings/eyes', { recursive: true });
				const chunks: Buffer[] = [];
				req.on('data', (chunk) => chunks.push(chunk));
				req.on('end', () => {
					writeFileSync(`.recordings/eyes/${id}.${ext}`, Buffer.concat(chunks));
					res.end('saved');
				});
			});

			// Face crops and their labels, from the data collector. Never leaves this machine.
			server.middlewares.use('/__dataset', (req, res) => {
				const url = new URL(req.url ?? '', 'http://local');
				const session = (url.searchParams.get('session') ?? 'unknown').replace(/\W/g, '');
				const dir = `${process.env.DATASET_DIR ?? '.dataset'}/${session}`;
				mkdirSync(`${dir}/frames`, { recursive: true });
				const chunks: Buffer[] = [];
				req.on('data', (chunk) => chunks.push(chunk));
				req.on('end', () => {
					const body = Buffer.concat(chunks);
					if (url.pathname === '/frame') {
						const n = String(url.searchParams.get('n') ?? '0').replace(/\D/g, '');
						writeFileSync(`${dir}/frames/${n.padStart(6, '0')}.jpg`, body);
					} else if (url.pathname === '/labels') {
						appendFileSync(`${dir}/labels.jsonl`, body);
					} else if (url.pathname === '/meta') {
						writeFileSync(`${dir}/meta.json`, body);
					}
					res.end('ok');
				});
			});
		}
	};
}

export default defineConfig({
	worker: { format: 'es' },
	plugins: [
		saveRecordings(),
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	]
});
