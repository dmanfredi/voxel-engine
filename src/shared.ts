export const SharedBindings = /*wgsl*/ `
	struct Uniforms { 
		matrix: mat4x4f
	 }
	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(0) @binding(1) var<storage, read> positions: array<f32>;
`;
