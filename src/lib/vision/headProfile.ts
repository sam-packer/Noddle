/** How one person's head maps to the screen. Angles in degrees. */
export type HeadProfile = {
	/** Where their head points at the screen's resting spot. */
	neutralYaw: number;
	neutralPitch: number;
	/** How far they turn from there to reach the side, top and bottom edges. */
	rangeYaw: number;
	rangeUp: number;
	rangeDown: number;
};

/** Where their head was when they turned to a card, with the pointer hidden. */
export type HeadPose = {
	/** The card's position as a share of the screen, 0 to 1. */
	x: number;
	y: number;
	yaw: number;
	pitch: number;
};

/** Ranges can't move further than this from the defaults: too short makes the pointer twitchy. */
const MIN_SHARE = 0.65;
const MAX_SHARE = 1.4;
/** Below this many cards, or this much head movement, there's nothing to learn from. */
const MIN_POSES = 3;
const MIN_YAW_SPREAD_DEG = 4;
const MIN_PITCH_SPREAD_DEG = 2;

/** Straight line through the points, as value = intercept + slope * input. */
function line(points: { input: number; value: number }[]) {
	const n = points.length;
	const inputMean = points.reduce((sum, p) => sum + p.input, 0) / n;
	const valueMean = points.reduce((sum, p) => sum + p.value, 0) / n;
	let top = 0;
	let bottom = 0;
	for (const p of points) {
		top += (p.input - inputMean) * (p.value - valueMean);
		bottom += (p.input - inputMean) ** 2;
	}
	const slope = bottom > 0 ? top / bottom : 0;
	return { slope, intercept: valueMean - slope * inputMean };
}

function spread(values: number[]) {
	return Math.max(...values) - Math.min(...values);
}

/**
 * Works out someone's centre and range from turning toward known spots without seeing a pointer, so
 * these are their natural movements and not ones they steered to fit the current mapping. An axis
 * they barely moved on keeps its default range, because that shows nothing about how far they'd go.
 */
export function profileFromPoses(
	poses: HeadPose[],
	defaults: { rangeYaw: number; rangeUp: number; rangeDown: number },
	restY: number,
	flipX: boolean
): HeadProfile | null {
	if (poses.length < MIN_POSES) return null;
	const clamp = (value: number, base: number) =>
		Math.max(base * MIN_SHARE, Math.min(base * MAX_SHARE, value));

	// The pointer moves left as yaw rises, unless the mapping is flipped.
	const across = line(
		poses.map((p) => ({ input: (flipX ? -1 : 1) * (1 - 2 * p.x), value: p.yaw }))
	);
	const yawMoved = spread(poses.map((p) => p.yaw)) >= MIN_YAW_SPREAD_DEG && across.slope > 0;

	// Above the resting spot, y falls toward 0 as pitch rises.
	const upward = line(poses.map((p) => ({ input: (restY - p.y) / restY, value: p.pitch })));
	const pitchMoved = spread(poses.map((p) => p.pitch)) >= MIN_PITCH_SPREAD_DEG && upward.slope > 0;

	const rangeUp = pitchMoved ? clamp(upward.slope, defaults.rangeUp) : defaults.rangeUp;
	return {
		neutralYaw: yawMoved ? across.intercept : poses.reduce((sum, p) => sum + p.yaw, 0) / poses.length,
		neutralPitch: pitchMoved
			? upward.intercept
			: poses.reduce((sum, p) => sum + p.pitch, 0) / poses.length,
		rangeYaw: yawMoved ? clamp(across.slope, defaults.rangeYaw) : defaults.rangeYaw,
		rangeUp,
		// The cards can't reach low without straining the neck, so down scales with up.
		rangeDown: defaults.rangeDown * (rangeUp / defaults.rangeUp)
	};
}
