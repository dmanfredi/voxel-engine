import { wgslVec3 } from './shader/shared';

export const SUN_DIRECTION = [-0.387, 0.73, 0.563] as const;

export const SUN_DIRECTION_WGSL = `const LIGHT_DIR = ${wgslVec3(SUN_DIRECTION)};`;
