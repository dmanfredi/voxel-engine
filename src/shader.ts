const MainShader = /*wgsl*/ `
	struct Uniforms {
		matrix: mat4x4f,
	}

	struct Vertex {
		@location(0) position: vec4f,
		@location(1) uv: vec2f,
		@location(2) color: vec4f,
	}

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) uv: vec2f,
		@location(1) color: vec4f,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(0) @binding(1) var mySampler: sampler;
	@group(0) @binding(2) var myTexture: texture_2d<f32>;
	// @group(0) @binding(2) var<storage, read> indices: array<u32>;

	@vertex fn vs(vert: Vertex) -> VSOutput {
		var vsOut: VSOutput;
		vsOut.position = uni.matrix * vert.position;
		vsOut.uv = vert.uv;
		vsOut.color = vert.color;
		return vsOut;
	}

	@fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
		return textureSample(myTexture, mySampler, vsOut.uv);
	}
`;

export default MainShader;
