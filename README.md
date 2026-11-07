# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
bun x sv@1.3.0 create --template minimal --types ts --add tailwindcss="plugins:typography,forms" sveltekit-adapter="adapter:cloudflare+cfTarget:workers" drizzle="database:d1" ai-tools="ide:claude-code,other+delivery:plugin+optInSkills:svelte-mcp-feedback" --install bun triangle-ai-hackathon
```

## Adding features

Add features to your project with `sv add`:

```sh
npx sv add
```

For example, to add Tailwind CSS:

```sh
npx sv add tailwindcss
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

## Tuning head tracking from recordings

Polish here is driven by recordings of real play, so changes can be checked against what the player actually did.

- **Every session on the dev server records itself** to `.recordings/sessions/`: head angles, the pointer, what was selected, every gesture and pick, and what the game was showing. It never records video, and production builds record nothing.
- **Press `M` during play** to mark a mistake at that moment.
- **Press `G`** for a guided recording of nods, shakes and normal head movement.
- **`bun run report`** explains the newest session: a timeline, a list of moments worth checking, and a chart saved to `.recordings/reports/`. Pass a file to read an older one.
- **`bun run replay`** runs the real detector over saved recordings and scores it against `scripts/labels.json`. Run it after any change to `src/lib/vision/gestures.ts`.

After a session, add what the player meant to do to `scripts/labels.json`, so that mistake stays covered by `bun run replay` from then on. Recordings stay in `.recordings`, which is not committed, and `bun run replay` skips any that aren't there.

