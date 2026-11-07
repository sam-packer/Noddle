# Noddle

Uno and Scrabble played with head movements through a laptop webcam. The head points and a nod confirms. All vision runs in the browser, and video never leaves the device.

## Playing

`/` opens the menu once the camera has found you, and the instructions run before whatever you open first. Every screen has a button to go back, and anything that would lose your place asks first.

- **Single player:** Uno against three bots, or Scrabble against one. Neither needs internet.
- **Multiplayer:** share the room link, or the code, which the other person picks with their head under Join with a code. Uno takes 2 to 4 people, with bots in any empty seats, and Scrabble takes 2.
- **Demo:** the scripted run: a Uno hand, then a Scrabble word. It needs no server beyond the page itself. ↺ Restart, in the corner and at the end, takes it back to the lesson.

Everything a player does works by head alone. Keys and the mouse are only there for development: arrows or hover to select, Enter or click to confirm, and Esc to undo a tile.

## Multiplayer

The browser connects directly to a separate rooms worker in `workers/rooms`, with one Durable Object per room running the same rules engines as the page. Each player only ever receives their own view, so hidden hands and racks never reach another browser.

```sh
bun run dev:all      # the app and the rooms worker, with local storage
bun run rooms:check  # plays real games over real sockets, against `bun run dev:rooms`
```

To deploy, first create the database, then put its id in `workers/rooms/wrangler.jsonc`:

```sh
bunx wrangler d1 create noddle
bunx wrangler d1 migrations apply noddle --remote --config workers/rooms/wrangler.jsonc
bun run deploy:rooms
PUBLIC_ROOMS_URL=https://<your rooms worker> bunx vite build
bunx wrangler deploy
```

`PUBLIC_ROOMS_URL` is fixed at build time, so build after the rooms worker has its address.

## Code layout

- `src/lib/games`: rules engines and bots. Pure and seeded.
- `src/lib/session`: the Game Session the screens talk to, with demo, local and remote versions. Screens don't know which they have.
- `src/lib/stages`: the screens.
- `src/lib/vision`, `src/lib/input`: head tracking and targets. Run `bun run gate` after changing these, and try it on a real head.

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
- **Press `D` to open the debug panel.** The tools below only start while it's open, so a stray key can't start one.
- **Press `G`** for a guided recording of nods, shakes and normal head movement.
- **`bun run report`** explains the newest session: a timeline, a list of moments worth checking, every movement that looked like a gesture but didn't count (with the detector's own reason), and a chart saved to `.recordings/reports/`. Pass a file to read an older one.
- **`bun run replay`** runs the real detector over saved recordings and scores it against `scripts/labels.json`. Run it after any change to `src/lib/vision/gestures.ts`.
- **`bun run pointer`** measures smoothing against recorded head movement. Treat it as a hint only: it can't show how a player reacts to the pointer, and a setting it scored far better made real play worse.
- **Press `B` for a test run**, about three minutes. The game asks for specific picks, shakes and head movements, so every trial labels itself. It also compares settings by switching between them, in the order A B B A. Point at ✕ Leave and nod to stop early.
- **`bun run benchmark`** scores test runs: hits, wrong targets, misses and false gestures, by layout and by setting.
- **`bun run tune`** searches detector and hitbox settings using test runs. It tunes on half the trials and only recommends a change that also wins on the other half.
- **`bun run gate`** fails if anything got worse than `scripts/baseline.json`. `bun run gate --update` accepts the current results.
- **`bun run replay --sweep`** tries a range of detector settings against the same labels. Prefer a value in the middle of a wide range over the single best score, because a few games are easy to overfit.

After a session, add what the player meant to do to `scripts/labels.json`, so that mistake stays covered by `bun run replay` from then on. Recordings stay in `.recordings`, which is not committed, and `bun run replay` skips any that aren't there.

