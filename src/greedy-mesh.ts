import type Block from './Block';
import { NOTHING } from './Block';

export interface GreedyMeshResult {
	vertexData: Float32Array<ArrayBuffer>;
	numVertices: number;
}

type AO = 0 | 1 | 2 | 3;

// AO value (0 = most occluded, 3 = fully lit) → brightness multiplier
const AO_CURVE: readonly [number, number, number, number] = [
	0.2, 0.45, 0.7, 1.0,
];

/**
 * Computes ambient occlusion for a single vertex of a face.
 * side1/side2 are the two edge-adjacent neighbors, corner is the diagonal.
 * Returns 0 (fully occluded) to 3 (fully lit).
 */
function vertexAO(side1: boolean, side2: boolean, corner: boolean): AO {
	if (side1 && side2) return 0;
	return (3 - (Number(side1) + Number(side2) + Number(corner))) as AO;
}

/**
 * Greedy meshing algorithm for voxel chunks with per-vertex ambient occlusion.
 *
 * Claude wrote 90% of this.
 *
 * Takes a 3D array of blocks and produces an optimized mesh by:
 * 1. Culling interior faces (faces between two solid blocks)
 * 2. Computing per-vertex AO for each face
 * 3. Merging adjacent coplanar faces with identical AO patterns
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

	/**
	 * Compute AO for all 4 corners of a face.
	 * faceU/faceV: block position in the face plane
	 * airD: axis position on the air side of the face
	 * axisIdx/uIdx/vIdx: which axes map to axis/u/v
	 */
	function computeFaceAO(
		faceU: number,
		faceV: number,
		airD: number,
		axisIdx: number,
		uIdx: number,
		vIdx: number,
	): [AO, AO, AO, AO] {
		// Corner signs: direction away from face center for each corner
		// v0 (u-low, v-low), v1 (u-high, v-low), v2 (u-high, v-high), v3 (u-low, v-high)
		const signs: [number, number][] = [
			[-1, -1],
			[1, -1],
			[1, 1],
			[-1, 1],
		];

		const ao: [AO, AO, AO, AO] = [0, 0, 0, 0];

		for (let c = 0; c < 4; c++) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const [su, sv] = signs[c]!;

			// Side 1: neighbor along u-axis
			const s1: [number, number, number] = [0, 0, 0];
			s1[axisIdx] = airD;
			s1[uIdx] = faceU + su;
			s1[vIdx] = faceV;

			// Side 2: neighbor along v-axis
			const s2: [number, number, number] = [0, 0, 0];
			s2[axisIdx] = airD;
			s2[uIdx] = faceU;
			s2[vIdx] = faceV + sv;

			// Corner: diagonal neighbor
			const cr: [number, number, number] = [0, 0, 0];
			cr[axisIdx] = airD;
			cr[uIdx] = faceU + su;
			cr[vIdx] = faceV + sv;

			ao[c] = vertexAO(
				isSolid(getBlock(s1[0], s1[1], s1[2])),
				isSolid(getBlock(s2[0], s2[1], s2[2])),
				isSolid(getBlock(cr[0], cr[1], cr[2])),
			);
		}

		return ao;
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
		// Face direction: true = positive axis, false = negative axis
		positiveFacing: boolean;
		// Which axis this face is perpendicular to (0=X, 1=Y, 2=Z)
		axis: number;
		// Per-corner AO values (0-3), matching v0-v3
		ao: [AO, AO, AO, AO];
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

		// Mask stores encoded face info:
		// 0 = no face
		// For faces: direction * (1 + aoPacked)
		// where aoPacked = ao0 | (ao1 << 2) | (ao2 << 4) | (ao3 << 6)
		// This way, two faces merge only if they have the same direction AND AO pattern.
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
					} else {
						const positive = solidA;
						// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
						const airD = positive ? x[axis]! + 1 : x[axis]!;
						const ao = computeFaceAO(
							x[u],
							x[v],
							airD,
							axis,
							u,
							v,
						);
						const aoPacked =
							ao[0] | (ao[1] << 2) | (ao[2] << 4) | (ao[3] << 6);
						mask[n] = (positive ? 1 : -1) * (1 + aoPacked);
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
						// Faces with different AO patterns have different maskVals,
						// so they won't merge (conservative AO-aware merging).

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

						// Unpack AO from mask value
						const absMask = Math.abs(maskVal);
						const aoPacked = absMask - 1;
						const ao0 = (aoPacked & 3) as AO;
						const ao1 = ((aoPacked >> 2) & 3) as AO;
						const ao2 = ((aoPacked >> 4) & 3) as AO;
						const ao3 = ((aoPacked >> 6) & 3) as AO;

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

						// Four corners of the quad (consistent vertex positions)
						// v0 = origin, v1 = origin + du, v2 = origin + du + dv, v3 = origin + dv
						// Winding order is handled during triangle generation based on positiveFacing
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
							positiveFacing: maskVal > 0,
							axis,
							ao: [ao0, ao1, ao2, ao3],
						});

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
	// Each vertex: position (3) + normal (3) + uv (2) + ao (1) + color (1 as uint32) = 10 floats
	const FLOATS_PER_VERTEX = 10;
	const BYTES_PER_VERTEX = FLOATS_PER_VERTEX * 4; // 40
	const numVertices = quads.length * 6;
	const vertexData = new Float32Array(numVertices * FLOATS_PER_VERTEX);
	const colorData = new Uint8Array(vertexData.buffer);

	// Default color (will be replaced by texture sampling anyway)
	const color: [number, number, number] = [200, 150, 100];

	let vertexOffset = 0;
	for (const quad of quads) {
		// Compute face normal from axis and facing direction
		const normal: [number, number, number] = [0, 0, 0];
		normal[quad.axis] = quad.positiveFacing ? 1 : -1;

		// Per-corner AO as floats (via curve lookup)
		const aoF0 = AO_CURVE[quad.ao[0]];
		const aoF1 = AO_CURVE[quad.ao[1]];
		const aoF2 = AO_CURVE[quad.ao[2]];
		const aoF3 = AO_CURVE[quad.ao[3]];

		// UVs are tiled based on quad dimensions
		let uv0: [number, number];
		let uv1: [number, number];
		let uv2: [number, number];
		let uv3: [number, number];

		if (quad.axis === 0) {
			// X-facing: rotate UVs so Y maps to texture vertical
			uv0 = [0, quad.uvWidth];
			uv1 = [0, 0];
			uv2 = [quad.uvHeight, 0];
			uv3 = [quad.uvHeight, quad.uvWidth];
		} else {
			// Default UV mapping for axis 1 and 2
			uv0 = [0, quad.uvHeight];
			uv1 = [quad.uvWidth, quad.uvHeight];
			uv2 = [quad.uvWidth, 0];
			uv3 = [0, 0];
		}

		// Quad triangulation flip (anisotropy fix):
		// When AO differs on opposite corners, flip the split diagonal
		// to avoid interpolation artifacts.
		const flipDiag = quad.ao[0] + quad.ao[2] > quad.ao[1] + quad.ao[3];

		// Two triangles with winding order based on face direction
		// Normal diagonal: v0-v2 split → (v0,v1,v2), (v0,v2,v3)
		// Flipped diagonal: v1-v3 split → (v0,v1,v3), (v1,v2,v3)
		const triangleData: {
			pos: [number, number, number];
			uv: [number, number];
			ao: number;
		}[] = (() => {
			if (quad.positiveFacing) {
				if (flipDiag) {
					return [
						{ pos: quad.v0, uv: uv0, ao: aoF0 },
						{ pos: quad.v1, uv: uv1, ao: aoF1 },
						{ pos: quad.v3, uv: uv3, ao: aoF3 },
						{ pos: quad.v1, uv: uv1, ao: aoF1 },
						{ pos: quad.v2, uv: uv2, ao: aoF2 },
						{ pos: quad.v3, uv: uv3, ao: aoF3 },
					];
				}
				return [
					{ pos: quad.v0, uv: uv0, ao: aoF0 },
					{ pos: quad.v1, uv: uv1, ao: aoF1 },
					{ pos: quad.v2, uv: uv2, ao: aoF2 },
					{ pos: quad.v0, uv: uv0, ao: aoF0 },
					{ pos: quad.v2, uv: uv2, ao: aoF2 },
					{ pos: quad.v3, uv: uv3, ao: aoF3 },
				];
			}
			if (flipDiag) {
				return [
					{ pos: quad.v0, uv: uv0, ao: aoF0 },
					{ pos: quad.v3, uv: uv3, ao: aoF3 },
					{ pos: quad.v1, uv: uv1, ao: aoF1 },
					{ pos: quad.v1, uv: uv1, ao: aoF1 },
					{ pos: quad.v3, uv: uv3, ao: aoF3 },
					{ pos: quad.v2, uv: uv2, ao: aoF2 },
				];
			}
			return [
				{ pos: quad.v0, uv: uv0, ao: aoF0 },
				{ pos: quad.v2, uv: uv2, ao: aoF2 },
				{ pos: quad.v1, uv: uv1, ao: aoF1 },
				{ pos: quad.v0, uv: uv0, ao: aoF0 },
				{ pos: quad.v3, uv: uv3, ao: aoF3 },
				{ pos: quad.v2, uv: uv2, ao: aoF2 },
			];
		})();

		for (const vert of triangleData) {
			const base = vertexOffset * FLOATS_PER_VERTEX;

			// Position
			vertexData[base + 0] = vert.pos[0];
			vertexData[base + 1] = vert.pos[1];
			vertexData[base + 2] = vert.pos[2];

			// Normal
			vertexData[base + 3] = normal[0];
			vertexData[base + 4] = normal[1];
			vertexData[base + 5] = normal[2];

			// UV (tiled)
			vertexData[base + 6] = vert.uv[0];
			vertexData[base + 7] = vert.uv[1];

			// AO
			vertexData[base + 8] = vert.ao;

			// Color (RGBA as bytes at the correct offset)
			const byteOffset = vertexOffset * BYTES_PER_VERTEX + 36;
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
