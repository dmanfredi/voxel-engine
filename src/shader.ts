const MainShader = /*wgsl*/ `
	struct Uniforms {
		matrix: mat4x4f,
		bevelSize: f32,
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
		@location(4) worldPos: vec3f,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(0) @binding(1) var mySampler: sampler;
	@group(0) @binding(2) var myTexture: texture_2d_array<f32>;
	@group(0) @binding(3) var voxelMap: texture_3d<u32>;

	const BLOCK_SIZE: f32 = 10.0;

	fn isVoxelSolid(pos: vec3i) -> bool {
		// Out-of-bounds textureLoad returns 0 (air) per WebGPU spec
		let val = textureLoad(voxelMap, pos, 0);
		return val.r > 0u;
	}

	fn bevelNormal(worldPos: vec3f, normal: vec3f) -> vec3f {
		let bevelFrac = uni.bevelSize / BLOCK_SIZE;

		// No bevel when size is zero (toggle off)
		if (bevelFrac <= 0.0) {
			return normal;
		}

		// Offset inward along normal so faces on block boundaries
		// resolve to the correct block
		let blockPos = vec3i(floor((worldPos - normal * 0.5) / BLOCK_SIZE));
		let blockFrac = fract(worldPos / BLOCK_SIZE);
		var result = normal;
		let absN = abs(normal);

		// For each in-plane axis, check edge proximity.
		// Only apply bevel if the neighbor block in that direction is air
		// (exposed edge). Solid neighbors = internal edge, no bevel.
		if (absN.x < 0.5) {
			let d = min(blockFrac.x, 1.0 - blockFrac.x);
			let t = smoothstep(bevelFrac, 0.0, d);
			if (t > 0.0) {
				let edgeDir = select(1, -1, blockFrac.x < 0.5);
				if (!isVoxelSolid(blockPos + vec3i(edgeDir, 0, 0))) {
					result.x += f32(edgeDir) * t;
				}
			}
		}
		if (absN.y < 0.5) {
			let d = min(blockFrac.y, 1.0 - blockFrac.y);
			let t = smoothstep(bevelFrac, 0.0, d);
			if (t > 0.0) {
				let edgeDir = select(1, -1, blockFrac.y < 0.5);
				if (!isVoxelSolid(blockPos + vec3i(0, edgeDir, 0))) {
					result.y += f32(edgeDir) * t;
				}
			}
		}
		if (absN.z < 0.5) {
			let d = min(blockFrac.z, 1.0 - blockFrac.z);
			let t = smoothstep(bevelFrac, 0.0, d);
			if (t > 0.0) {
				let edgeDir = select(1, -1, blockFrac.z < 0.5);
				if (!isVoxelSolid(blockPos + vec3i(0, 0, edgeDir))) {
					result.z += f32(edgeDir) * t;
				}
			}
		}

		return normalize(result);
	}

	@vertex fn vs(vert: Vertex) -> VSOutput {
		var vsOut: VSOutput;
		vsOut.position = uni.matrix * vert.position;
		vsOut.uv = vert.uv;
		vsOut.texLayer = vert.texLayer;
		vsOut.normal = vert.normal;
		vsOut.ao = vert.ao;
		vsOut.worldPos = vert.position.xyz;
		return vsOut;
	}

	@fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
		let texColor = textureSample(myTexture, mySampler, vsOut.uv, vsOut.texLayer);

		// Compute beveled normal from world position
		let n = bevelNormal(vsOut.worldPos, vsOut.normal);

		// Per-face shading: top brightest, sides medium, bottom darkest
		// Smooth interpolation supports bevel normals while giving
		// identical results for axis-aligned normals.
		let a = abs(n);
		let yBright = select(0.5, 1.0, n.y >= 0.0);
		let brightness = (a.x * 0.6 + a.y * yBright + a.z * 0.8) / max(a.x + a.y + a.z, 0.001);

		// a nice blue vec3f(0.49, 0.55, 0.68)
		let shadowColor = vec3f(0.1, 0.1, 0.1); // AO shadow tint
		let lit = texColor.rgb * brightness;
		return vec4f(mix(shadowColor, lit, vsOut.ao), texColor.a);
	}
`;

export default MainShader;
