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

To deploy:

```sh
bun run deploy
```

That type-checks and builds the app first, so nothing remote changes if either fails. Then it applies any new D1 migrations, deploys the rooms worker to `noddle-rooms.sampacker.com`, and deploys the app to `noddle.sampacker.com`. In Cloudflare Workers Builds, connect the repo to the `noddle` Worker, leave the build command empty and set the deploy command to `bun run deploy`. Turn off builds for non-production branches, or they'll fail looking for a build that never ran.

`PUBLIC_ROOMS_URL` is fixed at build time and comes from `.env.production`. `vite dev` leaves it unset and uses port 8787 on the same machine.

## Development

```sh
bun install          # also generates worker-configuration.d.ts
bun run dev          # the app alone
bun run check        # regenerates the worker types, then type-checks everything, scripts included
bun run db:generate  # a new migration after changing src/lib/server/db/schema.ts; deploy applies it
bun run update:model # fetch Google's latest face landmarker model
```

`worker-configuration.d.ts` isn't committed. `bun install` and `bun run check` regenerate it, so you never need to run `wrangler types` yourself. Migrations are only ever applied by `wrangler d1 migrations apply`, never by drizzle-kit, so the two can't disagree about what has run. MediaPipe's runtime comes straight from the installed package, so `bun update` updates it too.

## Code layout

- `src/lib/games`: rules engines and bots. Pure and seeded.
- `src/lib/session`: the Game Session the screens talk to, with demo, local and remote versions. Screens don't know which they have.
- `src/lib/stages`: the screens.
- `src/lib/vision`, `src/lib/input`: head tracking and targets. Run `bun run gate` after changing these, and try it on a real head.

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

