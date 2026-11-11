import { FaceLandmarker } from '@mediapipe/tasks-vision';
// The runtime comes from the installed package, so it always matches the JS that loads it.
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import { session } from '../session';
import { HeadGestures, type Gesture, type NodStyle } from './gestures';
import {
	faceBox,
	headAngles,
	irisAngles,
	irisPx,
	median,
	medianPoint,
	mouthOpen,
	OneEuro,
	OneEuro2D,
	type FaceBox,
	type IrisReading,
	type Lm,
	type Point
} from './math';

export type LockState = 'searching' | 'locked' | 'lost';

/** Physical setup. Values can be changed live from the HUD. */
export const setup = $state({
	screenWidthCm: 30.4,
	cameraHfovDeg: 65,
	irisCm: 1.17,
	/** Head turn from rest that reaches the edge of the screen, in degrees. */
	headRangeYawDeg: 12,
	/** Looking up has room to spare, but looking down strains the neck, so down needs less. */
	headRangePitchDeg: 11,
	headRangeDownDeg: 5,
	/** Where a resting head points, as a fraction of screen height. Below centre is more comfortable. */
	headRestY: 0.6,
	/** Swaps left and right, if a setup ever needs it. */
	headFlipX: false,
	/** Head movement smaller than this leaves the pointer exactly where it is. */
	headDeadbandDeg: 0.6,
	minFaceWidth: 0.06,
	maxFaceWidth: 0.4,
	maxPoseDeg: 40,
	lostAfterMs: 1500,
	/** Part of the frame given to face detection. Smaller zooms in, so faces can be further away. */
	cropScale: 0.75,
	/** Moves that area up (negative) or down (positive), as a fraction of frame height. */
	cropOffsetY: 0
});

type Track = {
	id: number;
	box: FaceBox;
	lastSeen: number;
	gestures: HeadGestures;
	inBounds: boolean;
};

export type DataFrame = {
	video: HTMLVideoElement;
	lm: Lm[];
	matrix: ArrayLike<number>;
	W: number;
	H: number;
	ts: number;
	/** When the camera actually took this frame, if the browser reports it. */
	captureTime?: number;
	presentedFrames?: number;
	yaw: number;
	pitch: number;
	distance: number;
	/** Eyelid gap as a share of eye width, the same as iris.open. */
	ear: number;
	iris: IrisReading;
};

/** The head signal is median filtered over this long before smoothing, to drop single bad frames. */
const HEAD_MEDIAN_MS = 100;
/** Keep holding the selection briefly after a gesture, while the head returns to rest. */
const HOLD_AFTER_GESTURE_MS = 400;
/** Taking control is a clear nod, because anyone in view could trigger it by accident. */
const LOCK_NOD_DEG = 3.5;
/** Someone else only becomes the player once they're clearly more in front, so it doesn't flicker. */
const PLAYER_SWITCH_RATIO = 1.25;
/** After a handoff, the last player's nods are still finishing, and mustn't take control back. */
const HANDOFF_QUIET_MS = 1500;
/** How near the player's last place a face must be, in face widths, to count as the player. */
const SEAT_FACE_WIDTHS = 1.5;
/**
 * After losing the player, only someone where they were can take control. If nobody has been there
 * for this long, they've moved or gone, so whoever is in front of the screen can nod to take over.
 */
const LOST_GIVE_UP_MS = 5000;
/** No camera frame for this long means the camera or face tracking has stopped. */
const STALL_MS = 3000;
/** How often to check that frames are still arriving. */
const WATCHDOG_MS = 1000;
/** Restarts are spaced out, and after this many in a row fail, it gives up. */
const RESTART_GAP_MS = 4000;
const MAX_RESTARTS = 3;
/** Frames flowing this long after a restart means it worked, so the count starts again. */
const RESTART_OK_MS = 10000;

/**
 * How much a face looks like the player: the one sitting at the laptop is the biggest in the
 * picture and near the middle. Someone beside them, or behind them, scores lower.
 */
function playerScore(box: FaceBox) {
	return box.w * (1 - Math.min(1, Math.abs(box.cx - 0.5) * 1.2));
}

function nearSeat(box: FaceBox, seat: FaceBox) {
	return Math.hypot(box.cx - seat.cx, box.cy - seat.cy) < seat.w * SEAT_FACE_WIDTHS;
}

function clampToViewport(p: Point): Point {
	return {
		x: Math.max(0, Math.min(window.innerWidth, p.x)),
		y: Math.max(0, Math.min(window.innerHeight, p.y))
	};
}

function pxPerCm() {
	return screen.width / setup.screenWidthCm;
}

function messageOf(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

class VisionEngine {
	// Reactive status for the UI
	status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	loadMessage = $state('');
	/** What went wrong with the camera or tracking mid-session, for the screen. Empty when all is well. */
	problem = $state('');
	errors = $state<string[]>([]);
	resolution = $state('');
	fps = $state(0);
	mediapipeMs = $state(0);
	faceCount = $state(0);
	faces = $state<{ id: number; box: FaceBox; locked: boolean; inBounds: boolean; player: boolean }[]>([]);
	lock = $state<LockState>('searching');
	yaw = $state(0);
	pitch = $state(0);
	/** From the iris size, so for display and logs only. */
	distanceCm = $state(0);
	faceWidth = $state(0);
	inBounds = $state(false);
	lastGesture = $state('');
	/** Where the head points this frame, smoothed, even while the pointer is held through a nod. */
	headPoint = $state<Point | null>(null);
	/** Median distance from a confirmed target's centre to where the head pointed, over recent picks. */
	headErrorCm = $state<number | null>(null);
	sampleCount = $state(0);
	/** Where the player is pointing. Always live, and what the screen shows. */
	pointer = $state<Point | null>(null);
	/** A nod may be under way, so the selection keeps what it had. The pointer keeps moving. */
	selectionHeld = $state(false);
	/** How this player nods, learned as they play. */
	nodStyle = $state<NodStyle | null>(null);
	/** How far through a nod the player is, from 0 to 1. Lets the selected thing dip with the head. */
	nodProgress = $state(0);
	/** Lip gap of the player, and whether they're talking, which asks for a firmer nod. */
	mouth = $state(0);
	talking = $state(false);

	// Callbacks
	onGesture: ((g: Gesture) => void) | null = null;
	onLocked: (() => void) | null = null;
	onFrame: ((p: Point | null, t: number) => void) | null = null;
	/** Gets each locked-face frame, for collecting training data. */
	dataTap: ((frame: DataFrame) => void) | null = null;

	// Internals
	private video: HTMLVideoElement | null = null;
	private stream: MediaStream | null = null;
	private landmarker: FaceLandmarker | null = null;
	private tracks: Track[] = [];
	private nextTrackId = 1;
	private lockedId: number | null = null;
	private lockedLastSeen = 0;
	/** The only face that can take control: the person in front of the screen. */
	private playerId: number | null = null;
	private lockQuietUntil = 0;
	/** While lost, when someone was last seen where the player had been. */
	private lostSeatSeenAt = 0;
	private lastTs = -1;
	private fpsWindow: number[] = [];
	private previews = new Set<HTMLCanvasElement>();
	private frameMeta: VideoFrameCallbackMetadata | null = null;
	private detectCanvas = document.createElement('canvas');
	private detectCtx = this.detectCanvas.getContext('2d', { alpha: false })!;

	/** When a frame was last tracked, on the performance.now() clock. */
	private lastFrameAt = 0;
	private bootedAt = 0;
	private restarts = 0;
	private restartTimer: ReturnType<typeof setTimeout> | undefined;

	private headRecent: { t: number; p: Point }[] = [];
	private headFilter = new OneEuro2D(1.2, 0.01);
	/** What the player saw: the smoothed head point, kept on screen. Not held through nods. */
	private history: { t: number; p: Point }[] = [];
	private holdUntil = 0;
	private headErrors: number[] = [];

	// Calibration state, in memory only
	private headNeutral: { yaw: number; pitch: number } | null = null;
	private heldYaw: number | null = null;
	private heldPitch: number | null = null;
	private headSmoothYaw = new OneEuro(1.5, 0.02);
	private headSmoothPitch = new OneEuro(1.5, 0.02);
	private recording: Record<string, unknown>[] | null = null;
	private headNeutralAfter = 0;
	private lastLockedBox: FaceBox | null = null;

	async start() {
		if (this.status !== 'idle') return;
		setInterval(this.watchdog, WATCHDOG_MS);
		await this.boot();
	}

	/** Opens the camera and face tracking, replacing any that were running. */
	private async boot() {
		this.teardown();
		this.status = 'loading';
		try {
			this.loadMessage = 'Starting camera';
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: false,
				video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
			});
			this.stream = stream;
			// Unplugged, or taken by the system. Stopping it ourselves doesn't fire this.
			stream.getVideoTracks()[0]?.addEventListener('ended', () => {
				if (this.stream === stream) this.stopped('The camera was disconnected');
			});
			const video = document.createElement('video');
			video.playsInline = true;
			video.muted = true;
			video.srcObject = stream;
			await video.play();
			this.video = video;
			this.resolution = `${video.videoWidth}×${video.videoHeight}`;

			this.loadMessage = 'Loading face tracking';
			this.landmarker = await FaceLandmarker.createFromOptions({ wasmLoaderPath, wasmBinaryPath }, {
				baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'GPU' },
				runningMode: 'VIDEO',
				numFaces: 3,
				outputFacialTransformationMatrixes: true,
				outputFaceBlendshapes: false
			});

			this.status = 'ready';
			this.loadMessage = '';
			this.lastFrameAt = this.bootedAt = performance.now();
			video.requestVideoFrameCallback((now, meta) => this.tick(video, now, meta));
		} catch (err) {
			this.errors.push(messageOf(err));
			// The first start failing is shown by the gate. A restart failing tries again.
			if (this.restarts === 0) this.status = 'error';
			else this.scheduleRestart();
		}
	}

	private teardown() {
		for (const t of this.stream?.getTracks() ?? []) t.stop();
		this.stream = null;
		if (this.video) this.video.srcObject = null;
		this.video = null;
		try {
			this.landmarker?.close();
		} catch {
			// A landmarker whose GPU context was lost can fail to close. It's dropped either way.
		}
		this.landmarker = null;
	}

	/** Frames have stopped coming. Lets go of the player, says so, and starts everything again. */
	private stopped(reason: string) {
		this.lastFrameAt = performance.now();
		if (this.status === 'error') return;
		if (this.lock === 'locked') this.loseLock(this.lastTs);
		this.pointer = null;
		this.headPoint = null;
		this.nodProgress = 0;
		this.selectionHeld = false;
		this.fps = 0;
		this.faces = [];
		this.faceCount = 0;
		this.problem = `${reason}. Starting it again…`;
		this.scheduleRestart();
	}

	private scheduleRestart() {
		if (this.restartTimer) return;
		if (this.restarts >= MAX_RESTARTS) {
			this.teardown();
			this.status = 'error';
			this.problem = 'Face tracking stopped. Reload the page to start it again.';
			return;
		}
		this.restarts += 1;
		this.restartTimer = setTimeout(
			() => {
				this.restartTimer = undefined;
				this.boot();
			},
			this.restarts === 1 ? 300 : RESTART_GAP_MS
		);
	}

	/** Notices a camera that has gone quiet: muted, asleep, or a stalled tracker. */
	private watchdog = () => {
		const now = performance.now();
		// Hidden pages get no frames, which is fine. The wait starts again once it's back.
		if (document.hidden || this.status !== 'ready') {
			this.lastFrameAt = now;
			return;
		}
		if (now - this.lastFrameAt > STALL_MS) this.stopped('The camera stopped');
	};

	addPreview(c: HTMLCanvasElement) {
		this.previews.add(c);
		return () => this.previews.delete(c);
	}

	private tick(video: HTMLVideoElement, now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) {
		// A restart replaced this camera, so this loop ends here.
		if (video !== this.video || !this.landmarker) return;
		this.frameMeta = metadata;
		const ts = Math.max(now, this.lastTs + 1);
		this.lastTs = ts;

		const W = video.videoWidth;
		const H = video.videoHeight;
		const crop = this.cropRect(W, H);
		let result;
		try {
			if (this.detectCanvas.width !== crop.w || this.detectCanvas.height !== crop.h) {
				this.detectCanvas.width = crop.w;
				this.detectCanvas.height = crop.h;
			}
			this.detectCtx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
			const t0 = performance.now();
			result = this.landmarker.detectForVideo(this.detectCanvas, ts);
			this.mediapipeMs = performance.now() - t0;
		} catch (err) {
			// Usually the GPU going away, after sleep. This tracker won't recover, so start again.
			this.errors.push(`face tracking: ${messageOf(err)}`);
			this.stopped('Face tracking stopped');
			return;
		}
		video.requestVideoFrameCallback((n, m) => this.tick(video, n, m));
		this.lastFrameAt = performance.now();
		if (this.problem) this.problem = '';
		if (this.restarts && this.lastFrameAt - this.bootedAt > RESTART_OK_MS) this.restarts = 0;

		this.fpsWindow.push(now);
		while (this.fpsWindow.length && now - this.fpsWindow[0] > 1000) this.fpsWindow.shift();
		this.fps = this.fpsWindow.length;

		// Back to full-frame coordinates, which everything downstream uses.
		const lms: Lm[][] = (result.faceLandmarks ?? []).map((face) =>
			face.map((l) => ({
				x: (crop.x + l.x * crop.w) / W,
				y: (crop.y + l.y * crop.h) / H,
				z: l.z
			}))
		);
		const mats = result.facialTransformationMatrixes ?? [];
		this.faceCount = lms.length;

		const assigned = this.updateTracks(lms, ts);
		let lockedFace: { lm: Lm[]; matrix: (typeof mats)[number] } | null = null;

		const angles = assigned.map(([track, i]) => {
			const { yaw, pitch } = headAngles(mats[i].data);
			const mouth = mouthOpen(lms[i], W, H);
			track.inBounds =
				track.box.w >= setup.minFaceWidth &&
				track.box.w <= setup.maxFaceWidth &&
				Math.abs(yaw) <= setup.maxPoseDeg &&
				Math.abs(pitch) <= setup.maxPoseDeg;
			return { yaw, pitch, mouth };
		});
		this.choosePlayer(assigned.map(([track]) => track));

		for (const [n, [track, i]] of assigned.entries()) {
			const { yaw, pitch, mouth } = angles[n];
			const g = track.gestures.push(ts, yaw, pitch, mouth);
			const isLocked = this.lockedId === track.id;
			const turnedDown = track.gestures.rejected;
			if (turnedDown) {
				track.gestures.rejected = null;
				// Not 'rejected', which the games use for refused moves. The log stamps its own time.
				const { t, ...bump } = turnedDown;
				if (isLocked) session.event('bump-turned-down', { ...bump, at: t });
			}
			if (isLocked) {
				this.yaw = yaw;
				this.pitch = pitch;
				this.faceWidth = track.box.w;
				this.mouth = mouth;
				this.talking = track.gestures.talking;
				this.lastLockedBox = track.box;
				this.inBounds = track.inBounds;
				this.lockedLastSeen = ts;
				lockedFace = { lm: lms[i], matrix: mats[i] };
			}
			if (!g) continue;
			if (isLocked && this.lock === 'locked') {
				this.lastGesture = `${g.kind} ${Math.round(ts / 100) / 10}s`;
				const style = track.gestures.nodStyle;
				if (style !== this.nodStyle) {
					this.nodStyle = style;
					session.event('nod-style', { style });
				}
				this.holdUntil = ts + HOLD_AFTER_GESTURE_MS;
				this.recording?.push({ t: ts, gesture: g.kind, onset: g.onset, sizeDeg: g.sizeDeg });
				session.event('gesture', {
					kind: g.kind,
					at: ts,
					onset: g.onset,
					sizeDeg: Math.round(g.sizeDeg * 10) / 10,
					speed: Math.round(g.speed),
					talking: track.gestures.talking
				});
				this.onGesture?.(g);
			} else if (
				this.lock !== 'locked' &&
				g.kind === 'nod' &&
				g.sizeDeg >= LOCK_NOD_DEG &&
				track.id === this.playerId &&
				ts >= this.lockQuietUntil
			) {
				this.takeLock(track, ts);
				lockedFace = { lm: lms[i], matrix: mats[i] };
			}
		}

		if (this.lock === 'locked' && ts - this.lockedLastSeen > setup.lostAfterMs) this.loseLock(this.lockedLastSeen);
		if (this.lock === 'lost') this.giveUpWhenSeatEmpty(assigned.map(([track]) => track), ts);

		this.faces = this.tracks.map((t) => ({
			id: t.id,
			box: t.box,
			locked: t.id === this.lockedId,
			inBounds: t.inBounds,
			player: t.id === this.playerId
		}));

		let activePoint: Point | null = null;
		if (lockedFace) {
			this.processLocked(lockedFace.lm, lockedFace.matrix, W, H, ts);
			activePoint = this.updatePointer(ts);
		} else {
			this.pointer = null;
			this.headPoint = null;
			this.nodProgress = 0;
			this.selectionHeld = false;
		}
		this.onFrame?.(activePoint, ts);
		this.drawPreviews(video);
	}

	private loseLock(lastSeen: number) {
		this.lock = 'lost';
		this.lockedId = null;
		this.lostSeatSeenAt = lastSeen;
	}

	/**
	 * While someone sits where the player was, only they can take control, so a neighbour nodding
	 * along can't. Once nobody has been there for a while, the player has moved or left, and
	 * whoever is in front of the screen may nod to take over.
	 */
	private giveUpWhenSeatEmpty(seen: Track[], ts: number) {
		const seat = this.lastLockedBox;
		if (seat && seen.some((t) => nearSeat(t.box, seat))) this.lostSeatSeenAt = ts;
		else if (ts - this.lostSeatSeenAt > LOST_GIVE_UP_MS) {
			this.lock = 'searching';
			session.event('lock-searching', { after: Math.round(ts - this.lostSeatSeenAt) });
		}
	}

	private updatePointer(ts: number): Point | null {
		const live = this.headPoint;
		const gestures = this.tracks.find((t) => t.id === this.lockedId)?.gestures;
		this.nodProgress = gestures?.nodProgress ?? 0;
		this.selectionHeld = !!gestures?.nodInProgress || ts < this.holdUntil;
		// A nod swings the head far enough to throw the pointer across the screen. It is a click,
		// not aiming, so the pointer waits where it was until the head is back.
		if (!live) this.pointer = null;
		else if (!this.selectionHeld || !this.pointer) this.pointer = live;
		return this.pointer;
	}

	private cropRect(W: number, H: number) {
		const w = Math.round(W * setup.cropScale);
		const h = Math.round(H * setup.cropScale);
		const x = Math.round((W - w) / 2);
		const y = Math.round(Math.max(0, Math.min(H - h, (H - h) / 2 + setup.cropOffsetY * H)));
		return { x, y, w, h };
	}

	private updateTracks(lms: Lm[][], ts: number): [Track, number][] {
		const boxes = lms.map(faceBox);
		const assigned: [Track, number][] = [];
		const used = new Set<number>();

		// Locked track gets first pick, so it can never lose its face to a neighbour.
		const order = [...this.tracks].sort(
			(a, b) => Number(b.id === this.lockedId) - Number(a.id === this.lockedId)
		);
		for (const track of order) {
			let best = -1;
			let bestD = Infinity;
			boxes.forEach((box, i) => {
				if (used.has(i)) return;
				const d = Math.hypot(box.cx - track.box.cx, box.cy - track.box.cy);
				const ratio = box.w / (track.box.w || 1);
				// The locked face gets a tight gate, and never takes a face another
				// live track explains better. That keeps control from jumping to a neighbour.
				const isLocked = track.id === this.lockedId;
				const gate = track.box.w * (isLocked ? 0.5 : 1.1);
				if (d >= gate || ratio <= 0.6 || ratio >= 1.6 || d >= bestD) return;
				if (isLocked) {
					const other = this.tracks.some(
						(o) =>
							o.id !== track.id &&
							ts - o.lastSeen < 300 &&
							Math.hypot(box.cx - o.box.cx, box.cy - o.box.cy) < d
					);
					if (other) return;
				}
				bestD = d;
				best = i;
			});
			if (best >= 0) {
				used.add(best);
				track.box = boxes[best];
				track.lastSeen = ts;
				assigned.push([track, best]);
			}
		}
		boxes.forEach((box, i) => {
			if (used.has(i)) return;
			const track: Track = {
				id: this.nextTrackId++,
				box,
				lastSeen: ts,
				gestures: new HeadGestures(),
				inBounds: false
			};
			this.tracks.push(track);
			assigned.push([track, i]);
		});
		this.tracks = this.tracks.filter(
			(t) => ts - t.lastSeen < 1000 || t.id === this.lockedId
		);
		return assigned;
	}

	/**
	 * Picks who may take control, from the faces seen this frame. While someone is in control it's
	 * them. Otherwise it's whoever is most in front, and it only moves to someone else once they're
	 * clearly more so, so two people side by side don't swap back and forth.
	 */
	private choosePlayer(seen: Track[]) {
		const locked = this.lock === 'locked' && seen.find((t) => t.id === this.lockedId);
		if (locked) {
			this.playerId = locked.id;
			return;
		}
		// Mid-game, only someone where the player was can take back control, so a neighbour nodding
		// along can't. A handoff clears this, and so does nobody being there for a while, and then
		// the next person can sit anywhere.
		const seat = this.lock === 'searching' ? null : this.lastLockedBox;
		const eligible = seen.filter((t) => t.inBounds && (!seat || nearSeat(t.box, seat)));
		const best = eligible.reduce<Track | null>(
			(top, t) => (!top || playerScore(t.box) > playerScore(top.box) ? t : top),
			null
		);
		const current = eligible.find((t) => t.id === this.playerId);
		if (!current || !best) this.playerId = best?.id ?? null;
		else if (playerScore(best.box) > playerScore(current.box) * PLAYER_SWITCH_RATIO) this.playerId = best.id;
	}

	private takeLock(track: Track, ts: number) {
		// A different person taking over after a loss must not inherit calibration. After a
		// handoff there's no last place, and calibration was already reset.
		const previous = this.lastLockedBox;
		if (previous) {
			const d = Math.hypot(track.box.cx - previous.cx, track.box.cy - previous.cy);
			if (d > previous.w) this.resetCalibration();
		}
		this.lockedId = track.id;
		this.lockedLastSeen = ts;
		this.lock = 'locked';
		this.headNeutral = null;
		// The head is still finishing the nod, so wait before taking its resting position.
		this.headNeutralAfter = ts + 600;
		this.onLocked?.();
	}

	/** What the camera is really doing, including any resizing or effects. */
	videoSettings() {
		const stream = this.video?.srcObject as MediaStream | undefined;
		return stream?.getVideoTracks()[0]?.getSettings() ?? null;
	}

	/** Locks the first visible face without a nod, for keyboard start and for diagnosis. */
	lockFirst() {
		if (this.lock === 'locked') return;
		const track = this.tracks.find((t) => t.id === this.playerId) ?? this.tracks[0];
		if (track) this.takeLock(track, this.lastTs);
	}

	/** The current head position becomes the centre of the screen. */
	recenter() {
		this.headNeutral = null;
		this.headNeutralAfter = 0;
	}

	startRecording() {
		this.recording = [];
	}

	stopRecording() {
		const out = this.recording ?? [];
		this.recording = null;
		return out;
	}

	/** Presenter handoff: release the lock and forget all calibration. */
	release() {
		this.lockedId = null;
		this.lastLockedBox = null;
		this.playerId = null;
		this.lock = 'searching';
		this.lockQuietUntil = this.lastTs + HANDOFF_QUIET_MS;
		this.resetCalibration();
	}

	resetCalibration() {
		this.headNeutral = null;
		this.heldYaw = null;
		this.heldPitch = null;
		this.headSmoothYaw.reset();
		this.headSmoothPitch.reset();
		this.nodStyle = null;
		// Each face learns its own nod size and speed, which the next person mustn't inherit.
		for (const track of this.tracks) track.gestures = new HeadGestures();
		this.history = [];
		this.headRecent = [];
		this.holdUntil = 0;
		this.selectionHeld = false;
		this.nodProgress = 0;
		this.headErrors = [];
		this.headErrorCm = null;
		this.sampleCount = 0;
		this.headFilter.reset();
	}

	private processLocked(
		lm: Lm[],
		matrix: { data: ArrayLike<number> },
		W: number,
		H: number,
		ts: number
	) {
		const video = this.video!;

		// Distance from the iris size, for the HUD and logs. Nothing here steers the pointer.
		const fx = W / (2 * Math.tan(((setup.cameraHfovDeg / 2) * Math.PI) / 180));
		const iris = irisPx(lm, W, H);
		const Z = (fx * setup.irisCm) / Math.max(iris, 1);
		this.distanceCm = Z;
		// Where the eyes turn, recorded only, to compare eye movement between people. It must
		// never reach the pointer or the gestures, which follow the head alone.
		const eyes = irisAngles(lm, W, H, setup.irisCm);

		// Head pointer: rotation only. Iris position and size must stay out of this, because
		// they follow the eyes and would make the pointer move when the head has not.
		const { yaw, pitch } = headAngles(matrix.data);
		const smoothYaw = this.headSmoothYaw.filter(yaw, ts);
		const smoothPitch = this.headSmoothPitch.filter(pitch, ts);
		const drag = (held: number | null, value: number) => {
			if (held === null) return value;
			const delta = value - held;
			if (Math.abs(delta) <= setup.headDeadbandDeg) return held;
			return value - Math.sign(delta) * setup.headDeadbandDeg;
		};
		this.heldYaw = drag(this.heldYaw, smoothYaw);
		this.heldPitch = drag(this.heldPitch, smoothPitch);
		if (!this.headNeutral && ts >= this.headNeutralAfter) {
			this.headNeutral = { yaw: this.heldYaw, pitch: this.heldPitch };
		}
		const neutral = this.headNeutral ?? { yaw: this.heldYaw, pitch: this.heldPitch };
		const raw = {
			x:
				window.innerWidth / 2 -
				(setup.headFlipX ? -1 : 1) *
					((this.heldYaw - neutral.yaw) / setup.headRangeYawDeg) *
					(window.innerWidth / 2),
			y: this.headY(this.heldPitch - neutral.pitch)
		};

		if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) this.headRecent.push({ t: ts, p: raw });
		while (this.headRecent.length && ts - this.headRecent[0].t > HEAD_MEDIAN_MS) this.headRecent.shift();
		const m = medianPoint(this.headRecent.map((q) => q.p));
		// Smoothed, but not yet kept on screen, so the logs still show how far off it was.
		const aim = m ? this.headFilter.filter(m, ts) : null;
		this.headPoint = aim && clampToViewport(aim);

		this.dataTap?.({
			video,
			lm,
			matrix: matrix.data,
			W,
			H,
			ts,
			captureTime: this.frameMeta?.captureTime,
			presentedFrames: this.frameMeta?.presentedFrames,
			yaw,
			pitch,
			distance: Z,
			ear: eyes.open,
			iris: eyes
		});

		session.frame(
			ts,
			yaw,
			pitch,
			this.pointer?.x,
			this.pointer?.y,
			aim?.x,
			aim?.y,
			this.selectionHeld,
			eyes.x,
			eyes.y,
			eyes.open,
			this.mouth
		);

		// What the player saw, so a nod is judged against where the dot was, not where an
		// unsmoothed head pointed, which can be off the screen.
		if (this.headPoint) this.history.push({ t: ts, p: this.headPoint });
		while (this.history.length && ts - this.history[0].t > 2500) this.history.shift();

		if (this.recording) {
			const round = (v: number | undefined | null) => (v == null ? null : Math.round(v * 100) / 100);
			this.recording.push({
				t: round(ts),
				yaw: round(yaw),
				pitch: round(pitch),
				heldYaw: round(this.heldYaw),
				heldPitch: round(this.heldPitch),
				noseX: round(lm[1].x * W),
				noseY: round(lm[1].y * H),
				irisPx: round(iris),
				eyeX: round(eyes.x),
				eyeY: round(eyes.y),
				eyeOpen: round(eyes.open),
				distance: round(Z),
				headX: round(aim?.x),
				headY: round(aim?.y),
				pointerX: round(this.pointer?.x),
				pointerY: round(this.pointer?.y),
				held: this.selectionHeld
			});
		}
	}

	private headY(pitchFromRest: number) {
		const restY = window.innerHeight * setup.headRestY;
		return pitchFromRest >= 0
			? restY - (pitchFromRest / setup.headRangePitchDeg) * restY
			: restY + (-pitchFromRest / setup.headRangeDownDeg) * (window.innerHeight - restY);
	}

	private window(tFrom: number, tTo: number) {
		return this.history.filter((h) => h.t >= tFrom && h.t <= tTo).map((h) => h.p);
	}

	/** Where the head pointed around a moment, steadied over a short window. Used to freeze selection through a nod. */
	pointAt(t: number): Point | null {
		return medianPoint(this.window(t - 350, t - 40));
	}

	/** Where the pointer was at a moment, without averaging across movement. */
	pointerAt(t: number): Point | null {
		return this.history.findLast((h) => h.t <= t)?.p ?? null;
	}

	/** Where the head is pointing this frame, even while the pointer on screen is held through a nod. */
	pointerNow(): Point | null {
		return this.history[this.history.length - 1]?.p ?? null;
	}

	/** Where the head pointed over the last moments, for the accuracy test. */
	pointNear(msBack = 800): Point | null {
		return medianPoint(this.window(this.lastTs - msBack, this.lastTs));
	}

	/**
	 * A known target: the player was pointing at this point around time `onset`. Only measures how
	 * far off the head was, for the HUD. Nothing is trained from it.
	 */
	addSample(target: Point, onset: number) {
		if (this.lock !== 'locked') return;
		const pred = medianPoint(this.window(onset - 650, onset - 80));
		if (!pred) return;
		this.headErrors.push(Math.hypot(pred.x - target.x, pred.y - target.y) / pxPerCm());
		if (this.headErrors.length > 9) this.headErrors.shift();
		this.headErrorCm = median(this.headErrors);
		this.sampleCount += 1;
	}

	pxPerCm() {
		return pxPerCm();
	}

	private drawPreviews(video: HTMLVideoElement) {
		for (const c of this.previews) {
			const ctx = c.getContext('2d');
			if (!ctx) continue;
			const cw = c.width;
			const ch = c.height;
			ctx.save();
			ctx.translate(cw, 0);
			ctx.scale(-1, 1);
			ctx.drawImage(video, 0, 0, cw, ch);
			const crop = this.cropRect(video.videoWidth, video.videoHeight);
			ctx.lineWidth = 2;
			ctx.strokeStyle = '#60a5fa';
			ctx.strokeRect(
				(crop.x / video.videoWidth) * cw,
				(crop.y / video.videoHeight) * ch,
				(crop.w / video.videoWidth) * cw,
				(crop.h / video.videoHeight) * ch
			);
			for (const f of this.faces) {
				const x = (f.box.cx - f.box.w / 2) * cw;
				const y = (f.box.cy - f.box.h / 2) * ch;
				// Only the player stands out. Anyone else is watching, and their nods do nothing.
				ctx.lineWidth = f.locked || f.player ? 6 : 2;
				ctx.strokeStyle = f.locked ? '#22c55e' : f.player ? '#facc15' : '#64748b';
				ctx.strokeRect(x, y, f.box.w * cw, f.box.h * ch);
			}
			ctx.restore();
		}
	}
}

export const engine = new VisionEngine();

if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__engine = engine;

// This module holds a camera and a render loop, which a hot update would leave running.
if (import.meta.hot) import.meta.hot.dispose(() => location.reload());
