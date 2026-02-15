const MainShader = /*wgsl*/ `
	struct Uniforms {
		matrix: mat4x4f,
	}

	struct Vertex {
		@location(0) position: vec4f,
		@location(1) normal: vec3f,
		@location(2) uv: vec2f,
		@location(3) color: vec4f,
	}

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) uv: vec2f,
		@location(1) color: vec4f,
		@location(2) normal: vec3f,
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
		vsOut.normal = vert.normal;
		return vsOut;
	}

	@fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
		let texColor = textureSample(myTexture, mySampler, vsOut.uv);

		// Per-face shading: top brightest, sides medium, bottom darkest
		let n = vsOut.normal;
		var brightness: f32;
		if (n.y > 0.5) {
			brightness = 1.0;   // top
		} else if (n.y < -0.5) {
			brightness = 0.5;   // bottom
		} else if (abs(n.x) > 0.5) {
			brightness = 0.6;   // east/west
		} else {
			brightness = 0.8;   // north/south
		}

		return vec4f(texColor.rgb * brightness, texColor.a);
	}
`;

export default MainShader;
