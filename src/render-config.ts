/**
 * Mode tables shared by the debug panel, the render loop, and the shaders.
 * shader/shared.ts generates matching WGSL constants from these tables, so
 * TS-side and shader-side numbering cannot drift.
 */

export const RENDER_MODE = {
	Final: 0,
	Albedo: 1,
	Lighting: 2,
	AO: 3,
} as const;

export type RenderMode = keyof typeof RENDER_MODE;

export const MSAA_MODE = {
	Off: 1,
	'4x': 4,
} as const;

export type MSAAMode = keyof typeof MSAA_MODE;

export const TONEMAP_MODE = {
	Off: 0,
	Reinhard: 1,
	ACES: 2,
	AgX: 3,
	'AgX Punchy': 4,
} as const;

export type TonemapMode = keyof typeof TONEMAP_MODE;

/**
 * Build the per-sample-count pipeline variants MSAA_MODE demands, so adding
 * a sample count is a table edit here rather than a hunt through the four
 * modules that own pipelines.
 */
export function msaaVariants(
	create: (sampleCount: number) => GPURenderPipeline,
): Record<number, GPURenderPipeline> {
	const variants: Record<number, GPURenderPipeline> = {};
	for (const sampleCount of Object.values(MSAA_MODE)) {
		variants[sampleCount] = create(sampleCount);
	}
	return variants;
}
