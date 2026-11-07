# Gaze Games: Design Spec

Uno and Scrabble played with eyes and head, in the browser, on a MacBook webcam. Built for a hackathon judging session, then deployed as a portfolio piece.

**Deadline:** Sunday 2026-11-08, 8:30 am. About one full day of development.

## 1. Goals

### Success at judging

Two judges stand at a table in front of a fully opened MacBook. One takes control with a nod. That judge learns the controls, wins their way through a scripted Uno hand, then places a word on a Scrabble board using only eyes and head. The whole run takes about 5 minutes and can be reset with one key.

### Modes (all three ship)

| Mode | Description |
|---|---|
| **Demo** | Scripted and reproducible. Fresh state on every open, no saved calibration. Designed to be easy on purpose, like "typewriter" on a keyboard's top row. |
| **Single player** | Full, unscripted Uno or Scrabble against a bot. |
| **Multiplayer** | Full Uno or Scrabble against other people, over Cloudflare. |

The demo is the full build stripped down. It uses the same rules engines, tracking and UI as the other modes, plus a script.

Keyboard and mouse work in every mode.

### Non-goals

- Retraining models (see 5.7)
- Accounts, profiles, matchmaking, chat, spectators
- Saved calibration between sessions
- Mobile support, or any browser other than desktop Chrome
- Hand tracking

## 2. Constraints

- All vision runs locally in the browser. Video never leaves the device.
- Model and runtime downloads stay under 50 MB.
- All assets are self-hosted, with no runtime CDN fetches, so the demo can run without internet.
- Stack: SvelteKit, Svelte 5 runes, TypeScript, Tailwind, Cloudflare Workers, Durable Objects, D1, Drizzle, bun.
- No new test framework. Pure logic uses `bun test`.

### The judging setup

These conditions drive the vision design:

- Judges stand, look down, and are about 1 m from the camera instead of the usual 50–60 cm.
- The lid is fully open, so the camera points upward.
- Two faces may be in frame. Only one may control the game.
- Assumed screen: 14-inch MacBook, about 30 cm wide. This is a single config value, set in `/lab`.

## 3. Architecture

```
Browser
  Camera (1080p)
     │ frames
     ▼
  Vision worker ── MediaPipe (shared, up to 3 faces)
     │                 │
     │            FaceLock ──► locked face only
     │                 │
     │     ┌───────────┼─────────────┬──────────────┐
     │     ▼           ▼             ▼              ▼
     │  PoseGate   HeadGestures   FreeGaze     HeadPointer
     │  (bounds)   (nod/shake)    (ONNX)       (fallback)
     │                 │             │              │
     │                 │    Calibrated worker       │
     │                 │    (WebEyeTrack fork)      │
     ▼                 ▼             ▼              ▼
  InputController ◄─ gestures ◄─ active GazeSource ─┘
     ▲     ▲
 mouse   keyboard
     │
     ▼
  TargetRegistry ─► focused target / confirm / cancel
     │
     ▼
  Game UI (Uno, Scrabble) ─► actions ─► Game Session
                                          ├─ local engine + bot   (single player)
                                          ├─ local engine + script (demo)
                                          └─ WebSocket             (multiplayer)
                                                 │
Cloudflare                                       ▼
  SvelteKit app (static assets)     Rooms worker ─ Durable Object per room
                                                 └─ D1 (finished games)
```

### Layout

```
src/lib/vision/        camera, face lock, pose gate, gestures, gaze sources, calibration, workers
src/lib/input/         InputController, TargetRegistry, mouse and keyboard adapters
src/lib/games/uno/     pure rules engine, bot
src/lib/games/scrabble/ pure rules engine, move generator, bot, dictionary loader
src/lib/session/       Game Session interface and its local, demo and remote implementations
src/lib/demo/          demo scripts and director
src/lib/components/    shared Svelte UI
src/routes/            /  /demo  /play/uno  /play/scrabble  /room/[code]  /lab
workers/rooms/         Durable Object worker and its wrangler config
vendor/webeyetrack/    fork, pinned to upstream commit 75fbd2f5, MIT licence retained
static/models/         model files
static/runtime/        ONNX Runtime and MediaPipe WASM
static/dict/           ENABLE word list
```

### Unit boundaries

- **Rules engines** have no browser or Svelte dependency. Each is a pure reducer: `apply(state, action) → state`, with `legalActions(state)` and a seeded RNG. Client, bot, demo script and Durable Object all import the same code.
- **Vision** exposes signals only: focused gaze point, gesture events, lock status, pose status. It knows nothing about games.
- **Input** turns signals into `focus(target)`, `confirm()` and `cancel()`. Games only see these, so mouse, keyboard and gaze are interchangeable.
- **Game Session** is the only thing UI talks to for game state. UI does not know which mode it is in.

## 4. Vision models

| Role | Model | Runtime | Size | Licence |
|---|---|---|---|---|
| Face, landmarks, head pose | MediaPipe Face Landmarker float16 | MediaPipe WASM | 3.76 MB | Apache-2.0 |
| Calibration-free gaze, candidate 1 | MobileGaze MobileOne S0 | ONNX Runtime Web | 4.97 MB | Code MIT, weights unstated, trained on Gaze360 |
| Calibration-free gaze, candidate 2 | OpenVINO `gaze-estimation-adas-0002` | ONNX Runtime Web | 7.55 MB | Apache-2.0 |
| Calibrated gaze | WebEyeTrack BlazeGaze | TensorFlow.js in the fork | 0.67 MB | MIT |

`/lab` measures both calibration-free candidates, and only the winner ships.

**Measured download with MobileOne:** 35.91 MB raw, about 15.4 MB brotli, covering MediaPipe model and runtime (0.10.3), MobileOne, BlazeGaze, the WebEyeTrack bundle with TensorFlow.js, and ONNX Runtime WASM with loaders. App code is not included. Exactly one MediaPipe runtime ships, because a second one would push the total past 50 MB. Re-measure if the shared runtime uses a different version.

**Backend:** ONNX Runtime WASM. WebGPU would bring the total to 49.86 MB and leave almost no margin, so it is only considered if `/lab` shows WASM misses the frame-rate target.

## 5. Vision design

### 5.1 Pipeline

1. Camera opens at 1920×1080. At 1 m this gives roughly 20 px across the iris, against about 7 px at 640×480.
2. Vision worker runs MediaPipe with `numFaces: 3`. MediaPipe only smooths with one face enabled, so smoothing is ours (One Euro filter).
3. FaceLock selects the locked face. Nothing downstream sees any other face.
4. Head pose comes from MediaPipe's facial transformation matrix.
5. The active and background gaze sources run on the locked face.

The calibrated model runs in its own worker because each adaptation step blocks inference there and drops frames. If MediaPipe fails in a module worker, the vision worker becomes a classic worker.

### 5.2 PoseGate

A "stand here" screen shows a mirrored live preview with an outline. It passes when face width is within the expected range and head angle is within range for 1 second.

Starting values, tuned in `/lab`: face width 9–25% of frame width, head pitch and yaw within ±35°.

During play, if the locked face is out of bounds for more than 1.5 seconds, the game pauses with the same guide and resumes automatically. A tape mark on the floor is part of the physical setup.

### 5.3 FaceLock

```
Searching ─ face in bounds ─► Candidates ─ first completed nod ─► Locked
Locked ─ no match for 1.5 s ─► Lost (game paused) ─ nod ─► Locked
Presenter handoff key ─► Candidates (calibration reset)
```

- Frame-to-frame matching uses face centre distance and size ratio, with a gate so that a jump to another person fails the match instead of switching.
- There is no face recognition. Reclaiming after a loss is done by nodding again. An embedding model would only be added if `/lab` shows the tracker swapping people, and only if it fits the size budget.
- A small corner preview always shows a ring on the controlling face.

### 5.4 HeadGestures

- **Nod (confirm):** head pitch goes down and back up, 6° or more, within 150–700 ms.
- **Shake (cancel):** head yaw makes 2 or more reversals, 6° or more, within 900 ms.
- A 500 ms refractory period follows each gesture.
- **Selection freeze:** gaze moves during a nod, so the input layer keeps a 300 ms history of focus. On confirm it uses the focused target from just before gesture onset.
- Thresholds are tuned in `/lab`. Tests replay recorded pose traces.

### 5.5 Gaze sources

All implement one interface:

```ts
interface GazeSource {
	readonly id: 'free' | 'calibrated' | 'head';
	onFrame(frame: LockedFaceFrame): void;
	latest(): GazeEstimate | null; // screen point, confidence, timestamp
	reset(): void;
}
```

- **FreeGaze:** the calibration-free model. Its yaw and pitch are projected as a ray from the eye position onto the screen plane, using distance estimated from iris size and the configured screen size. A simple running bias offset from known-target samples is applied, because a large share of its error is expected to be per-person bias.
- **CalibratedGaze:** the WebEyeTrack fork (5.6). Runs from the first locked frame, and is invisible until it takes over.
- **HeadPointer:** maps head yaw and pitch to the screen, fitted from the same samples. It is the guaranteed fallback if gaze fails in `/lab` or for a particular judge, and can also blend in for fine adjustment while zoomed.

### 5.6 WebEyeTrack fork

Weights are unchanged. Required source changes:

1. Add an entry point that takes screen target samples directly, with no click listener. Pair each with a buffered result from the correct moment.
2. Raise the fixed sample buffer (`maxPoints=5`). Keep samples spatially spread instead of most recent.
3. Remove its private FaceLandmarker (`numFaces: 1`). Accept shared landmarks of the locked face.
4. Use real camera dimensions instead of the 640×480 request. Set intrinsics and the starting distance for the judging setup instead of the hard-coded 60° VFOV and z0=60 cm. Clamp the per-frame depth refinement.
5. Treat eye-closed readings (EAR below 0.2) as "no reading" instead of `[0,0]`, and tune the threshold, because looking down lowers the eyelids.
6. Add `reset()` that clears calibration data and face width.
7. Load all files locally instead of from jsDelivr and Google Cloud Storage.
8. Replace the webpack-only worker setup with a Vite-compatible one.

Use the repository at the pinned commit. npm 0.0.2 lacks later fixes.

### 5.7 Retraining policy

No retraining is planned. On-device adaptation inside the browser is not retraining.

Retraining on the 5090 is only justified if all of these are true after `/lab`:

- Calibrated error exceeds 8 cm for at least 2 people at the judging position.
- Tuning the fork and the pose gate has not fixed it.
- HeadPointer cannot carry the demo.
- A specific dataset and a run under 6 hours have been identified.

### 5.8 Secret calibration

Samples are only taken when the true target is known, so a wrong uncalibrated selection cannot teach the model the wrong thing.

A sample is `(frame features, target centre, timestamp)`, taken during a stable fixation in the 500 ms before a gesture begins:

- **Scripted targets:** in the instructions and scripted Uno, the UI directs the player to a specific target.
- **Unscripted play:** a confirmed selection counts only if the raw gaze was stable and within 2× the current estimated error of the target.

Coverage is designed in, because a hand of cards only teaches the bottom of the screen:

| Where | Reason |
|---|---|
| Instruction cards at corners and centre | Direct 5-point coverage |
| Opponents left, top and right | Top and sides |
| Draw pile and discard in the centre | Centre |
| Wild color picker in the four corners | Corners, late in the sequence |
| Player's hand | Bottom edge |

Every fourth sample per screen region is held out from training for measurement. All calibration data is held in memory only and is gone on reload.

### 5.9 Handover

At the start of Scrabble, or in unscripted play once there are 8 or more well-spread samples:

- Compute median held-out error for each source, in cm.
- The source with the lowest error becomes active. In normal cases that is CalibratedGaze.
- There is no visible calibration step. The measured error also sets the Scrabble zoom level (7.3).

### 5.10 Target selection

`TargetRegistry` holds on-screen targets and whether each is currently legal. Gaze snaps to the nearest **legal** target.

- A switch needs the new target to be 1.3× closer for 150 ms.
- With no reading, focus holds for 1 second, then clears.
- Mouse hover and arrow keys drive the same focus.

## 6. Game engines

### 6.1 Uno

Standard 108-card deck, 2–4 players, 7 cards each. First discard is redrawn until it is a number card.

House rules, chosen for simplicity:

- No stacking and no jump-ins.
- Wild Draw Four can be played at any time, with no challenge.
- A player who draws one card may play it if legal, otherwise the turn passes.
- "UNO!" is called automatically.
- With 2 players, Reverse acts as Skip.
- The discard pile reshuffles when the deck runs out.
- A game ends when a hand is empty. No points or multiple rounds.

**Bot:** picks a legal card, favouring its most common color, action cards when the next player has 2 or fewer cards, and wilds last.

### 6.2 Scrabble

Standard 15×15 board with premium squares, 100-tile bag including 2 blanks, 7-tile rack, 50-point bingo bonus.

- Invalid plays are rejected at submit with no penalty. There are no challenges.
- Pass, and exchange when 7 or more tiles remain in the bag.
- Ends when the bag is empty and a rack is empty, or after 6 consecutive scoreless turns. Standard rack adjustment applies.
- **Dictionary:** ENABLE, public domain, about 173k words, loaded on demand from `static/dict/`.

**Bot:** Appel–Jacobson move generation over a trie, picking at random from its top 3 moves so it can be beaten. Runs in a web worker so it never stalls gaze.

## 7. Interaction

### 7.1 Controls everywhere

| Action | Gaze and head | Keyboard | Mouse |
|---|---|---|---|
| Focus | Look | Arrows | Hover |
| Confirm | Nod | Enter | Click |
| Cancel or back | Shake | Esc | Right click |

### 7.2 Uno

Look at a legal card or the draw pile, then nod. Wild cards open the corner color picker: look at a color and nod, or shake to return.

### 7.3 Scrabble

```
Idle ─ look at tile + nod ─► TileHeld ─ look at board + nod ─► Zoomed ─ look at square + nod ─► Placed
```

- **Shake** goes back one stage. From Idle, it recalls the last placed tile.
- **Zoom:** the board magnifies around the gaze point so a square is at least twice the current error. Squares shown = `clamp(floor(boardCm / (2 × errorCm)), 3, 7)`. The zoom re-centres if the player looks at an edge.
- **Line constraint:** after the first placed tile, only squares in the same row or column and connected to the play are legal. This also speeds up later tiles.
- Play, Pass and Exchange are large targets beside the board.
- A blank opens a two-step letter picker: first a group of letters, then the letter.

## 8. Demo script

Each stage is one Director step. All randomness is removed. Total about 5 minutes.

| # | Stage | What happens | Why |
|---|---|---|---|
| 0 | Load | Preload all models and start the camera behind a title screen | No loading during play |
| 1 | Stand here | PoseGate guide | Gets both judges into bounds |
| 2 | Take control | "Nod to take control" | Locks one judge, teaches nod |
| 3 | Learn | Five cards at corners and centre light up in turn: look, nod to flip. A sixth asks them to shake to put it back | Teaches controls, first calibration samples |
| 4 | Uno | 4 players, 7 cards, 6 player turns, about 2 minutes | Feels like winning, broad calibration coverage |
| 5 | UNO! | Player reaches 1 card, opponents still hold 5 or more. "One card from winning. Ready for something harder?" | Clean exit without a full game |
| 6 | Scrabble | Handover and fixed board | Calibrated model takes over silently |
| 7 | Finish | Score fanfare, restart prompt. If time allows, a reveal showing measured error in Uno against Scrabble | Ends on a clear result |

### Uno script

- Each turn has 2–3 legal cards positioned far apart in the hand, plus the draw pile. This is what makes a 22 cm uncalibrated error usable.
- **Every route works.** Whichever legal card the player chooses, opponents' next plays are selected so that the next turn is still set up correctly. Script data is a tree, one branch per legal choice.
- One turn deliberately plays a Wild to trigger the corner color picker.
- Between player turns, the active opponent is highlighted to pull the eyes across the screen.
- The script uses the real Uno engine with a rigged deck and hands.

### Scrabble script

- The computer opens with `BOARD` across the centre, with the `A` on the centre square.
- The rack holds `G`, `M`, `E` plus four non-distracting tiles, shuffled so the word is almost visible.
- The obvious play is `GAME`, down through the `A`, placing three tiles.
- Any valid play is accepted and uses real rules and scoring. Only squares that can form a valid play from this rack are legal targets.

A test verifies that `BOARD` and `GAME` are in ENABLE, and checks the score and that the rack offers no more tempting play. If it fails, words are swapped.

### Presenter controls

| Key | Action |
|---|---|
| `R` | Reset the demo to stage 0 |
| `H` | Hand control to the other judge and reset calibration |
| `N` | Skip the current scripted step |
| `D` | Toggle debug overlay: gaze dot, active source, error, lock state |

## 9. Multiplayer

### Topology

The browser connects directly to a separate **rooms worker** by URL (`PUBLIC_ROOMS_URL`). The adapter does not export Durable Objects and `vite dev` cannot run them internally, so a separate worker avoids patching build output. It also keeps WebSocket upgrades out of SvelteKit routing. The SvelteKit app needs no server code for gameplay.

Locally: `bun run dev:all` runs Vite and `wrangler dev` for rooms, with local D1 storage.

### Rooms

- `POST /rooms` creates a room and returns a 5-character code. `GET /rooms/:code/ws` connects.
- Each room is one Durable Object using the hibernatable WebSocket API. It is authoritative and runs the shared engine.
- Seats: Uno 2–4, with bots filling empty seats when the host starts. Scrabble 2.
- A seat token in `localStorage` allows reconnection. If someone drops, the game waits. Bots do not take over a human's seat.
- An alarm deletes a room after 2 hours idle.

### Protocol

```
client → { type: 'join', code, token?, name }
client → { type: 'start' }
client → { type: 'action', action, seq }
server → { type: 'state', view, seq }      // per-seat view, hides other hands and racks
server → { type: 'rejected', reason, seq }
server → { type: 'presence', seats }
```

Only game actions cross the socket. Vision data never does.

### Storage

- Live room state: Durable Object storage.
- D1 table `game_result`: id, game, player count, winner seat, ended at. This replaces the template `task` table.

## 10. Failure handling

| Failure | Behaviour |
|---|---|
| Camera denied or missing | Clear message, game playable with keyboard and mouse |
| Model fails to load | Falls back in order: calibrated, free, head, keyboard and mouse. Shown only in the debug overlay |
| Frame rate falls below 10 fps | Skip background model inference first, keeping the active source |
| Face lost or out of bounds | Pause with guide (5.2, 5.3) |
| Calibration worse than FreeGaze | Stay on FreeGaze with larger zoom (5.9) |
| Gaze failing for a judge during the demo | Presenter uses `D` to check, `H` to re-claim, or `N` to step past it. HeadPointer takes over if it has the lowest error |
| Socket drop | Automatic reconnect with backoff and seat token, with an offline banner |
| Rejected action | Client reverts to server state |

## 11. Testing

**Automated (`bun test`):**

- Uno and Scrabble rules, including scoring and end conditions
- Scrabble move generator results checked against the validator
- Demo route test: enumerates **every** path through the Uno script and asserts each reaches stage 5
- Demo Scrabble fixture test
- Gesture detection against recorded pose traces
- FaceLock against synthetic two-face tracks, including crossing paths
- Room reducer: seat views never leak hidden cards or tiles

**`/lab` test page (the first thing built):** tests on the real MacBook at the real position, with a second person in frame. Runs a target sequence and reports per-source error, nod and shake accuracy, lock stability and frame rate.

**Gate before game UI work depends on the numbers:**

| Measure | Target |
|---|---|
| Free source picks the right one of 3 far-apart targets | 90% or more |
| Calibrated median error at 1 m | 6 cm or less |
| Nods detected | 90% or more |
| False gestures | At most 1 per 5 minutes |
| Lock held for 2 minutes with a second person moving | No swaps |
| Pipeline rate with all models | 15 fps or more |

Missing the calibrated target does not stop the build. The zoom gets larger. If gaze misses both gaze targets, HeadPointer becomes the primary pointer, blended with whatever gaze signal is usable.

**Rehearsal:** at least 5 full runs with two people, including someone wearing glasses, plus a browser and multiplayer test on the deployed URL.

## 12. Build order

Hours are from the start of implementation. Tracks marked ∥ can run in parallel.

| Hours | Milestone |
|---|---|
| 0–6 | **`/lab` and vision core:** camera, MediaPipe, FaceLock, gestures, gaze sources, fork. Ends at the gate above |
| 0–6 ∥ | **Rules engines:** Uno, Scrabble, dictionary, tests |
| 6–12 | **Input layer, Uno UI, demo stages 0–5** |
| 12–18 | **Scrabble UI with zoom, demo stages 6–7, secret calibration and handover** |
| 18–21 | **Single player:** both bots, menus |
| 18–23 ∥ | **Multiplayer:** rooms worker, D1, room UI |
| 23–25 | **Deploy to Cloudflare, full rehearsal** |
| After | **Feature freeze.** Fixes only until Sunday morning |

If time runs short, cut in this order. Scope stays all three modes, with each one thinner:

1. The error reveal on the finish screen
2. Scrabble blank picker and exchange by gaze (keyboard and mouse only)
3. Uno multiplayer with more than 2 human seats
4. Scrabble bot variety (always plays its top move)

The demo itself is never cut.

## 13. Deployment and risks

**Deployment:** two Cloudflare workers (app and rooms) and one D1 database. Static assets stay under Cloudflare's per-file limit using the WASM backend, which is to be confirmed at first deploy. Threaded WASM needs cross-origin isolation headers, set through the assets `_headers` file. If that causes problems, single-threaded WASM is the fallback, subject to the frame-rate target.

**Known risks:**

| Risk | Response |
|---|---|
| Published accuracy comes from about 60 cm, not 1 m standing | `/lab` gate, adaptive zoom, HeadPointer |
| WebEyeTrack has few users and no independent accuracy reports | Interface allows replacement. Fallbacks are in place |
| Fork work takes longer than planned | Isolated in `vendor/` and CalibratedGaze. FreeGaze plus bias and affine fitting can stand in |
| ONNX Runtime and TensorFlow.js interaction is untested | They run in separate workers |
| Glasses and venue lighting | Rehearsal with glasses, debug overlay, HeadPointer |

**Licences and names, before any public launch:**

- MobileOne's weights derive from Gaze360, which is research-only and excludes commercial use of models trained on it. If MobileOne wins in `/lab`, this needs a legal read before any commercial release.
- "Uno" and "Scrabble" are third-party trademarks. Display names live in one constant, and all card and board art is original, so both can be renamed before a public link is shared.
- WebEyeTrack's MIT licence and attribution stay in `vendor/`.
