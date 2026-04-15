import { blockRegistry } from '../block';

/** Emit a number as a valid WGSL f32 literal (always contains a decimal point). */
function f32Literal(n: number): string {
	const s = n.toString();
	return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

/**
 * Generate per-material WGSL const arrays indexed by block ID (== texLayer).
 *
 * Consumed by any shader that wants per-material reflection params — currently
 * the voxel shader and the entity shader. Runs at module load; values are
 * baked into the shader string when `createShaderModule` is called.
 */
export function buildMaterialLUT(): string {
	const shin: string[] = [];
	const spec: string[] = [];
	for (let id = 0; id < blockRegistry.count; id++) {
		const props = blockRegistry.get(id);
		shin.push(f32Literal(props?.shininess ?? 0));
		spec.push(f32Literal(props?.specularStrength ?? 0));
	}
	const n = String(shin.length);
	return `
		const MATERIAL_SHININESS = array<f32, ${n}>(${shin.join(', ')});
		const MATERIAL_SPEC_STRENGTH = array<f32, ${n}>(${spec.join(', ')});
	`;
}
