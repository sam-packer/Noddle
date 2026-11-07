import * as ort from 'onnxruntime-web/wasm';

// MobileGaze MobileOne S0. Decoding matches yakhyo/gaze-estimation onnx_inference.py.
const SIZE = 448;
const BINS = 90;
const BIN_WIDTH = 4;
const OFFSET = 180;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let session: ort.InferenceSession | null = null;
const canvas = new OffscreenCanvas(SIZE, SIZE);
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
const input = new Float32Array(3 * SIZE * SIZE);

function expectation(logits: Float32Array): number {
	let max = -Infinity;
	for (let i = 0; i < BINS; i++) if (logits[i] > max) max = logits[i];
	let sum = 0;
	let weighted = 0;
	for (let i = 0; i < BINS; i++) {
		const p = Math.exp(logits[i] - max);
		sum += p;
		weighted += p * i;
	}
	return ((weighted / sum) * BIN_WIDTH - OFFSET) * (Math.PI / 180);
}

self.onmessage = async (e: MessageEvent) => {
	const msg = e.data;
	try {
		if (msg.type === 'init') {
			ort.env.wasm.wasmPaths = new URL('/runtime/ort/', self.location.origin).href;
			// Threads would need cross-origin isolation on every static file, and hang without it.
			ort.env.wasm.numThreads = 1;
			session = await ort.InferenceSession.create('/models/mobileone_s0_gaze.onnx', {
				executionProviders: ['wasm']
			});
			self.postMessage({
				type: 'ready',
				threads: ort.env.wasm.numThreads,
				inputs: session.inputNames,
				outputs: session.outputNames
			});
		} else if (msg.type === 'frame') {
			const bitmap: ImageBitmap = msg.bitmap;
			if (!session) {
				bitmap.close();
				return;
			}
			const t0 = performance.now();
			ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
			bitmap.close();
			const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
			const n = SIZE * SIZE;
			for (let i = 0; i < n; i++) {
				input[i] = (data[i * 4] / 255 - MEAN[0]) / STD[0];
				input[n + i] = (data[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
				input[2 * n + i] = (data[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
			}
			const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) };
			const out = await session.run(feeds);
			const yaw = expectation(out[session.outputNames[0]].data as Float32Array);
			const pitch = expectation(out[session.outputNames[1]].data as Float32Array);
			self.postMessage({ type: 'result', ts: msg.ts, yaw, pitch, ms: performance.now() - t0 });
		}
	} catch (err) {
		self.postMessage({ type: 'error', message: String(err), during: msg.type });
	}
};

export {};
