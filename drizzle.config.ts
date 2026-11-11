import { defineConfig } from 'drizzle-kit';

// Migrations are applied by `wrangler d1 migrations apply` (see deploy:rooms), never by drizzle-kit,
// so only Studio talks to the database and needs credentials. `db:generate` works without them.
const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID, CLOUDFLARE_D1_TOKEN } = process.env;
if (process.argv.includes('studio') && !(CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_DATABASE_ID && CLOUDFLARE_D1_TOKEN)) {
	throw new Error('db:studio needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID and CLOUDFLARE_D1_TOKEN in .env');
}

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	dialect: 'sqlite',
	driver: 'd1-http',
	dbCredentials: {
		accountId: CLOUDFLARE_ACCOUNT_ID ?? '',
		databaseId: CLOUDFLARE_DATABASE_ID ?? '',
		token: CLOUDFLARE_D1_TOKEN ?? ''
	},
	verbose: true,
	strict: true
});
