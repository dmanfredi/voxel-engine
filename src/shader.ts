const MainShader = /*wgsl*/ `
	struct Uniforms {
		matrix: mat4x4f,
	}

	struct Vertex {
		@location(0) position: vec4f,
		@location(1) normal: vec3f,
		@location(2) uv: vec2f,
		@location(3) ao: f32,
		@location(4) texLayer: u32,
	}

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) uv: vec2f,
		@location(1) @interpolate(flat) texLayer: u32,
		@location(2) normal: vec3f,
		@location(3) ao: f32,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(0) @binding(1) var mySampler: sampler;
	@group(0) @binding(2) var myTexture: texture_2d_array<f32>;

	@vertex fn vs(vert: Vertex) -> VSOutput {
		var vsOut: VSOutput;
		vsOut.position = uni.matrix * vert.position;
		vsOut.uv = vert.uv;
		vsOut.texLayer = vert.texLayer;
		vsOut.normal = vert.normal;
		vsOut.ao = vert.ao;
		return vsOut;
	}

	@fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
		let texColor = textureSample(myTexture, mySampler, vsOut.uv, vsOut.texLayer);

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

		// a nice blue vec3f(0.49, 0.55, 0.68)
		let shadowColor = vec3f(0.1, 0.1, 0.1); // AO shadow tint
		let lit = texColor.rgb * brightness;
		return vec4f(mix(shadowColor, lit, vsOut.ao), texColor.a);
	}
`;

export default MainShader;
