import * as tf from '@tensorflow/tfjs';
import WebEyeTrack from '../vendor/webeyetrack/WebEyeTrack';

let tracker: WebEyeTrack | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = async (e: MessageEvent) => {
	const msg = e.data;
	try {
		switch (msg.type) {
			case 'init': {
				await tf.setBackend('webgl').catch(() => tf.setBackend('cpu'));
				await tf.ready();
				tracker = new WebEyeTrack();
				await tracker.initialize('/models/blazegaze/model.json');
				self.postMessage({ type: 'ready', backend: tf.getBackend() });
				break;
			}
			case 'frame': {
				const bitmap: ImageBitmap = msg.bitmap;
				if (!tracker) {
					bitmap.close();
					break;
				}
				const t0 = performance.now();
				if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
					canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
					ctx = canvas.getContext('2d', { willReadFrequently: true });
				}
				ctx!.drawImage(bitmap, 0, 0);
				bitmap.close();
				const frame = ctx!.getImageData(0, 0, canvas.width, canvas.height);
				const out = tracker.step(frame, msg.face, msg.ts);
				self.postMessage({
					type: 'result',
					ts: msg.ts,
					pog: out.pog,
					open: out.open,
					ear: out.ear,
					depth: out.faceOrigin3D[2],
					ms: performance.now() - t0
				});
				break;
			}
			case 'sample': {
				const t0 = performance.now();
				const ok = tracker?.addSample(msg.x, msg.y, msg.tFrom, msg.tTo);
				self.postMessage({
					type: 'sampled',
					ok: !!ok,
					count: tracker?.sampleCount ?? 0,
					ms: performance.now() - t0
				});
				break;
			}
			case 'reset': {
				tracker?.reset();
				self.postMessage({ type: 'sampled', ok: true, count: 0 });
				break;
			}
		}
	} catch (err) {
		self.postMessage({ type: 'error', message: String(err), during: msg.type });
	}
};

export {};
