import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { session } from '../session';
import { HeadGestures, type Gesture } from './gestures';
import { profileFromPoses, type HeadPose, type HeadProfile } from './headProfile';
import {
	faceBox,
	headAngles,
	irisPx,
	median,
	medianPoint,
	OneEuro,
	OneEuro2D,
	type FaceBox,
	type Lm,
	type Point
} from './math';

export type SourceId = 'free' | 'calibrated' | 'head';
export const SOURCES: SourceId[] = ['free', 'calibrated', 'head'];
export type LockState = 'searching' | 'locked' | 'lost';

/** Physical setup. Values can be changed live from the HUD. */
export const setup = {
	screenWidthCm: 30.4,
	cameraAboveScreenCm: 0.8,
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
	/** Eye tracking stays in the code but off: head tracking is the point of Noddle. */
	eyeModels: false,
	/**
	 * Fit each player's centre and range from the lesson's corner cards, with the pointer hidden.
	 * Off, because a screen with no pointer read as broken even to someone who knows the game.
	 */
	personalHead: false,
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
};

type Track = {
	id: number;
	box: FaceBox;
	lastSeen: number;
	gestures: HeadGestures;
	inBounds: boolean;
};

type HistoryEntry = {
	t: number;
	free: Point | null;
	calibrated: Point | null;
	head: Point | null;
	heldYaw: number;
	heldPitch: number;
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
	ear: number;
};

/** The ranges everyone starts with, and goes back to when a new player arrives. */
const DEFAULT_RANGES = {
	rangeYaw: setup.headRangeYawDeg,
	rangeUp: setup.headRangePitchDeg,
	rangeDown: setup.headRangeDownDeg
};

/** How much of each signal is median filtered, in ms. Eye models get long windows, for nystagmus. */
const SMOOTH_MS: Record<SourceId, number> = { free: 500, calibrated: 500, head: 100 };
/** Keep holding the selection briefly after a gesture, while the head returns to rest. */
const HOLD_AFTER_GESTURE_MS = 400;
/** Taking control is a clear nod, because anyone in view could trigger it by accident. */
const LOCK_NOD_DEG = 3.5;
/** A card only teaches us anything if the head really turned toward it. */
const MIN_TURN_DEG = 2;

function clampToViewport(p: Point): Point {
	return {
		x: Math.max(0, Math.min(window.innerWidth, p.x)),
		y: Math.max(0, Math.min(window.innerHeight, p.y))
	};
}

function pxPerCm() {
	return screen.width / setup.screenWidthCm;
}

/** Physical screen position in cm, from the screen's top-left, to viewport pixels. */
function screenCmToClient(xCm: number, yCm: number): Point {
	const k = pxPerCm();
	const chromeTop = Math.max(0, window.outerHeight - window.innerHeight);
	return { x: xCm * k - window.screenX, y: yCm * k - window.screenY - chromeTop };
}

class VisionEngine {
	// Reactive status for the UI
	status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	loadMessage = $state('');
	errors = $state<string[]>([]);
	resolution = $state('');
	fps = $state(0);
	mediapipeMs = $state(0);
	freeMs = $state(0);
	calibratedMs = $state(0);
	faceCount = $state(0);
	faces = $state<{ id: number; box: FaceBox; locked: boolean; inBounds: boolean }[]>([]);
	lock = $state<LockState>('searching');
	yaw = $state(0);
	pitch = $state(0);
	distanceCm = $state(0);
	wetDistanceCm = $state(0);
	faceWidth = $state(0);
	inBounds = $state(false);
	eyesOpen = $state(true);
	ear = $state(0);
	lastGesture = $state('');
	sampleCount = $state(0);
	wetSamples = $state(0);
	wetSkipped = $state(0);
	gaze = $state<Record<SourceId, Point | null>>({ free: null, calibrated: null, head: null });
	prequentialCm = $state<Record<SourceId, number | null>>({
		free: null,
		calibrated: null,
		head: null
	});
	/** Head points by default. 'best' lets whichever source has the lowest measured error drive. */
	policy = $state<'head' | 'best'>('head');
	/** Where the player is pointing. Always live, and what the screen shows. */
	pointer = $state<Point | null>(null);
	/** A nod may be under way, so the selection keeps what it had. The pointer keeps moving. */
	selectionHeld = $state(false);
	/** Learning this player's head with the pointer hidden, so they can't steer to fit the mapping. */
	headCalibrating = $state(false);
	/** Their fitted centre and range, once learned. */
	headProfile = $state<HeadProfile | null>(null);
	/** How far through a nod the player is, from 0 to 1. Lets the selected thing dip with the head. */
	nodProgress = $state(0);
	forced = $state<SourceId | null>(null);
	info = $state<Record<string, string>>({});

	/** Which source currently drives the game. */
	get active(): SourceId {
		if (this.forced) return this.forced;
		if (this.policy === 'best') return this.bestSource();
		return 'head';
	}

	/** Median error of the active source, or a pessimistic default before any samples. */
	get activeErrorCm(): number {
		return this.prequentialCm[this.active] ?? 7;
	}

	// Callbacks
	onGesture: ((g: Gesture) => void) | null = null;
	onLocked: (() => void) | null = null;
	onFrame: ((p: Point | null, t: number) => void) | null = null;
	/** Gets each locked-face frame, for collecting training data. */
	dataTap: ((frame: DataFrame) => void) | null = null;

	// Internals
	private video: HTMLVideoElement | null = null;
	private landmarker: FaceLandmarker | null = null;
	private freeWorker: Worker | null = null;
	private calWorker: Worker | null = null;
	private freeBusy = false;
	private calBusy = false;
	private freeReady = false;
	private calReady = false;
	private tracks: Track[] = [];
	private nextTrackId = 1;
	private lockedId: number | null = null;
	private lockedLastSeen = 0;
	private lastTs = -1;
	private fpsWindow: number[] = [];
	private previews = new Set<HTMLCanvasElement>();
	private frameMeta: VideoFrameCallbackMetadata | null = null;
	private detectCanvas = document.createElement('canvas');
	private detectCtx = this.detectCanvas.getContext('2d', { alpha: false })!;

	private raw: Record<SourceId, Point | null> = { free: null, calibrated: null, head: null };
	private filters: Record<SourceId, OneEuro2D> = {
		free: new OneEuro2D(0.5, 0.004),
		calibrated: new OneEuro2D(0.8, 0.004),
		head: new OneEuro2D(1.2, 0.01)
	};
	private rawFreeAngles: { yaw: number; pitch: number } | null = null;
	private lastFace: { eye: { X: number; Y: number; Z: number } } | null = null;
	private history: HistoryEntry[] = [];
	private recent: Record<SourceId, { t: number; p: Point }[]> = { free: [], calibrated: [], head: [] };
	private holdUntil = 0;

	// Calibration state, in memory only
	private freeBiasSum = { x: 0, y: 0 };
	private freeBiasN = 0;
	private headNeutral: { yaw: number; pitch: number } | null = null;
	private heldYaw: number | null = null;
	private heldPitch: number | null = null;
	private headSmoothYaw = new OneEuro(1.5, 0.02);
	private headSmoothPitch = new OneEuro(1.5, 0.02);
	private recording: Record<string, unknown>[] | null = null;
	private headNeutralAfter = 0;
	private lastLockedBox: FaceBox | null = null;
	private poses: HeadPose[] = [];
	private errorsCm: Record<SourceId, number[]> = { free: [], calibrated: [], head: [] };

	async start() {
		if (this.status !== 'idle') return;
		this.status = 'loading';
		try {
			this.loadMessage = 'Starting camera';
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: false,
				video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
			});
			const video = document.createElement('video');
			video.playsInline = true;
			video.muted = true;
			video.srcObject = stream;
			await video.play();
			this.video = video;
			this.resolution = `${video.videoWidth}×${video.videoHeight}`;

			this.loadMessage = 'Loading face tracking';
			const fileset = await FilesetResolver.forVisionTasks('/runtime/mediapipe');
			this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
				baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'GPU' },
				runningMode: 'VIDEO',
				numFaces: 3,
				outputFacialTransformationMatrixes: true,
				outputFaceBlendshapes: false
			});

			if (setup.eyeModels) this.loadMessage = 'Loading gaze models';
			const withTimeout = (p: Promise<void>, name: string) =>
				new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						this.errors.push(`${name} did not load within 30 s`);
						resolve();
					}, 30000);
					p.then(() => {
						clearTimeout(timer);
						resolve();
					});
				});
			if (setup.eyeModels) {
				await Promise.all([
					withTimeout(this.startFreeWorker(), 'MobileOne'),
					withTimeout(this.startCalibratedWorker(), 'WebEyeTrack')
				]);
			}

			this.status = 'ready';
			this.loadMessage = '';
			video.requestVideoFrameCallback(this.tick);
		} catch (err) {
			this.status = 'error';
			this.errors.push(err instanceof Error ? err.message : String(err));
		}
	}

	private startFreeWorker() {
		return new Promise<void>((resolve) => {
			const w = new Worker(new URL('./free.worker.ts', import.meta.url), { type: 'module' });
			this.freeWorker = w;
			w.onmessage = (e) => {
				const m = e.data;
				if (m.type === 'ready') {
					this.freeReady = true;
					this.info.free = `wasm, ${m.threads} threads`;
					resolve();
				} else if (m.type === 'result') {
					this.freeBusy = false;
					this.freeMs = m.ms;
					this.rawFreeAngles = { yaw: m.yaw, pitch: m.pitch };
				} else if (m.type === 'error') {
					this.freeBusy = false;
					this.errors.push(`free: ${m.message}`);
					resolve();
				}
			};
			w.onerror = (e) => {
				this.errors.push(`free worker: ${e.message}`);
				resolve();
			};
			w.postMessage({ type: 'init' });
		});
	}

	private startCalibratedWorker() {
		return new Promise<void>((resolve) => {
			const w = new Worker(new URL('./calibrated.worker.ts', import.meta.url), { type: 'module' });
			this.calWorker = w;
			w.onmessage = (e) => {
				const m = e.data;
				if (m.type === 'ready') {
					this.calReady = true;
					this.info.calibrated = `tfjs ${m.backend}`;
					resolve();
				} else if (m.type === 'result') {
					this.calBusy = false;
					this.calibratedMs = m.ms;
					this.eyesOpen = m.open;
					this.ear = m.ear;
					this.wetDistanceCm = m.depth;
					this.raw.calibrated = m.pog
						? {
								x: (m.pog[0] + 0.5) * window.innerWidth,
								y: (m.pog[1] + 0.5) * window.innerHeight
							}
						: null;
				} else if (m.type === 'sampled') {
					this.wetSamples = m.count;
					if (m.ok && m.ms !== undefined) this.info.adapt = `${Math.round(m.ms)} ms`;
					if (!m.ok && m.ms !== undefined) this.wetSkipped += 1;
				} else if (m.type === 'error') {
					this.calBusy = false;
					this.errors.push(`calibrated ${m.during}: ${m.message}`);
					resolve();
				}
			};
			w.onerror = (e) => {
				this.errors.push(`calibrated worker: ${e.message}`);
				resolve();
			};
			w.postMessage({ type: 'init' });
		});
	}

	addPreview(c: HTMLCanvasElement) {
		this.previews.add(c);
		return () => this.previews.delete(c);
	}

	private tick = (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
		this.frameMeta = metadata;
		const video = this.video!;
		video.requestVideoFrameCallback(this.tick);
		const ts = Math.max(now, this.lastTs + 1);
		this.lastTs = ts;

		this.fpsWindow.push(now);
		while (this.fpsWindow.length && now - this.fpsWindow[0] > 1000) this.fpsWindow.shift();
		this.fps = this.fpsWindow.length;

		const W = video.videoWidth;
		const H = video.videoHeight;
		const crop = this.cropRect(W, H);
		if (this.detectCanvas.width !== crop.w || this.detectCanvas.height !== crop.h) {
			this.detectCanvas.width = crop.w;
			this.detectCanvas.height = crop.h;
		}
		this.detectCtx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);

		const t0 = performance.now();
		const result = this.landmarker!.detectForVideo(this.detectCanvas, ts);
		this.mediapipeMs = performance.now() - t0;

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

		for (const [track, i] of assigned) {
			const { yaw, pitch } = headAngles(mats[i].data);
			track.inBounds =
				track.box.w >= setup.minFaceWidth &&
				track.box.w <= setup.maxFaceWidth &&
				Math.abs(yaw) <= setup.maxPoseDeg &&
				Math.abs(pitch) <= setup.maxPoseDeg;
			const g = track.gestures.push(ts, yaw, pitch);
			const isLocked = this.lockedId === track.id;
			const turnedDown = track.gestures.rejected;
			if (turnedDown) {
				track.gestures.rejected = null;
				if (isLocked) session.event('rejected', { ...turnedDown });
			}
			if (isLocked) {
				this.yaw = yaw;
				this.pitch = pitch;
				this.faceWidth = track.box.w;
				this.lastLockedBox = track.box;
				this.inBounds = track.inBounds;
				this.lockedLastSeen = ts;
				lockedFace = { lm: lms[i], matrix: mats[i] };
			}
			if (!g) continue;
			if (isLocked && this.lock === 'locked') {
				this.lastGesture = `${g.kind} ${Math.round(ts / 100) / 10}s`;
				this.holdUntil = ts + HOLD_AFTER_GESTURE_MS;
				this.recording?.push({ t: ts, gesture: g.kind, onset: g.onset, sizeDeg: g.sizeDeg });
				session.event('gesture', {
					kind: g.kind,
					at: ts,
					onset: g.onset,
					sizeDeg: Math.round(g.sizeDeg * 10) / 10,
					speed: Math.round(g.speed)
				});
				this.onGesture?.(g);
			} else if (
				this.lock !== 'locked' &&
				g.kind === 'nod' &&
				g.sizeDeg >= LOCK_NOD_DEG &&
				track.inBounds
			) {
				this.takeLock(track, ts);
				lockedFace = { lm: lms[i], matrix: mats[i] };
			}
		}

		if (this.lock === 'locked' && ts - this.lockedLastSeen > setup.lostAfterMs) {
			this.lock = 'lost';
			this.lockedId = null;
		}

		this.faces = this.tracks.map((t) => ({
			id: t.id,
			box: t.box,
			locked: t.id === this.lockedId,
			inBounds: t.inBounds
		}));

		let activePoint: Point | null = null;
		if (lockedFace) {
			this.processLocked(lockedFace.lm, lockedFace.matrix, W, H, ts);
			activePoint = this.updatePointer(ts);
		} else {
			this.pointer = null;
			this.nodProgress = 0;
			this.selectionHeld = false;
		}
		this.onFrame?.(activePoint, ts);
		this.drawPreviews(video);
	};

	private updatePointer(ts: number): Point | null {
		const live = this.gaze[this.active];
		const gestures = this.tracks.find((t) => t.id === this.lockedId)?.gestures;
		this.nodProgress = gestures?.nodProgress ?? 0;
		this.selectionHeld = !!gestures?.nodInProgress || ts < this.holdUntil;
		// A nod swings the head far enough to throw the pointer across the screen. It is a click,
		// not aiming, so the pointer waits where it was until the head is back.
		if (!live) this.pointer = null;
		else if (!this.selectionHeld || !this.pointer) this.pointer = clampToViewport(live);
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

	private takeLock(track: Track, ts: number) {
		// A different person taking over after a loss must not inherit calibration.
		const previous = this.lastLockedBox;
		if (this.lock === 'lost' && previous) {
			const d = Math.hypot(track.box.cx - previous.cx, track.box.cy - previous.cy);
			if (d > previous.w) this.resetCalibration();
		}
		this.lockedId = track.id;
		this.lockedLastSeen = ts;
		this.lock = 'locked';
		// The same player coming back keeps the centre fitted to them.
		if (!this.headProfile) {
			this.headNeutral = null;
			// The head is still finishing the nod, so wait before taking its resting position.
			this.headNeutralAfter = ts + 600;
		}
		this.onLocked?.();
	}

	/** What the camera is really doing, including any resizing or effects. */
	videoSettings() {
		const stream = this.video?.srcObject as MediaStream | undefined;
		return stream?.getVideoTracks()[0]?.getSettings() ?? null;
	}

	/** Locks the first visible face without a nod, for keyboard start and for diagnosis. */
	lockFirst() {
		if (this.lock !== 'locked' && this.tracks[0]) this.takeLock(this.tracks[0], this.lastTs);
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
		this.lock = 'searching';
		this.resetCalibration();
	}

	resetCalibration() {
		this.freeBiasSum = { x: 0, y: 0 };
		this.freeBiasN = 0;
		this.headNeutral = null;
		this.heldYaw = null;
		this.heldPitch = null;
		this.headSmoothYaw.reset();
		this.headSmoothPitch.reset();
		this.poses = [];
		this.headCalibrating = false;
		this.useProfile(null);
		this.history = [];
		this.recent = { free: [], calibrated: [], head: [] };
		this.holdUntil = 0;
		this.selectionHeld = false;
		this.nodProgress = 0;
		this.errorsCm = { free: [], calibrated: [], head: [] };
		this.prequentialCm = { free: null, calibrated: null, head: null };
		this.sampleCount = 0;
		for (const s of SOURCES) this.filters[s].reset();
		this.calWorker?.postMessage({ type: 'reset' });
	}

	private processLocked(
		lm: Lm[],
		matrix: { data: ArrayLike<number> },
		W: number,
		H: number,
		ts: number
	) {
		const video = this.video!;

		// Eye position in camera space, in cm: x image right, y image down, z toward the player.
		const fx = W / (2 * Math.tan(((setup.cameraHfovDeg / 2) * Math.PI) / 180));
		const iris = irisPx(lm, W, H);
		const Z = (fx * setup.irisCm) / Math.max(iris, 1);
		const u = ((lm[468].x + lm[473].x) / 2) * W;
		const v = ((lm[468].y + lm[473].y) / 2) * H;
		const X = ((u - W / 2) * Z) / fx;
		const Y = ((v - H / 2) * Z) / fx;
		this.distanceCm = Z;
		this.lastFace = { eye: { X, Y, Z } };

		// Calibration-free model: square crop of the face.
		if (this.freeReady && !this.freeBusy) {
			const box = faceBox(lm);
			const side = Math.max(box.w * W, box.h * H) * 1.1;
			const sx = Math.max(0, box.cx * W - side / 2);
			const sy = Math.max(0, box.cy * H - side / 2);
			const sw = Math.min(side, W - sx);
			const sh = Math.min(side, H - sy);
			if (sw > 16 && sh > 16) {
				this.freeBusy = true;
				createImageBitmap(video, sx, sy, sw, sh, { resizeWidth: 448, resizeHeight: 448 }).then(
					(bitmap) => this.freeWorker!.postMessage({ type: 'frame', bitmap, ts }, [bitmap]),
					() => (this.freeBusy = false)
				);
			}
		}

		// Calibrated model: full frame, because its camera geometry assumes one.
		if (this.calReady && !this.calBusy) {
			this.calBusy = true;
			const face = {
				landmarks: lm.map((l) => ({ x: l.x, y: l.y, z: l.z })),
				matrix: { rows: 4, columns: 4, data: Array.from(matrix.data) }
			};
			createImageBitmap(video).then(
				(bitmap) =>
					this.calWorker!.postMessage({ type: 'frame', bitmap, face, ts }, [bitmap]),
				() => (this.calBusy = false)
			);
		}

		this.raw.free = this.projectFree();

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
		this.raw.head = {
			x:
				window.innerWidth / 2 -
				(setup.headFlipX ? -1 : 1) *
					((this.heldYaw - neutral.yaw) / setup.headRangeYawDeg) *
					(window.innerWidth / 2),
			y: this.headY(this.heldPitch - neutral.pitch)
		};

		const next: Record<SourceId, Point | null> = { free: null, calibrated: null, head: null };
		for (const s of SOURCES) {
			const r = this.raw[s];
			const queue = this.recent[s];
			if (r && Number.isFinite(r.x) && Number.isFinite(r.y)) queue.push({ t: ts, p: r });
			while (queue.length && ts - queue[0].t > SMOOTH_MS[s]) queue.shift();
			const m = medianPoint(queue.map((q) => q.p));
			next[s] = r && m ? this.filters[s].filter(m, ts) : null;
		}
		this.gaze = next;

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
			ear: this.ear
		});

		session.frame(
			ts,
			yaw,
			pitch,
			this.pointer?.x,
			this.pointer?.y,
			this.gaze.head?.x,
			this.gaze.head?.y,
			this.selectionHeld
		);

		this.history.push({
			t: ts,
			free: this.raw.free,
			calibrated: this.raw.calibrated,
			head: this.raw.head,
			heldYaw: this.heldYaw,
			heldPitch: this.heldPitch
		});
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
				distance: round(Z),
				ear: round(this.ear),
				headX: round(this.gaze.head?.x),
				headY: round(this.gaze.head?.y),
				freeX: round(this.gaze.free?.x),
				freeY: round(this.gaze.free?.y),
				wetX: round(this.gaze.calibrated?.x),
				wetY: round(this.gaze.calibrated?.y),
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

	private cameraToScreenCm(px: number, py: number): Point {
		// Screen right is image left, because the camera faces the player.
		return { x: setup.screenWidthCm / 2 - px, y: py - setup.cameraAboveScreenCm };
	}

	/** Gaze ray from the eyes to the screen plane, plus bias from known targets. */
	private projectFree(): Point | null {
		if (!this.rawFreeAngles || !this.lastFace) return null;
		const { yaw, pitch } = this.rawFreeAngles;
		const { X, Y, Z } = this.lastFace.eye;
		const dx = -Math.sin(yaw) * Math.cos(pitch);
		const dy = -Math.sin(pitch);
		const dz = Math.max(Math.cos(yaw) * Math.cos(pitch), 0.15);
		const t = Z / dz;
		const cm = this.cameraToScreenCm(X + t * dx, Y + t * dy);
		const p = screenCmToClient(cm.x, cm.y);
		if (this.freeBiasN > 0) {
			p.x += this.freeBiasSum.x / this.freeBiasN;
			p.y += this.freeBiasSum.y / this.freeBiasN;
		}
		return p;
	}

	private window(tFrom: number, tTo: number) {
		return this.history.filter((h) => h.t >= tFrom && h.t <= tTo);
	}

	/** Where the active source was pointing around a moment. Used to freeze selection through a nod. */
	pointAt(t: number): Point | null {
		const s = this.active;
		return medianPoint(
			this.window(t - 350, t - 40)
				.map((h) => h[s])
				.filter((p): p is Point => !!p)
		);
	}

	/** Where the pointer was at a moment, without averaging across movement. */
	pointerAt(t: number): Point | null {
		const before = this.history.findLast((h) => h.t <= t);
		return before?.[this.active] ?? null;
	}

	sourcePointNow(s: SourceId, msBack = 800): Point | null {
		const now = this.lastTs;
		return medianPoint(
			this.window(now - msBack, now)
				.map((h) => h[s])
				.filter((p): p is Point => !!p)
		);
	}

	/**
	 * A known target: the player was looking at this point around time `onset`.
	 * Error is scored before training, so it measures unseen data.
	 */
	addSample(target: Point, onset: number) {
		if (this.lock !== 'locked') return;
		const tFrom = onset - 650;
		const tTo = onset - 80;
		const win = this.window(tFrom, tTo);
		if (win.length === 0) return;

		const k = pxPerCm();
		for (const s of SOURCES) {
			const pred = medianPoint(win.map((h) => h[s]).filter((p): p is Point => !!p));
			if (!pred) continue;
			const err = Math.hypot(pred.x - target.x, pred.y - target.y) / k;
			this.errorsCm[s].push(err);
			if (this.errorsCm[s].length > 9) this.errorsCm[s].shift();
			this.prequentialCm[s] = median(this.errorsCm[s]);
		}

		// Free model: running bias only.
		const freePred = medianPoint(win.map((h) => h.free).filter((p): p is Point => !!p));
		if (freePred) {
			const bx = this.freeBiasN ? this.freeBiasSum.x / this.freeBiasN : 0;
			const by = this.freeBiasN ? this.freeBiasSum.y / this.freeBiasN : 0;
			this.freeBiasSum.x += target.x - (freePred.x - bx);
			this.freeBiasSum.y += target.y - (freePred.y - by);
			this.freeBiasN++;
		}

		this.sampleCount += 1;

		// Calibrated model, in [-0.5, 0.5] viewport coordinates.
		this.calWorker?.postMessage({
			type: 'sample',
			x: target.x / window.innerWidth - 0.5,
			y: target.y / window.innerHeight - 0.5,
			tFrom,
			tTo
		});
	}

	/** Hides the pointer and starts learning this player's head from the lesson's cards. */
	beginHeadCalibration() {
		if (!setup.personalHead) return;
		this.useProfile(null);
		this.poses = [];
		this.headCalibrating = true;
	}

	/**
	 * Records where the head was when the player nodded at a card, given as a point on the screen.
	 * Returns false if it hadn't turned toward that card, so the nod says nothing about it.
	 */
	addHeadPose(target: Point, onset: number) {
		if (!this.headCalibrating) return true;
		const win = this.window(onset - 650, onset - 80);
		if (win.length === 0) return false;
		const pose: HeadPose = {
			x: target.x / window.innerWidth,
			y: target.y / window.innerHeight,
			yaw: median(win.map((h) => h.heldYaw)),
			pitch: median(win.map((h) => h.heldPitch))
		};
		const previous = this.poses[this.poses.length - 1] ?? {
			x: 0.5,
			y: setup.headRestY,
			yaw: this.headNeutral?.yaw ?? pose.yaw,
			pitch: this.headNeutral?.pitch ?? pose.pitch
		};
		const dx = (pose.x - previous.x) * window.innerWidth;
		const dy = (pose.y - previous.y) * window.innerHeight;
		// Moving right on screen lowers yaw, and moving up raises pitch.
		const turned =
			Math.abs(dx) >= Math.abs(dy)
				? (previous.yaw - pose.yaw) * Math.sign(dx) * (setup.headFlipX ? -1 : 1)
				: (previous.pitch - pose.pitch) * Math.sign(dy);
		if (turned < MIN_TURN_DEG) return false;
		this.poses.push(pose);
		return true;
	}

	/** Brings the pointer back, using what was learned if there was enough of it. */
	endHeadCalibration() {
		if (!this.headCalibrating) return;
		this.headCalibrating = false;
		const profile = profileFromPoses(this.poses, DEFAULT_RANGES, setup.headRestY, setup.headFlipX);
		session.event('head-profile', { poses: this.poses, profile });
		if (profile) this.useProfile(profile);
	}

	/** Puts a profile into the mapping. The ranges stay in `setup`, where the tools can change them. */
	private useProfile(profile: HeadProfile | null) {
		this.headProfile = profile;
		const ranges = profile ?? DEFAULT_RANGES;
		setup.headRangeYawDeg = ranges.rangeYaw;
		setup.headRangePitchDeg = ranges.rangeUp;
		setup.headRangeDownDeg = ranges.rangeDown;
		if (profile) this.headNeutral = { yaw: profile.neutralYaw, pitch: profile.neutralPitch };
	}

	bestSource(): SourceId {
		let best: SourceId = this.gaze.free ? 'free' : 'head';
		let bestErr = Infinity;
		if (this.sampleCount < 4) return best;
		for (const s of SOURCES) {
			const e = this.prequentialCm[s];
			if (e !== null && e < bestErr && this.gaze[s]) {
				bestErr = e;
				best = s;
			}
		}
		return best;
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
				ctx.lineWidth = f.locked ? 4 : 2;
				ctx.strokeStyle = f.locked ? '#22c55e' : f.inBounds ? '#facc15' : '#ef4444';
				ctx.strokeRect(x, y, f.box.w * cw, f.box.h * ch);
			}
			ctx.restore();
		}
	}
}

export const engine = new VisionEngine();

if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__engine = engine;

// This module holds a camera, a render loop and workers, which a hot update would leave running.
if (import.meta.hot) import.meta.hot.dispose(() => location.reload());
