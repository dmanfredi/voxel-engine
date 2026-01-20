import type Block from './Block';
import { NOTHING } from './Block';

export interface GreedyMeshResult {
	vertexData: Float32Array<ArrayBuffer>;
	numVertices: number;
}

/**
 * Greedy meshing algorithm for voxel chunks.
 *
 * Claude wrote 90% of this.
 *
 * Takes a 3D array of blocks and produces an optimized mesh by:
 * 1. Culling interior faces (faces between two solid blocks)
 * 2. Merging adjacent coplanar faces into larger quads
 *
 * @param blocks - 3D array indexed as [y][z][x]
 * @param dims - Dimensions [x, y, z]
 * @param blockSize - Size of each block in world units
 */
export function greedyMesh(
	blocks: Block[][][],
	dims: [number, number, number],
	blockSize: number,
): GreedyMeshResult {
	const [dimX, dimY, dimZ] = dims;

	// Helper to get block at position, returns null for out-of-bounds (treated as air)
	function getBlock(x: number, y: number, z: number): Block | null {
		if (x < 0 || x >= dimX || y < 0 || y >= dimY || z < 0 || z >= dimZ) {
			return null;
		}
		return blocks[y]?.[z]?.[x] ?? null;
	}

	function isSolid(block: Block | null): boolean {
		return block !== null && block.type !== NOTHING;
	}

	// Collect all quads, then convert to vertices at the end
	const quads: {
		// 4 corners in world coordinates
		v0: [number, number, number];
		v1: [number, number, number];
		v2: [number, number, number];
		v3: [number, number, number];
		// UV dimensions for tiling
		uvWidth: number;
		uvHeight: number;
	}[] = [];

	// Dimension lookup helper - returns dimension for axis 0, 1, or 2
	const getDim = (axis: number): number => {
		if (axis === 0) return dimX;
		if (axis === 1) return dimY;
		return dimZ;
	};

	// Sweep over 3 axes
	for (let axis = 0; axis < 3; axis++) {
		// u and v are the two axes perpendicular to the sweep axis
		const u = (axis + 1) % 3;
		const v = (axis + 2) % 3;

		// Dimension sizes along each axis
		const axisDim = getDim(axis);
		const uDim = getDim(u);
		const vDim = getDim(v);

		// x is our position vector, q is the step vector along the sweep axis
		const x: [number, number, number] = [0, 0, 0];
		const q: [number, number, number] = [0, 0, 0];
		q[axis] = 1;

		// Mask stores face info: 0 = no face, positive = face pointing +axis, negative = face pointing -axis
		// The absolute value could store block type ID for multi-material support
		const mask = new Int32Array(uDim * vDim);

		// Sweep through slices perpendicular to the axis
		// We go from -1 to axisDim-1 to catch boundary faces
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		for (x[axis] = -1; x[axis]! < axisDim; ) {
			// Build the mask for this slice
			let n = 0;
			for (x[v] = 0; x[v] < vDim; x[v]++) {
				for (x[u] = 0; x[u] < uDim; x[u]++) {
					// Get blocks on either side of this potential face
					const blockA = getBlock(x[0], x[1], x[2]);
					const blockB = getBlock(
						x[0] + q[0],
						x[1] + q[1],
						x[2] + q[2],
					);

					const solidA = isSolid(blockA);
					const solidB = isSolid(blockB);

					if (solidA === solidB) {
						// Both solid or both air - no face needed
						mask[n] = 0;
					} else if (solidA) {
						// Face pointing in positive axis direction
						mask[n] = 1;
					} else {
						// Face pointing in negative axis direction
						mask[n] = -1;
					}
					n++;
				}
			}

			// Move to the next slice position (the face position in world coords)
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			x[axis]!++;

			// Now greedy merge the mask into rectangles
			n = 0;
			for (let j = 0; j < vDim; j++) {
				for (let i = 0; i < uDim; ) {
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					const maskVal = mask[n]!;

					if (maskVal !== 0) {
						// Found a face - find the largest rectangle starting here

						// Compute width (extend along u-axis)
						let w = 1;
						while (i + w < uDim && mask[n + w] === maskVal) {
							w++;
						}

						// Compute height (extend along v-axis)
						let h = 1;
						let done = false;
						while (j + h < vDim && !done) {
							// Check if entire row of width w matches
							for (let k = 0; k < w; k++) {
								if (mask[n + k + h * uDim] !== maskVal) {
									done = true;
									break;
								}
							}
							if (!done) h++;
						}

						// Create the quad
						// Position in the slice plane
						x[u] = i;
						x[v] = j;

						// du and dv are the extent vectors in 3D
						const du: [number, number, number] = [0, 0, 0];
						const dv: [number, number, number] = [0, 0, 0];
						du[u] = w;
						dv[v] = h;

						// Convert to world coordinates
						const wx = x[0] * blockSize;
						const wy = x[1] * blockSize;
						const wz = x[2] * blockSize;

						const dux = du[0] * blockSize;
						const duy = du[1] * blockSize;
						const duz = du[2] * blockSize;

						const dvx = dv[0] * blockSize;
						const dvy = dv[1] * blockSize;
						const dvz = dv[2] * blockSize;

						// Four corners of the quad
						// Winding order depends on face direction for correct backface culling
						if (maskVal > 0) {
							// Positive direction face - counterclockwise when viewed from outside
							quads.push({
								v0: [wx, wy, wz],
								v1: [wx + dux, wy + duy, wz + duz],
								v2: [
									wx + dux + dvx,
									wy + duy + dvy,
									wz + duz + dvz,
								],
								v3: [wx + dvx, wy + dvy, wz + dvz],
								uvWidth: w,
								uvHeight: h,
							});
						} else {
							// Negative direction face - flip winding
							quads.push({
								v0: [wx, wy, wz],
								v3: [wx + dux, wy + duy, wz + duz],
								v2: [
									wx + dux + dvx,
									wy + duy + dvy,
									wz + duz + dvz,
								],
								v1: [wx + dvx, wy + dvy, wz + dvz],
								uvWidth: w,
								uvHeight: h,
							});
						}

						// Zero out the mask cells we just used
						for (let l = 0; l < h; l++) {
							for (let k = 0; k < w; k++) {
								mask[n + k + l * uDim] = 0;
							}
						}

						// Advance by the width of the quad we just created
						i += w;
						n += w;
					} else {
						// No face here, move to next cell
						i++;
						n++;
					}
				}
			}
		}
	}

	// Convert quads to vertex data
	// Each quad = 2 triangles = 6 vertices
	// Each vertex: position (3) + uv (2) + color (1 as uint32) = 6 floats
	const numVertices = quads.length * 6;
	const vertexData = new Float32Array(numVertices * 6);
	const colorData = new Uint8Array(vertexData.buffer);

	// Default color (will be replaced by texture sampling anyway)
	const color: [number, number, number] = [200, 150, 100];

	let vertexOffset = 0;
	for (const quad of quads) {
		// Two triangles: (v0, v1, v2) and (v0, v2, v3)
		// UVs are tiled based on quad dimensions
		const uv0: [number, number] = [0, quad.uvHeight];
		const uv1: [number, number] = [quad.uvWidth, quad.uvHeight];
		const uv2: [number, number] = [quad.uvWidth, 0];
		const uv3: [number, number] = [0, 0];

		// Triangle 1: v0, v1, v2
		// Triangle 2: v0, v2, v3
		const triangleData: {
			pos: [number, number, number];
			uv: [number, number];
		}[] = [
			{ pos: quad.v0, uv: uv0 },
			{ pos: quad.v1, uv: uv1 },
			{ pos: quad.v2, uv: uv2 },
			{ pos: quad.v0, uv: uv0 },
			{ pos: quad.v2, uv: uv2 },
			{ pos: quad.v3, uv: uv3 },
		];

		for (const { pos, uv } of triangleData) {
			// Position
			vertexData[vertexOffset * 6 + 0] = pos[0];
			vertexData[vertexOffset * 6 + 1] = pos[1];
			vertexData[vertexOffset * 6 + 2] = pos[2];

			// UV (tiled)
			vertexData[vertexOffset * 6 + 3] = uv[0];
			vertexData[vertexOffset * 6 + 4] = uv[1];

			// Color (RGBA as bytes at the correct offset)
			const byteOffset = vertexOffset * 24 + 20;
			colorData[byteOffset + 0] = color[0];
			colorData[byteOffset + 1] = color[1];
			colorData[byteOffset + 2] = color[2];
			colorData[byteOffset + 3] = 255;

			vertexOffset++;
		}
	}

	return {
		vertexData,
		numVertices,
	};
}
