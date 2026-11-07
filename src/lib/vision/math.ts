import { Matrix, solve } from 'ml-matrix';

export type Point = { x: number; y: number };
export type Lm = { x: number; y: number; z: number };

export const DEG = 180 / Math.PI;

export function median(values: number[]): number {
	if (values.length === 0) return NaN;
	const s = [...values].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function medianPoint(points: Point[]): Point | null {
	if (points.length === 0) return null;
	return { x: median(points.map((p) => p.x)), y: median(points.map((p) => p.y)) };
}

export class OneEuro {
	private x: number | null = null;
	private dx = 0;
	private t = 0;
	constructor(
		private minCutoff = 0.6,
		private beta = 0.004,
		private dCutoff = 1
	) {}
	private alpha(cutoff: number, dt: number) {
		const tau = 1 / (2 * Math.PI * cutoff);
		return 1 / (1 + tau / dt);
	}
	filter(value: number, tMs: number): number {
		if (this.x === null) {
			this.x = value;
			this.t = tMs;
			return value;
		}
		const dt = Math.max((tMs - this.t) / 1000, 1e-3);
		this.t = tMs;
		const rawDx = (value - this.x) / dt;
		this.dx += this.alpha(this.dCutoff, dt) * (rawDx - this.dx);
		const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
		this.x += this.alpha(cutoff, dt) * (value - this.x);
		return this.x;
	}
	reset() {
		this.x = null;
		this.dx = 0;
	}
}

export class OneEuro2D {
	private fx: OneEuro;
	private fy: OneEuro;
	constructor(minCutoff?: number, beta?: number) {
		this.fx = new OneEuro(minCutoff, beta);
		this.fy = new OneEuro(minCutoff, beta);
	}
	filter(p: Point, t: number): Point {
		return { x: this.fx.filter(p.x, t), y: this.fy.filter(p.y, t) };
	}
	reset() {
		this.fx.reset();
		this.fy.reset();
	}
}

/** Facial transformation matrix to face normal, in (image right, up, toward camera). */
export function faceForward(data: ArrayLike<number>): [number, number, number] {
	// MediaPipe stores the translation in the last column. Detect the order instead of assuming it.
	const columnMajor = Math.abs(data[14]) > Math.abs(data[11]);
	return columnMajor ? [data[8], data[9], data[10]] : [data[2], data[6], data[10]];
}

export function headAngles(data: ArrayLike<number>): { yaw: number; pitch: number } {
	const [fx, fy, fz] = faceForward(data);
	return {
		yaw: Math.atan2(fx, fz) * DEG,
		pitch: Math.atan2(fy, Math.hypot(fx, fz)) * DEG
	};
}

export type FaceBox = { cx: number; cy: number; w: number; h: number };

/** Bounds of the whole mesh in normalized image coordinates. */
export function faceBox(lm: Lm[]): FaceBox {
	let minX = 1;
	let maxX = 0;
	let minY = 1;
	let maxY = 0;
	for (let i = 0; i < 468; i++) {
		const p = lm[i];
		if (p.x < minX) minX = p.x;
		if (p.x > maxX) maxX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.y > maxY) maxY = p.y;
	}
	return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

/** Iris diameter in pixels, averaged over both eyes. */
export function irisPx(lm: Lm[], W: number, H: number): number {
	const d = (a: number, b: number) =>
		Math.hypot((lm[a].x - lm[b].x) * W, (lm[a].y - lm[b].y) * H);
	return (d(469, 471) + d(474, 476)) / 2;
}

/** Iris position inside the eye: along the corner axis, and across it. */
export function irisFeatures(lm: Lm[], W: number, H: number): number[] {
	const one = (corner1: number, corner2: number, iris: number) => {
		const ax = lm[corner1].x * W;
		const ay = lm[corner1].y * H;
		const ux = lm[corner2].x * W - ax;
		const uy = lm[corner2].y * H - ay;
		const len2 = ux * ux + uy * uy || 1;
		const ix = lm[iris].x * W - (ax + ux / 2);
		const iy = lm[iris].y * H - (ay + uy / 2);
		return [(ix * ux + iy * uy) / len2, (-ix * uy + iy * ux) / len2];
	};
	return [...one(33, 133, 468), ...one(362, 263, 473)];
}

/** Ridge regression from features to x and y, with a bias term in the features. */
export class RidgeMap {
	private wx: number[] | null = null;
	private wy: number[] | null = null;
	constructor(private lambda = 0.05) {}

	get fitted() {
		return this.wx !== null;
	}

	reset() {
		this.wx = null;
		this.wy = null;
	}

	fit(features: number[][], xs: number[], ys: number[]) {
		const X = new Matrix(features);
		const n = X.columns;
		const A = X.transpose().mmul(X);
		for (let i = 0; i < n; i++) A.set(i, i, A.get(i, i) + this.lambda);
		const solveFor = (y: number[]) =>
			solve(A, X.transpose().mmul(Matrix.columnVector(y))).to1DArray();
		this.wx = solveFor(xs);
		this.wy = solveFor(ys);
	}

	predict(f: number[]): Point | null {
		if (!this.wx || !this.wy) return null;
		const dot = (w: number[]) => w.reduce((s, v, i) => s + v * f[i], 0);
		return { x: dot(this.wx), y: dot(this.wy) };
	}
}
