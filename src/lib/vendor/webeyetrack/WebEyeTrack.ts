// @ts-nocheck
// Fork of RedForestAI/WebEyeTrack js/src/WebEyeTrack.ts at 75fbd2f (MIT, see LICENSE).
// Changes from upstream:
// - takes landmarks of an already selected face instead of owning a FaceLandmarker
// - samples are supplied programmatically as screen targets, no click listener
// - samples are paired with buffered frames from the moment they were observed
// - the sample buffer keeps spatial spread instead of the most recent points
// - face width comes from the median of the first frames, not one frame
// - closed eyes return no reading instead of [0, 0]
// - reset() clears everything for a new player
// - personalization is the affine fit only. Upstream also ran one Adam step per sample at
//   lr 1e-5, which barely moved the weights but blocked inference for about 6 s on a Mac GPU.
import * as tf from '@tensorflow/tfjs';
import { Matrix } from 'ml-matrix';

import BlazeGaze from './BlazeGaze';
import {
	computeFaceOrigin3D,
	createIntrinsicsMatrix,
	createPerspectiveMatrix,
	translateMatrix,
	faceReconstruction,
	estimateFaceWidth,
	getHeadVector,
	obtainEyePatch,
	computeEAR,
	computeAffineMatrixML,
	applyAffineMatrix
} from './utils/mathUtils';
import { KalmanFilter2D } from './utils/filter';

export interface ExternalFace {
	landmarks: { x: number; y: number; z: number }[];
	matrix: { rows: number; columns: number; data: number[] };
}

export interface BufferedFrame {
	eyePatch: ImageData;
	headVector: number[];
	faceOrigin3D: number[];
	open: boolean;
	ts: number;
}

export interface StepOutput {
	pog: number[] | null;
	open: boolean;
	faceOrigin3D: number[];
	ear: number;
}

const FACE_WIDTH_FRAMES = 30;
const BUFFER_MS = 1500;

export default class WebEyeTrack {
	private blazeGaze = new BlazeGaze();
	private faceWidthSamples: number[] = [];
	private faceWidthCm = -1;
	private perspectiveMatrix: Matrix | null = null;
	private intrinsicsMatrix: Matrix | null = null;
	private affineMatrix: tf.Tensor | null = null;
	private kalmanFilter = new KalmanFilter2D();
	private lastDepth = 60;
	private frames: BufferedFrame[] = [];
	private calib: { pred: number[]; xy: number[] }[] = [];

	public loaded = false;
	public maxPoints: number;
	public earThreshold: number;

	constructor(maxPoints = 12, earThreshold = 0.12) {
		this.maxPoints = maxPoints;
		this.earThreshold = earThreshold;
	}

	async initialize(modelUrl: string): Promise<void> {
		this.modelUrl = modelUrl;
		await this.blazeGaze.loadModel(modelUrl);
		this.loaded = true;
	}

	private modelUrl = '';

	get sampleCount() {
		return this.calib.length;
	}

	reset(): void {
		this.calib = [];
		this.frames = [];
		this.faceWidthSamples = [];
		this.faceWidthCm = -1;
		this.lastDepth = 60;
		this.kalmanFilter = new KalmanFilter2D();
		if (this.affineMatrix) tf.dispose(this.affineMatrix);
		this.affineMatrix = null;
	}

	private faceOrigin(frame: ImageData, landmarks, landmarks2d, faceRT: Matrix): number[] {
		if (this.faceWidthSamples.length < FACE_WIDTH_FRAMES) {
			this.faceWidthSamples.push(estimateFaceWidth(landmarks2d));
			const sorted = [...this.faceWidthSamples].sort((a, b) => a - b);
			this.faceWidthCm = sorted[Math.floor(sorted.length / 2)];
		}
		const [, metricFace] = faceReconstruction(
			this.perspectiveMatrix,
			landmarks.map((l) => [l.x, l.y]),
			faceRT,
			this.intrinsicsMatrix,
			this.faceWidthCm,
			frame.width,
			frame.height,
			this.lastDepth
		);
		const origin = computeFaceOrigin3D(metricFace);
		if (Number.isFinite(origin[2])) this.lastDepth = origin[2];
		return origin;
	}

	step(frame: ImageData, face: ExternalFace, ts: number): StepOutput {
		const { width, height } = frame;
		if (!this.perspectiveMatrix) this.perspectiveMatrix = createPerspectiveMatrix(width / height);
		if (!this.intrinsicsMatrix) this.intrinsicsMatrix = createIntrinsicsMatrix(width, height);

		const landmarks = face.landmarks;
		const landmarks2d = landmarks.map((l) => [Math.floor(l.x * width), Math.floor(l.y * height)]);
		const faceRT = translateMatrix(face.matrix);
		const eyePatch = obtainEyePatch(frame, landmarks2d);
		const faceOrigin3D = this.faceOrigin(frame, landmarks, landmarks2d, faceRT);
		const headVector = getHeadVector(faceRT);

		const ear = Math.min(computeEAR(landmarks, 'left'), computeEAR(landmarks, 'right'));
		const open = ear >= this.earThreshold;

		this.frames.push({ eyePatch, headVector, faceOrigin3D, open, ts });
		while (this.frames.length && ts - this.frames[0].ts > BUFFER_MS) this.frames.shift();

		if (!open) return { pog: null, open, faceOrigin3D, ear };

		const raw = tf.tidy(() => {
			const input = tf.browser.fromPixels(eyePatch).toFloat().expandDims(0).div(255);
			let out = this.blazeGaze.predict(
				input,
				tf.tensor2d(headVector, [1, 3]),
				tf.tensor2d(faceOrigin3D, [1, 3])
			);
			if (this.affineMatrix) out = applyAffineMatrix(this.affineMatrix, out);
			return out;
		});
		const normPog = raw.arraySync();
		tf.dispose(raw);

		const pog = this.kalmanFilter.step(normPog[0]);
		pog[0] = Math.max(-0.5, Math.min(0.5, pog[0]));
		pog[1] = Math.max(-0.5, Math.min(0.5, pog[1]));
		return { pog, open, faceOrigin3D, ear };
	}

	/** Drop the older point of the closest pair, so the buffer keeps its coverage. */
	private prune() {
		while (this.calib.length > this.maxPoints) {
			let best = 0;
			let bestDist = Infinity;
			for (let i = 0; i < this.calib.length; i++) {
				for (let j = i + 1; j < this.calib.length; j++) {
					const a = this.calib[i].xy;
					const b = this.calib[j].xy;
					const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
					if (d < bestDist) {
						bestDist = d;
						best = i;
					}
				}
			}
			this.calib.splice(best, 1);
		}
	}

	/**
	 * Adapt to a known target. x and y are in [-0.5, 0.5] with the origin at the
	 * viewport centre. tFrom and tTo give the moment the player was looking at it.
	 * Returns false if no open-eye frame exists for that moment.
	 */
	addSample(x: number, y: number, tFrom: number, tTo: number): boolean {
		const candidates = this.frames.filter((f) => f.open && f.ts >= tFrom && f.ts <= tTo);
		if (candidates.length === 0) return false;
		const frame = candidates[Math.floor(candidates.length / 2)];

		const raw = tf.tidy(() =>
			this.blazeGaze.predict(
				tf.browser.fromPixels(frame.eyePatch).toFloat().expandDims(0).div(255),
				tf.tensor2d(frame.headVector, [1, 3]),
				tf.tensor2d(frame.faceOrigin3D, [1, 3])
			)
		);
		const pred = raw.arraySync()[0];
		tf.dispose(raw);

		this.calib.push({ pred, xy: [x, y] });
		this.prune();

		// A fit needs real spread in the model's output, or it blows up tiny differences.
		const spread = (axis: number) => {
			const v = this.calib.map((c) => c.pred[axis]);
			return Math.max(...v) - Math.min(...v);
		};
		if (this.calib.length > 3 && spread(0) > 0.03 && spread(1) > 0.03) {
			const affine = computeAffineMatrixML(
				this.calib.map((c) => c.pred),
				this.calib.map((c) => c.xy)
			);
			if (this.affineMatrix) tf.dispose(this.affineMatrix);
			this.affineMatrix = tf.tensor2d(affine, [2, 3], 'float32');
		}
		return true;
	}
}
