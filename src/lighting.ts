export const SUN_DIRECTION = [-0.387, 0.73, 0.563] as const;

export const SUN_DIRECTION_WGSL =
	'const LIGHT_DIR = vec3f(-0.387, 0.730, 0.563);';

export type SunDirection = typeof SUN_DIRECTION;
