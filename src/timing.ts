/**
 * Reusable normalized timing functions.
 *
 * Input is elapsed progress in [0, 1]; output is completed distance in
 * [0, 1]. Projectile motion evaluates the difference between two samples, so
 * curves stay frame-rate independent and preserve total range. Timing
 * functions must be pure, monotonic, and satisfy f(0) = 0 and f(1) = 1.
 */

export type TimingFunction = (progress: number) => number;

const SOLVE_EPSILON = 1e-7;
const VALIDATION_EPSILON = 1e-6;
const VALIDATION_SAMPLES = 128;

function bezierCoordinate(t: number, c1: number, c2: number): number {
	const a = 1 - 3 * c2 + 3 * c1;
	const b = 3 * c2 - 6 * c1;
	const c = 3 * c1;
	return ((a * t + b) * t + c) * t;
}

function bezierDerivative(t: number, c1: number, c2: number): number {
	const a = 1 - 3 * c2 + 3 * c1;
	const b = 3 * c2 - 6 * c1;
	const c = 3 * c1;
	return (3 * a * t + 2 * b) * t + c;
}

function solveBezierParameter(
	progress: number,
	x1: number,
	x2: number,
): number {
	let t = progress;
	for (let i = 0; i < 8; i++) {
		const error = bezierCoordinate(t, x1, x2) - progress;
		if (Math.abs(error) <= SOLVE_EPSILON) return t;
		const slope = bezierDerivative(t, x1, x2);
		if (Math.abs(slope) <= SOLVE_EPSILON) break;
		const next = t - error / slope;
		if (next < 0 || next > 1) break;
		t = next;
	}

	let low = 0;
	let high = 1;
	t = progress;
	for (let i = 0; i < 20; i++) {
		const estimate = bezierCoordinate(t, x1, x2);
		if (Math.abs(estimate - progress) <= SOLVE_EPSILON) return t;
		if (estimate < progress) low = t;
		else high = t;
		t = (low + high) * 0.5;
	}
	return t;
}

function requireFinite(name: string, value: number): void {
	if (!Number.isFinite(value)) {
		throw new Error(`${name} must be finite (got ${String(value)})`);
	}
}

/**
 * CSS-style cubic Bézier timing. X control points follow CSS's [0, 1]
 * constraint. Y control points are additionally ordered inside [0, 1] so
 * projectile distance cannot reverse or overshoot.
 */
export function cubicBezier(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): TimingFunction {
	requireFinite('cubicBezier x1', x1);
	requireFinite('cubicBezier y1', y1);
	requireFinite('cubicBezier x2', x2);
	requireFinite('cubicBezier y2', y2);
	if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
		throw new Error('cubicBezier x control points must be within [0, 1]');
	}
	if (y1 < 0 || y2 > 1 || y1 > y2) {
		throw new Error(
			'cubicBezier y control points must satisfy 0 <= y1 <= y2 <= 1',
		);
	}

	return (progress) => {
		if (progress <= 0) return 0;
		if (progress >= 1) return 1;
		const t = solveBezierParameter(progress, x1, x2);
		return bezierCoordinate(t, y1, y2);
	};
}

const linear: TimingFunction = (t) => t;
const quadIn: TimingFunction = (t) => t * t;
const quadOut: TimingFunction = (t) => 1 - (1 - t) * (1 - t);
const quadInOut: TimingFunction = (t) =>
	t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 * 0.5;
const cubicIn: TimingFunction = (t) => t * t * t;
const cubicOut: TimingFunction = (t) => 1 - (1 - t) ** 3;
const cubicInOut: TimingFunction = (t) =>
	t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 * 0.5;
const expoIn: TimingFunction = (t) => (t === 0 ? 0 : 2 ** (10 * t - 10));
const expoOut: TimingFunction = (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t));
const expoInOut: TimingFunction = (t) => {
	if (t === 0 || t === 1) return t;
	return t < 0.5 ? 2 ** (20 * t - 10) * 0.5 : (2 - 2 ** (-20 * t + 10)) * 0.5;
};

/** Shared catalog for ProjectileProfile.timing and other normalized motion. */
export const timingFunctions = Object.freeze({
	linear,
	ease: cubicBezier(0.25, 0.1, 0.25, 1),
	easeIn: cubicBezier(0.42, 0, 1, 1),
	easeOut: cubicBezier(0, 0, 0.58, 1),
	easeInOut: cubicBezier(0.42, 0, 0.58, 1),
	quadIn,
	quadOut,
	quadInOut,
	cubicIn,
	cubicOut,
	cubicInOut,
	expoIn,
	expoOut,
	expoInOut,
} satisfies Record<string, TimingFunction>);

/**
 * Sampled runtime guard for user-defined functions. It cannot prove arbitrary
 * code monotonic, but catches invalid endpoints, non-finite values, range
 * escapes, and practical reversals before gameplay starts.
 */
export function assertMonotonicTiming(
	label: string,
	timing: TimingFunction,
): void {
	let previous = timing(0);
	if (!Number.isFinite(previous) || Math.abs(previous) > VALIDATION_EPSILON) {
		throw new Error(`${label} must start at 0 (got ${String(previous)})`);
	}

	for (let i = 1; i <= VALIDATION_SAMPLES; i++) {
		const progress = i / VALIDATION_SAMPLES;
		const value = timing(progress);
		if (!Number.isFinite(value)) {
			throw new Error(
				`${label} returned a non-finite value at ${String(progress)}`,
			);
		}
		if (value < -VALIDATION_EPSILON || value > 1 + VALIDATION_EPSILON) {
			throw new Error(
				`${label} must stay within [0, 1] (got ${String(value)} at ${String(progress)})`,
			);
		}
		if (value + VALIDATION_EPSILON < previous) {
			throw new Error(
				`${label} must be monotonic at ${String(progress)}`,
			);
		}
		previous = value;
	}

	if (Math.abs(previous - 1) > VALIDATION_EPSILON) {
		throw new Error(`${label} must end at 1 (got ${String(previous)})`);
	}
}
