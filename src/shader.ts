const MainShader = /*wgsl*/ `
	struct Uniforms {
		matrix: mat4x4f,
	}

	struct Vertex {
		@location(0) position: vec4f,
		@location(1) color: vec4f,
	}

	struct VSOutput {
		@builtin(position) position: vec4f,
		@location(0) color: vec4f,
	}

	@group(0) @binding(0) var<uniform> uni: Uniforms;
	@group(0) @binding(1) var<storage, read> positions: array<f32>;
	@group(0) @binding(2) var<storage, read> indices: array<u32>;

	@vertex fn vs(vert: Vertex) -> VSOutput {
		var vsOut: VSOutput;
		vsOut.position = uni.matrix * vert.position;
		vsOut.color = vert.color;
		return vsOut;
	}

	@fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
		return vsOut.color;
	}



	struct BarycentricCoordinateBasedVSOutput {
		@builtin(position) position: vec4f,
		@location(0) barycenticCoord: vec3f,
	};

	@vertex fn vsIndexedU32BarycentricCoordinateBasedLines(
  		@builtin(vertex_index) vNdx: u32
	) -> BarycentricCoordinateBasedVSOutput {
		let vertNdx = vNdx % 3;
		let index = indices[vNdx];

		// note:
		//
		// * if your indices are U16 you could use this
		//
		//    let twoIndices = indices[vNdx / 2];  // indices is u32 but we want u16
		//    let index = (twoIndices >> ((vNdx & 1) * 16)) & 0xFFFF;
		//
		// * if you're not using indices you could use this
		//
		//    let index = vNdx;

		let pNdx = index * 4;
		let position = vec4f(positions[pNdx], positions[pNdx + 1], positions[pNdx + 2], 1);

		var vsOut: BarycentricCoordinateBasedVSOutput;
		vsOut.position = uni.matrix * position;

		// emit a barycentric coordinate
		vsOut.barycenticCoord = vec3f(0);
		vsOut.barycenticCoord[vertNdx] = 1.0;
		return vsOut;
	}

	fn edgeFactor(bary: vec3f) -> f32 {
		let d = fwidth(bary);
		let lineThickness = 1.0;
		let a3 = smoothstep(vec3f(0.0), d * lineThickness, bary);
		return min(min(a3.x, a3.y), a3.z);
	}

	@fragment fn fsBarycentricCoordinateBasedLines(
		v: BarycentricCoordinateBasedVSOutput
	) -> @location(0) vec4f {
		let lineAlphaThreshold = 0.5;
		let a = 1.0 - edgeFactor(v.barycenticCoord);
		if (a < lineAlphaThreshold) {
			discard;
		}

		return vec4(1,1,1,a);
	}
`;

export default MainShader;
