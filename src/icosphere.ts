/** Procedural icosphere mesh generation. */

export interface MeshData {
	/** Interleaved vertex data: position(3f) + normal(3f) + uv(2f) = 8 floats per vertex */
	vertices: Float32Array<ArrayBuffer>;
	vertexCount: number;
}

/**
 * Generate a unit icosphere (radius 1, centered at origin) by subdividing an
 * icosahedron and projecting midpoints onto the unit sphere.
 *
 * Returns a non-indexed triangle list with per-vertex position, normal, and
 * spherical UVs. UV seam at u=0/1 is handled per-triangle so tiling textures
 * render correctly.
 *
 * Subdivision 0 = 20 tris, 1 = 80, 2 = 320, 3 = 1280.
 */
export function createIcosphere(subdivisions = 2): MeshData {
	const t = (1 + Math.sqrt(5)) / 2;
	const len = Math.sqrt(1 + t * t);
	const a = 1 / len;
	const b = t / len;

	// 12 icosahedron vertices, pre-normalized to unit sphere
	const positions: number[] = [
		-a,
		b,
		0,
		a,
		b,
		0,
		-a,
		-b,
		0,
		a,
		-b,
		0,
		0,
		-a,
		b,
		0,
		a,
		b,
		0,
		-a,
		-b,
		0,
		a,
		-b,
		b,
		0,
		-a,
		b,
		0,
		a,
		-b,
		0,
		-a,
		-b,
		0,
		a,
	];

	// 20 triangular faces (CCW winding, outward-facing)
	let indices: number[] = [
		0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11,
		10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
		4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
	];

	for (let s = 0; s < subdivisions; s++) {
		const midCache = new Map<number, number>();
		const newIndices: number[] = [];
		// Max vertex index after this pass won't exceed 65535 for subdivisions <= 5
		const stride = positions.length / 3 + indices.length; // generous upper bound for key

		function midpoint(i1: number, i2: number): number {
			const lo = Math.min(i1, i2);
			const hi = Math.max(i1, i2);
			const key = lo * stride + hi;
			const cached = midCache.get(key);
			if (cached !== undefined) return cached;

			const x = (positions[i1 * 3] + positions[i2 * 3]) / 2;
			const y = (positions[i1 * 3 + 1] + positions[i2 * 3 + 1]) / 2;
			const z = (positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 2;
			const n = Math.sqrt(x * x + y * y + z * z);
			const idx = positions.length / 3;
			positions.push(x / n, y / n, z / n);
			midCache.set(key, idx);
			return idx;
		}

		for (let i = 0; i < indices.length; i += 3) {
			const v0 = indices[i];
			const v1 = indices[i + 1];
			const v2 = indices[i + 2];
			const m01 = midpoint(v0, v1);
			const m12 = midpoint(v1, v2);
			const m20 = midpoint(v2, v0);
			newIndices.push(
				v0,
				m01,
				m20,
				v1,
				m12,
				m01,
				v2,
				m20,
				m12,
				m01,
				m12,
				m20,
			);
		}
		indices = newIndices;
	}

	// Build non-indexed triangle list with UV seam handling
	const TWO_PI = 2 * Math.PI;
	const triCount = indices.length / 3;
	const vertexCount = triCount * 3;
	const vertices = new Float32Array(vertexCount * 8);

	for (let tri = 0; tri < triCount; tri++) {
		const i0 = indices[tri * 3];
		const i1 = indices[tri * 3 + 1];
		const i2 = indices[tri * 3 + 2];

		const px0 = positions[i0 * 3],
			py0 = positions[i0 * 3 + 1],
			pz0 = positions[i0 * 3 + 2];
		const px1 = positions[i1 * 3],
			py1 = positions[i1 * 3 + 1],
			pz1 = positions[i1 * 3 + 2];
		const px2 = positions[i2 * 3],
			py2 = positions[i2 * 3 + 1],
			pz2 = positions[i2 * 3 + 2];

		// Spherical UV mapping
		let u0 = Math.atan2(pz0, px0) / TWO_PI + 0.5;
		let u1 = Math.atan2(pz1, px1) / TWO_PI + 0.5;
		let u2 = Math.atan2(pz2, px2) / TWO_PI + 0.5;
		const v0 = Math.asin(Math.max(-1, Math.min(1, py0))) / Math.PI + 0.5;
		const v1 = Math.asin(Math.max(-1, Math.min(1, py1))) / Math.PI + 0.5;
		const v2 = Math.asin(Math.max(-1, Math.min(1, py2))) / Math.PI + 0.5;

		// Fix UV seam: triangles crossing the u=0/1 boundary
		const maxU = Math.max(u0, u1, u2);
		const minU = Math.min(u0, u1, u2);
		if (maxU - minU > 0.5) {
			if (u0 < 0.25) u0 += 1;
			if (u1 < 0.25) u1 += 1;
			if (u2 < 0.25) u2 += 1;
		}

		const base = tri * 24; // 3 verts * 8 floats
		// Vertex 0
		vertices[base] = px0;
		vertices[base + 1] = py0;
		vertices[base + 2] = pz0;
		vertices[base + 3] = px0;
		vertices[base + 4] = py0;
		vertices[base + 5] = pz0; // normal = position for unit sphere
		vertices[base + 6] = u0;
		vertices[base + 7] = v0;
		// Vertex 1
		vertices[base + 8] = px1;
		vertices[base + 9] = py1;
		vertices[base + 10] = pz1;
		vertices[base + 11] = px1;
		vertices[base + 12] = py1;
		vertices[base + 13] = pz1;
		vertices[base + 14] = u1;
		vertices[base + 15] = v1;
		// Vertex 2
		vertices[base + 16] = px2;
		vertices[base + 17] = py2;
		vertices[base + 18] = pz2;
		vertices[base + 19] = px2;
		vertices[base + 20] = py2;
		vertices[base + 21] = pz2;
		vertices[base + 22] = u2;
		vertices[base + 23] = v2;
	}

	return { vertices, vertexCount };
}
