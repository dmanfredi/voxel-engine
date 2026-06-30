// Crush telegraph beam — the translucent red column marking the lane a Crush
// cube is about to carve. Geometry is procedural (a box from `vertex_index`,
// no vertex buffer): the locked column's footprint and Y-span arrive as a
// uniform. Color (including a progress-ramped alpha) is supplied per beam, so
// the column charges up as the carve nears. Premultiplied output matches the
// one / one-minus-src-alpha blend, same as the void floor pass.

const CrushBeamShader = /*wgsl*/ `
	struct Uniforms {
		matrix: mat4x4f,
		eyePosition: vec3f,
		shininess: f32,
		specularStrength: f32,
		fogStart: f32,
		fogEnd: f32,
	}

	struct Beam {
		a: vec4f,     // centerX, centerZ, halfWidth, topY
		b: vec4f,     // bottomY, _, _, _
		color: vec4f, // straight RGBA
	}

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) color: vec4f,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(1) @binding(0) var<uniform> beam: Beam;

	@vertex fn vs(@builtin(vertex_index) v: u32) -> VSOutput {
		// Unit box corners (x, y-flag, z); y-flag 0 → bottomY, 1 → topY.
		let corners = array<vec3f, 8>(
			vec3f(-1.0, 0.0, -1.0),
			vec3f( 1.0, 0.0, -1.0),
			vec3f( 1.0, 0.0,  1.0),
			vec3f(-1.0, 0.0,  1.0),
			vec3f(-1.0, 1.0, -1.0),
			vec3f( 1.0, 1.0, -1.0),
			vec3f( 1.0, 1.0,  1.0),
			vec3f(-1.0, 1.0,  1.0),
		);
		// 12 triangles covering all six faces (cullMode 'none', so winding
		// is irrelevant).
		let indices = array<u32, 36>(
			0u, 1u, 5u, 0u, 5u, 4u,
			3u, 7u, 6u, 3u, 6u, 2u,
			0u, 4u, 7u, 0u, 7u, 3u,
			1u, 2u, 6u, 1u, 6u, 5u,
			0u, 3u, 2u, 0u, 2u, 1u,
			4u, 5u, 6u, 4u, 6u, 7u,
		);
		let idx = indices[v];
		let c = corners[idx];
		let halfWidth = beam.a.z;
		let x = beam.a.x + c.x * halfWidth;
		let z = beam.a.y + c.z * halfWidth;
		let y = select(beam.b.x, beam.a.w, c.y > 0.5); // bottomY or topY

		var out: VSOutput;
		out.position = uni.matrix * vec4f(x, y, z, 1.0);
		out.color = beam.color;
		return out;
	}

	@fragment fn fs(inp: VSOutput) -> @location(0) vec4f {
		let a = inp.color.a;
		return vec4f(inp.color.rgb * a, a);
	}
`;

export default CrushBeamShader;
