import { OneEuro } from '../src/lib/vision/math';

/**
 * An experiment, not used by the game. In real play it made aiming worse, even though `bun run pointer`
 * scored it far better: that replay can't show how a player reacts to the pointer. Only a change
 * tested by a player, such as a setting compared in a B test run, should replace the game's smoothing.
 */
export const smootherConfig = {
	/** Steadiness when the head is nearly still. Lower shakes less but trails more. */
	minCutoff: 0.5,
	/** How quickly smoothing lets go once the head moves. Higher catches up faster. */
	beta: 0.4,
	/** Movement smaller than this leaves the pointer where it is, in degrees. The pointer can stop */
	/** this far short of the head, so keep it small. */
	deadbandDeg: 0.25
};

function drag(held: number | null, value: number, deadband: number) {
	if (held === null) return value;
	const delta = value - held;
	return Math.abs(delta) <= deadband ? held : value - Math.sign(delta) * deadband;
}

export class HeadSmoother {
	private yawFilter = new OneEuro(smootherConfig.minCutoff, smootherConfig.beta);
	private pitchFilter = new OneEuro(smootherConfig.minCutoff, smootherConfig.beta);
	private yaw: number | null = null;
	private pitch: number | null = null;

	push(t: number, yaw: number, pitch: number) {
		const { deadbandDeg } = smootherConfig;
		this.yaw = drag(this.yaw, this.yawFilter.filter(yaw, t), deadbandDeg);
		this.pitch = drag(this.pitch, this.pitchFilter.filter(pitch, t), deadbandDeg);
		return { yaw: this.yaw, pitch: this.pitch };
	}

	reset() {
		this.yawFilter.reset();
		this.pitchFilter.reset();
		this.yaw = null;
		this.pitch = null;
	}
}
