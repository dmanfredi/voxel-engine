// Void floor — placeholder visuals for the void hazard. Flat translucent
// horizontal quads, one per band boundary, so the rising void and its layers
// are visible while tuning. These are debug fills; the real fuzzy black-chasm
// look swaps in at the fragment stage later, keeping this pass and uniform.
//
// Geometry is procedural (6 vertices from `vertex_index`) — no vertex buffer.
// Each plane is a large quad centered on the player's X/Z.

const VoidFloorShader = /*wgsl*/ `
	struct Uniforms {
		matrix: mat4x4f,
		eyePosition: vec3f,
		shininess: f32,
		specularStrength: f32,
		fogStart: f32,
		fogEnd: f32,
	}

	struct Plane {
		// x=centerX, y=planeY, z=centerZ, w=halfExtent
		params: vec4f,
		color: vec4f,
	}

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) color: vec4f,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(1) @binding(0) var<uniform> plane: Plane;

	@vertex fn vs(@builtin(vertex_index) v: u32) -> VSOutput {
		let corners = array<vec2f, 6>(
			vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
			vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
		);
		let off = corners[v] * plane.params.w;
		let world = vec3f(
			plane.params.x + off.x,
			plane.params.y,
			plane.params.z + off.y,
		);
		var out: VSOutput;
		out.position = uni.matrix * vec4f(world, 1.0);
		out.color = plane.color;
		return out;
	}

	@fragment fn fs(inp: VSOutput) -> @location(0) vec4f {
		// Premultiplied output to match the one / one-minus-src-alpha blend.
		let a = inp.color.a;
		return vec4f(inp.color.rgb * a, a);
	}
`;

export default VoidFloorShader;
