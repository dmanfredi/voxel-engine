import { type BlockId, AIR, blockRegistry } from './block';
import { CHUNK_SIZE } from './chunk';
import type { GreedyMeshResult } from './greedy-mesh';
import type { World } from './world';

type AO = 0 | 1 | 2 | 3;

const AO_CURVE: readonly [number, number, number, number] = [
	0.2, 0.45, 0.7, 1.0,
];

const CHUNK_SHIFT = 5;
const CHUNK_MASK = CHUNK_SIZE - 1;
const FLOATS_PER_VERTEX = 10;
interface FaceFold {
	corner: number;
	shoulderToPrev: [number, number, number];
	shoulderToNext: [number, number, number];
	foldPoint: [number, number, number];
}
interface FaceCornerData {
	pos: [number, number, number];
	ao: number;
}
const MAX_VERTS_PER_SURFACE_BLOCK = 1348; // face folds + chamfers + corner caps + crude concave plugs

// Face directions indexed 0-5: +X, -X, +Y, -Y, +Z, -Z
const FACE_DIRS: readonly (readonly [number, number, number])[] = [
	[1, 0, 0],
	[-1, 0, 0],
	[0, 1, 0],
	[0, -1, 0],
	[0, 0, 1],
	[0, 0, -1],
];

function faceAxis(f: number): number {
	return f >> 1;
}
function faceDir(f: number): number {
	return (f & 1) === 0 ? 1 : -1;
}
function faceIndex(axis: number, dir: number): number {
	return axis * 2 + (dir < 0 ? 1 : 0);
}
function cornerIdx(uMax: boolean, vMax: boolean): number {
	return uMax ? (vMax ? 2 : 1) : vMax ? 3 : 0;
}

// 12 unique edges as [faceA, faceB] pairs (A < B)
const EDGE_PAIRS: readonly (readonly [number, number])[] = [
	[0, 2],
	[0, 3],
	[0, 4],
	[0, 5], // +X with ±Y, ±Z
	[1, 2],
	[1, 3],
	[1, 4],
	[1, 5], // -X with ±Y, ±Z
	[2, 4],
	[2, 5],
	[3, 4],
	[3, 5], // ±Y with ±Z
];

// 8 corners as [faceA, faceB, faceC] — one per octant
const CORNER_FACES: readonly (readonly [number, number, number])[] = [
	[0, 2, 4],
	[0, 2, 5],
	[0, 3, 4],
	[0, 3, 5],
	[1, 2, 4],
	[1, 2, 5],
	[1, 3, 4],
	[1, 3, 5],
];

function vertexAO(side1: boolean, side2: boolean, corner: boolean): AO {
	if (side1 && side2) return 0;
	return (3 - (Number(side1) + Number(side2) + Number(corner))) as AO;
}

/**
 * Returns the 2 corner indices of face `fA` that lie on the edge shared
 * with face `fB`, sorted by position along the edge axis.
 */
function getEdgeCorners(fA: number, fB: number): [number, number] {
	const aA = faceAxis(fA);
	const aB = faceAxis(fB);
	const dB = faceDir(fB);
	const uA = (aA + 1) % 3;

	if (aB === uA) {
		// Edge runs along vA
		return dB > 0 ? [1, 2] : [0, 3];
	}
	// Edge runs along uA
	return dB > 0 ? [3, 2] : [0, 1];
}

/**
 * Returns the single corner index of `face` that sits at the block corner
 * defined by the intersection of all three faces.
 */
function getCornerVertexIndex(
	face: number,
	other1: number,
	other2: number,
): number {
	const a = faceAxis(face);
	const u = (a + 1) % 3;
	const a1 = faceAxis(other1);
	const d1 = faceDir(other1);
	const d2 = faceDir(other2);

	if (a1 === u) {
		return cornerIdx(d1 > 0, d2 > 0);
	}
	return cornerIdx(d2 > 0, d1 > 0);
}

export function bevelMesh(
	world: World,
	cx: number,
	cy: number,
	cz: number,
	bevelSize: number,
): GreedyMeshResult {
	const S = world.blockSize;
	const b = bevelSize;

	const ox = cx * CHUNK_SIZE;
	const oy = cy * CHUNK_SIZE;
	const oz = cz * CHUNK_SIZE;

	const chunk = world.getChunk(cx, cy, cz);
	if (!chunk) {
		return { vertexData: new Float32Array(0), numVertices: 0 };
	}
	const blocks = chunk.blocks;

	function getBlockFast(lx: number, ly: number, lz: number): BlockId {
		if (((lx | ly | lz) & ~CHUNK_MASK) === 0) {
			return (
				blocks[(ly << (CHUNK_SHIFT * 2)) + (lz << CHUNK_SHIFT) + lx] ??
				AIR
			);
		}
		return world.getBlock(ox + lx, oy + ly, oz + lz);
	}

	function isSolidFast(lx: number, ly: number, lz: number): boolean {
		return blockRegistry.isSolid(getBlockFast(lx, ly, lz));
	}

	// Count surface blocks for buffer allocation
	let surfaceCount = 0;
	for (let ly = 0; ly < CHUNK_SIZE; ly++) {
		for (let lz = 0; lz < CHUNK_SIZE; lz++) {
			for (let lx = 0; lx < CHUNK_SIZE; lx++) {
				const id =
					blocks[
						(ly << (CHUNK_SHIFT * 2)) + (lz << CHUNK_SHIFT) + lx
					];
				if (id === undefined || id === AIR) continue;
				if (
					!isSolidFast(lx + 1, ly, lz) ||
					!isSolidFast(lx - 1, ly, lz) ||
					!isSolidFast(lx, ly + 1, lz) ||
					!isSolidFast(lx, ly - 1, lz) ||
					!isSolidFast(lx, ly, lz + 1) ||
					!isSolidFast(lx, ly, lz - 1)
				) {
					surfaceCount++;
				}
			}
		}
	}

	if (surfaceCount === 0) {
		return { vertexData: new Float32Array(0), numVertices: 0 };
	}

	const vertexData = new Float32Array(
		surfaceCount * MAX_VERTS_PER_SURFACE_BLOCK * FLOATS_PER_VERTEX,
	);
	const uint32View = new Uint32Array(vertexData.buffer);
	let vOffset = 0;

	function writeVertex(
		pos: readonly [number, number, number],
		normal: readonly [number, number, number],
		uv: readonly [number, number],
		ao: number,
		texLayer: number,
	): void {
		const i = vOffset * FLOATS_PER_VERTEX;
		vertexData[i] = pos[0];
		vertexData[i + 1] = pos[1];
		vertexData[i + 2] = pos[2];
		vertexData[i + 3] = normal[0];
		vertexData[i + 4] = normal[1];
		vertexData[i + 5] = normal[2];
		vertexData[i + 6] = uv[0];
		vertexData[i + 7] = uv[1];
		vertexData[i + 8] = ao;
		uint32View[i + 9] = texLayer;
		vOffset++;
	}

	function writeTriangle(
		p0: readonly [number, number, number],
		p1: readonly [number, number, number],
		p2: readonly [number, number, number],
		normal: readonly [number, number, number],
		uv0: readonly [number, number],
		uv1: readonly [number, number],
		uv2: readonly [number, number],
		ao0: number,
		ao1: number,
		ao2: number,
		texLayer: number,
	): void {
		const e1x = p1[0] - p0[0];
		const e1y = p1[1] - p0[1];
		const e1z = p1[2] - p0[2];
		const e2x = p2[0] - p0[0];
		const e2y = p2[1] - p0[1];
		const e2z = p2[2] - p0[2];
		const cx = e1y * e2z - e1z * e2y;
		const cy = e1z * e2x - e1x * e2z;
		const cz = e1x * e2y - e1y * e2x;
		const dot = cx * normal[0] + cy * normal[1] + cz * normal[2];

		if (dot > 0) {
			writeVertex(p0, normal, uv0, ao0, texLayer);
			writeVertex(p1, normal, uv1, ao1, texLayer);
			writeVertex(p2, normal, uv2, ao2, texLayer);
		} else {
			writeVertex(p0, normal, uv0, ao0, texLayer);
			writeVertex(p2, normal, uv2, ao2, texLayer);
			writeVertex(p1, normal, uv1, ao1, texLayer);
		}
	}

	function isEdgeBeveledAt(
		lx: number,
		ly: number,
		lz: number,
		fA: number,
		fB: number,
	): boolean {
		if (!isSolidFast(lx, ly, lz)) return false;
		const dA = FACE_DIRS[fA];
		const dB = FACE_DIRS[fB];
		if (!dA || !dB) return false;
		return (
			!isSolidFast(lx + dA[0], ly + dA[1], lz + dA[2]) &&
			!isSolidFast(lx + dB[0], ly + dB[1], lz + dB[2]) &&
			!isSolidFast(
				lx + dA[0] + dB[0],
				ly + dA[1] + dB[1],
				lz + dA[2] + dB[2],
			)
		);
	}

	function compareBlockCoords(
		ax: number,
		ay: number,
		az: number,
		bx: number,
		by: number,
		bz: number,
	): number {
		if (ax !== bx) return ax - bx;
		if (ay !== by) return ay - by;
		return az - bz;
	}

	function oppositeFace(face: number): number {
		return face ^ 1;
	}

	function getFaceCornerData(
		lx: number,
		ly: number,
		lz: number,
		face: number,
		corner: number,
	): FaceCornerData | null {
		if (!isSolidFast(lx, ly, lz)) return null;

		const dFace = FACE_DIRS[face];
		if (!dFace) return null;
		if (isSolidFast(lx + dFace[0], ly + dFace[1], lz + dFace[2])) {
			return null;
		}

		const axis = faceAxis(face);
		const dir = faceDir(face);
		const u = (axis + 1) % 3;
		const v = (axis + 2) % 3;

		const uMinF = faceIndex(u, -1);
		const uMaxF = faceIndex(u, 1);
		const vMinF = faceIndex(v, -1);
		const vMaxF = faceIndex(v, 1);
		const uMinB = isEdgeBeveledAt(lx, ly, lz, face, uMinF);
		const uMaxB = isEdgeBeveledAt(lx, ly, lz, face, uMaxF);
		const vMinB = isEdgeBeveledAt(lx, ly, lz, face, vMinF);
		const vMaxB = isEdgeBeveledAt(lx, ly, lz, face, vMaxF);

		const base: [number, number, number] = [
			(ox + lx) * S,
			(oy + ly) * S,
			(oz + lz) * S,
		];
		const facePos = dir > 0 ? base[axis] + S : base[axis];
		const isUMax = corner === 1 || corner === 2;
		const isVMax = corner === 2 || corner === 3;
		const pos: [number, number, number] = [0, 0, 0];
		pos[axis] = facePos;
		pos[u] = isUMax ? base[u] + S : base[u];
		pos[v] = isVMax ? base[v] + S : base[v];
		if (isUMax && uMaxB) pos[u] -= b;
		if (!isUMax && uMinB) pos[u] += b;
		if (isVMax && vMaxB) pos[v] -= b;
		if (!isVMax && vMinB) pos[v] += b;

		const local: [number, number, number] = [lx, ly, lz];
		const airD = local[axis] + dir;
		const signs = aoSigns[corner];
		if (!signs) return null;
		const su = signs[0];
		const sv = signs[1];

		const s1: [number, number, number] = [0, 0, 0];
		s1[axis] = airD;
		s1[u] = local[u] + su;
		s1[v] = local[v];

		const s2: [number, number, number] = [0, 0, 0];
		s2[axis] = airD;
		s2[u] = local[u];
		s2[v] = local[v] + sv;

		const cr: [number, number, number] = [0, 0, 0];
		cr[axis] = airD;
		cr[u] = local[u] + su;
		cr[v] = local[v] + sv;

		return {
			pos,
			ao: AO_CURVE[
				vertexAO(
					isSolidFast(s1[0], s1[1], s1[2]),
					isSolidFast(s2[0], s2[1], s2[2]),
					isSolidFast(cr[0], cr[1], cr[2]),
				)
			],
		};
	}

	// Reusable arrays to reduce allocations
	const exposed: boolean[] = [false, false, false, false, false, false];
	const edgeBev: boolean[][] = Array.from({ length: 6 }, () =>
		Array.from({ length: 6 }, () => false),
	);
	const faceFolds: FaceFold[][] = Array.from({ length: 6 }, () => []);
	const aoSigns: [number, number][] = [
		[-1, -1],
		[1, -1],
		[1, 1],
		[-1, 1],
	];

	for (let ly = 0; ly < CHUNK_SIZE; ly++) {
		for (let lz = 0; lz < CHUNK_SIZE; lz++) {
			for (let lx = 0; lx < CHUNK_SIZE; lx++) {
				const blockId = getBlockFast(lx, ly, lz);
				if (blockId === AIR) continue;

				const local: [number, number, number] = [lx, ly, lz];
				const base: [number, number, number] = [
					(ox + lx) * S,
					(oy + ly) * S,
					(oz + lz) * S,
				];

				const texScale = blockRegistry.get(blockId)?.textureScale ?? 1;
				const uvDenom = S * texScale;

				// --- Check face exposure ---
				let anyExposed = false;
				for (let f = 0; f < 6; f++) {
					const d = FACE_DIRS[f];
					if (d === undefined) continue;
					exposed[f] = !isSolidFast(lx + d[0], ly + d[1], lz + d[2]);
					if (exposed[f]) anyExposed = true;
				}
				if (!anyExposed) continue;

				// --- Check edge bevels ---
				for (let ei = 0; ei < 6; ei++) {
					for (let ej = 0; ej < 6; ej++) {
						edgeBev[ei][ej] = false;
					}
				}
				for (const pair of EDGE_PAIRS) {
					const fA = pair[0];
					const fB = pair[1];
					if (fA === undefined || fB === undefined) continue;
					if (exposed[fA] && exposed[fB]) {
						const dA = FACE_DIRS[fA];
						const dB = FACE_DIRS[fB];
						if (dA === undefined || dB === undefined) continue;
						const diagAir = !isSolidFast(
							lx + dA[0] + dB[0],
							ly + dA[1] + dB[1],
							lz + dA[2] + dB[2],
						);
						edgeBev[fA][fB] = diagAir;
						edgeBev[fB][fA] = diagAir;
					}
				}

				// --- Compute inset face corners and AO ---
				const faceCorners: ([number, number, number][] | null)[] = [
					null,
					null,
					null,
					null,
					null,
					null,
				];
				const faceAO: ([AO, AO, AO, AO] | null)[] = [
					null,
					null,
					null,
					null,
					null,
					null,
				];
				for (let f = 0; f < 6; f++) {
					faceFolds[f].length = 0;
				}

				for (let f = 0; f < 6; f++) {
					if (!exposed[f]) continue;

					const axis = faceAxis(f);
					const dir = faceDir(f);
					const u = (axis + 1) % 3;
					const v = (axis + 2) % 3;

					const facePos = dir > 0 ? base[axis] + S : base[axis];

					const uMinF = faceIndex(u, -1);
					const uMaxF = faceIndex(u, 1);
					const vMinF = faceIndex(v, -1);
					const vMaxF = faceIndex(v, 1);

					const uMinB = edgeBev[f][uMinF];
					const uMaxB = edgeBev[f][uMaxF];
					const vMinB = edgeBev[f][vMinF];
					const vMaxB = edgeBev[f][vMaxF];

					// v0(u-min,v-min) v1(u-max,v-min) v2(u-max,v-max) v3(u-min,v-max)
					const corners: [number, number, number][] = [];
					for (let c = 0; c < 4; c++) {
						const isUMax = c === 1 || c === 2;
						const isVMax = c === 2 || c === 3;

						const pos: [number, number, number] = [0, 0, 0];
						pos[axis] = facePos;
						pos[u] = isUMax ? base[u] + S : base[u];
						pos[v] = isVMax ? base[v] + S : base[v];

						if (isUMax && uMaxB) pos[u] -= b;
						if (!isUMax && uMinB) pos[u] += b;
						if (isVMax && vMaxB) pos[v] -= b;
						if (!isVMax && vMinB) pos[v] += b;

						corners.push(pos);
					}
					faceCorners[f] = corners;

					// AO: same as greedy mesher
					const airD = local[axis] + dir;
					const ao: [AO, AO, AO, AO] = [0, 0, 0, 0];
					for (let c = 0; c < 4; c++) {
						const signs = aoSigns[c];
						if (signs === undefined) continue;
						const su = signs[0];
						const sv = signs[1];

						const s1: [number, number, number] = [0, 0, 0];
						s1[axis] = airD;
						s1[u] = local[u] + su;
						s1[v] = local[v];

						const s2: [number, number, number] = [0, 0, 0];
						s2[axis] = airD;
						s2[u] = local[u];
						s2[v] = local[v] + sv;

						const cr: [number, number, number] = [0, 0, 0];
						cr[axis] = airD;
						cr[u] = local[u] + su;
						cr[v] = local[v] + sv;

						ao[c] = vertexAO(
							isSolidFast(s1[0], s1[1], s1[2]),
							isSolidFast(s2[0], s2[1], s2[2]),
							isSolidFast(cr[0], cr[1], cr[2]),
						);
					}
					faceAO[f] = ao;

					for (let c = 0; c < 4; c++) {
						const isUMax = c === 1 || c === 2;
						const isVMax = c === 2 || c === 3;
						const uDir = isUMax ? 1 : -1;
						const vDir = isVMax ? 1 : -1;
						const uFace = faceIndex(u, uDir);
						const vFace = faceIndex(v, vDir);

						if (edgeBev[f][uFace] || edgeBev[f][vFace]) continue;
						if (exposed[uFace] || exposed[vFace]) continue;

						const uOffset: [number, number, number] = [0, 0, 0];
						uOffset[u] = uDir;
						const vOffset: [number, number, number] = [0, 0, 0];
						vOffset[v] = vDir;

						if (
							!isEdgeBeveledAt(
								lx + uOffset[0],
								ly + uOffset[1],
								lz + uOffset[2],
								f,
								vFace,
							) ||
							!isEdgeBeveledAt(
								lx + vOffset[0],
								ly + vOffset[1],
								lz + vOffset[2],
								f,
								uFace,
							)
						) {
							continue;
						}

						const cornerPos: [number, number, number] = [0, 0, 0];
						cornerPos[axis] = facePos;
						cornerPos[u] = isUMax ? base[u] + S : base[u];
						cornerPos[v] = isVMax ? base[v] + S : base[v];

						const shoulderAlongU: [number, number, number] = [
							...cornerPos,
						];
						const shoulderAlongV: [number, number, number] = [
							...cornerPos,
						];
						shoulderAlongU[u] += isUMax ? -b : b;
						shoulderAlongV[v] += isVMax ? -b : b;

						const foldPoint: [number, number, number] = [
							...cornerPos,
						];
						foldPoint[axis] -= dir * b;

						faceFolds[f].push({
							corner: c,
							shoulderToPrev:
								c === 0 || c === 2
									? shoulderAlongV
									: shoulderAlongU,
							shoulderToNext:
								c === 0 || c === 2
									? shoulderAlongU
									: shoulderAlongV,
							foldPoint,
						});
					}
				}

				// --- Emit face quads ---
				for (let f = 0; f < 6; f++) {
					const corners = faceCorners[f];
					const ao = faceAO[f];
					if (!corners || !ao) continue;

					const axis = faceAxis(f);
					const dir = faceDir(f);
					const u = (axis + 1) % 3;
					const v = (axis + 2) % 3;
					const positive = dir > 0;

					const normal: [number, number, number] = [0, 0, 0];
					normal[axis] = dir;

					const aoF0 = AO_CURVE[ao[0]];
					const aoF1 = AO_CURVE[ao[1]];
					const aoF2 = AO_CURVE[ao[2]];
					const aoF3 = AO_CURVE[ao[3]];
					const aoFloats = [aoF0, aoF1, aoF2, aoF3];

					// World-aligned UVs from vertex positions
					const projectUv = (
						p: readonly [number, number, number],
					): [number, number] =>
						axis === 0
							? [p[v] / uvDenom, p[u] / uvDenom]
							: [p[u] / uvDenom, p[v] / uvDenom];
					const uvs: [number, number][] = [];
					for (let c = 0; c < 4; c++) {
						const p = corners[c];
						if (p === undefined) continue;
						uvs.push(projectUv(p));
					}

					const flipDiag = ao[0] + ao[2] > ao[1] + ao[3];

					const c0 = corners[0];
					const c1 = corners[1];
					const c2 = corners[2];
					const c3 = corners[3];
					const u0 = uvs[0];
					const u1 = uvs[1];
					const u2 = uvs[2];
					const u3 = uvs[3];
					if (!c0 || !c1 || !c2 || !c3 || !u0 || !u1 || !u2 || !u3)
						continue;

					const folds = faceFolds[f];
					if (folds.length > 0) {
						const foldsByCorner: (FaceFold | null)[] = [
							null,
							null,
							null,
							null,
						];
						for (const fold of folds) {
							foldsByCorner[fold.corner] = fold;
						}

						const insetT = Math.max(0, Math.min(1, b / S));
						const polyPositions: [number, number, number][] = [];
						const polyUvs: [number, number][] = [];
						const polyAo: number[] = [];
						for (let c = 0; c < 4; c++) {
							const faceFold = foldsByCorner[c];
							if (faceFold) {
								const prevCorner = (faceFold.corner + 3) & 3;
								const nextCorner = (faceFold.corner + 1) & 3;
								const shoulderPrevAo =
									aoFloats[faceFold.corner] * (1 - insetT) +
									aoFloats[prevCorner] * insetT;
								const shoulderNextAo =
									aoFloats[faceFold.corner] * (1 - insetT) +
									aoFloats[nextCorner] * insetT;
								polyPositions.push(faceFold.shoulderToPrev);
								polyUvs.push(
									projectUv(faceFold.shoulderToPrev),
								);
								polyAo.push(shoulderPrevAo);

								polyPositions.push(faceFold.shoulderToNext);
								polyUvs.push(
									projectUv(faceFold.shoulderToNext),
								);
								polyAo.push(shoulderNextAo);
								continue;
							}

							const p = corners[c];
							const uv = uvs[c];
							const aoValue = aoFloats[c];
							if (!p || !uv || aoValue === undefined) continue;
							polyPositions.push(p);
							polyUvs.push(uv);
							polyAo.push(aoValue);
						}

						for (let i = 1; i < polyPositions.length - 1; i++) {
							const pA = polyPositions[0];
							const pB = polyPositions[i];
							const pC = polyPositions[i + 1];
							const uvA = polyUvs[0];
							const uvB = polyUvs[i];
							const uvC = polyUvs[i + 1];
							const aoA = polyAo[0];
							const aoB = polyAo[i];
							const aoC = polyAo[i + 1];
							if (
								!pA ||
								!pB ||
								!pC ||
								!uvA ||
								!uvB ||
								!uvC ||
								aoA === undefined ||
								aoB === undefined ||
								aoC === undefined
							) {
								continue;
							}
							writeTriangle(
								pA,
								pB,
								pC,
								normal,
								uvA,
								uvB,
								uvC,
								aoA,
								aoB,
								aoC,
								blockId,
							);
						}

						for (const faceFold of folds) {
							const prevCorner = (faceFold.corner + 3) & 3;
							const nextCorner = (faceFold.corner + 1) & 3;
							const shoulderPrevAo =
								aoFloats[faceFold.corner] * (1 - insetT) +
								aoFloats[prevCorner] * insetT;
							const shoulderNextAo =
								aoFloats[faceFold.corner] * (1 - insetT) +
								aoFloats[nextCorner] * insetT;
							const foldU =
								faceFold.corner === 1 || faceFold.corner === 2
									? 1
									: -1;
							const foldV =
								faceFold.corner === 2 || faceFold.corner === 3
									? 1
									: -1;
							const foldVec: [number, number, number] = [0, 0, 0];
							foldVec[axis] = dir;
							foldVec[u] = foldU;
							foldVec[v] = foldV;
							const foldLen = Math.sqrt(
								foldVec[0] * foldVec[0] +
									foldVec[1] * foldVec[1] +
									foldVec[2] * foldVec[2],
							);
							const foldNormal: [number, number, number] = [
								foldVec[0] / foldLen,
								foldVec[1] / foldLen,
								foldVec[2] / foldLen,
							];
							writeTriangle(
								faceFold.shoulderToPrev,
								faceFold.shoulderToNext,
								faceFold.foldPoint,
								foldNormal,
								projectUv(faceFold.shoulderToPrev),
								projectUv(faceFold.shoulderToNext),
								projectUv(faceFold.foldPoint),
								shoulderPrevAo,
								shoulderNextAo,
								aoFloats[faceFold.corner],
								blockId,
							);
						}
						continue;
					}

					if (positive) {
						if (flipDiag) {
							writeVertex(c0, normal, u0, aoF0, blockId);
							writeVertex(c1, normal, u1, aoF1, blockId);
							writeVertex(c3, normal, u3, aoF3, blockId);
							writeVertex(c1, normal, u1, aoF1, blockId);
							writeVertex(c2, normal, u2, aoF2, blockId);
							writeVertex(c3, normal, u3, aoF3, blockId);
						} else {
							writeVertex(c0, normal, u0, aoF0, blockId);
							writeVertex(c1, normal, u1, aoF1, blockId);
							writeVertex(c2, normal, u2, aoF2, blockId);
							writeVertex(c0, normal, u0, aoF0, blockId);
							writeVertex(c2, normal, u2, aoF2, blockId);
							writeVertex(c3, normal, u3, aoF3, blockId);
						}
					} else {
						if (flipDiag) {
							writeVertex(c0, normal, u0, aoF0, blockId);
							writeVertex(c3, normal, u3, aoF3, blockId);
							writeVertex(c1, normal, u1, aoF1, blockId);
							writeVertex(c1, normal, u1, aoF1, blockId);
							writeVertex(c3, normal, u3, aoF3, blockId);
							writeVertex(c2, normal, u2, aoF2, blockId);
						} else {
							writeVertex(c0, normal, u0, aoF0, blockId);
							writeVertex(c2, normal, u2, aoF2, blockId);
							writeVertex(c1, normal, u1, aoF1, blockId);
							writeVertex(c0, normal, u0, aoF0, blockId);
							writeVertex(c3, normal, u3, aoF3, blockId);
							writeVertex(c2, normal, u2, aoF2, blockId);
						}
					}
				}

				// --- Emit edge chamfer quads ---
				for (const pair of EDGE_PAIRS) {
					const fA = pair[0];
					const fB = pair[1];
					if (fA === undefined || fB === undefined) continue;
					if (!edgeBev[fA][fB]) continue;

					const cornersA = faceCorners[fA];
					const cornersB = faceCorners[fB];
					const aoA = faceAO[fA];
					const aoB = faceAO[fB];
					if (!cornersA || !cornersB || !aoA || !aoB) continue;

					const [cA0, cA1] = getEdgeCorners(fA, fB);
					const [cB0, cB1] = getEdgeCorners(fB, fA);

					const axisA = faceAxis(fA);
					const axisB = faceAxis(fB);
					const edgeAx = 3 - axisA - axisB;

					// Sort corners by position along edge axis
					const pA0 = cornersA[cA0];
					const pA1 = cornersA[cA1];
					const pB0 = cornersB[cB0];
					const pB1 = cornersB[cB1];
					if (!pA0 || !pA1 || !pB0 || !pB1) continue;

					let aLow: number, aHigh: number;
					if (pA0[edgeAx] <= pA1[edgeAx]) {
						aLow = cA0;
						aHigh = cA1;
					} else {
						aLow = cA1;
						aHigh = cA0;
					}

					let bLow: number, bHigh: number;
					if (pB0[edgeAx] <= pB1[edgeAx]) {
						bLow = cB0;
						bHigh = cB1;
					} else {
						bLow = cB1;
						bHigh = cB0;
					}

					const vAL = cornersA[aLow];
					const vAH = cornersA[aHigh];
					const vBL = cornersB[bLow];
					const vBH = cornersB[bHigh];
					if (!vAL || !vAH || !vBL || !vBH) continue;

					// Chamfer normal
					const dA = FACE_DIRS[fA];
					const dB = FACE_DIRS[fB];
					if (!dA || !dB) continue;
					const nx = dA[0] + dB[0];
					const ny = dA[1] + dB[1];
					const nz = dA[2] + dB[2];
					const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
					const normal: [number, number, number] = [
						nx / nLen,
						ny / nLen,
						nz / nLen,
					];

					// AO: inherit from face corners
					const aoAL = AO_CURVE[aoA[aLow]];
					const aoAH = AO_CURVE[aoA[aHigh]];
					const aoBL = AO_CURVE[aoB[bLow]];
					const aoBH = AO_CURVE[aoB[bHigh]];

					// UVs: project through face A's axis
					const projAxis = axisA;
					const pU = (projAxis + 1) % 3;
					const pV = (projAxis + 2) % 3;
					const uvAL: [number, number] =
						projAxis === 0
							? [vAL[pV] / uvDenom, vAL[pU] / uvDenom]
							: [vAL[pU] / uvDenom, vAL[pV] / uvDenom];
					const uvAH: [number, number] =
						projAxis === 0
							? [vAH[pV] / uvDenom, vAH[pU] / uvDenom]
							: [vAH[pU] / uvDenom, vAH[pV] / uvDenom];
					const uvBL: [number, number] =
						projAxis === 0
							? [vBL[pV] / uvDenom, vBL[pU] / uvDenom]
							: [vBL[pU] / uvDenom, vBL[pV] / uvDenom];
					const uvBH: [number, number] =
						projAxis === 0
							? [vBH[pV] / uvDenom, vBH[pU] / uvDenom]
							: [vBH[pU] / uvDenom, vBH[pV] / uvDenom];

					// Winding check: cross(aHigh-aLow, bLow-aLow) · normal
					const e1x = vAH[0] - vAL[0];
					const e1y = vAH[1] - vAL[1];
					const e1z = vAH[2] - vAL[2];
					const e2x = vBL[0] - vAL[0];
					const e2y = vBL[1] - vAL[1];
					const e2z = vBL[2] - vAL[2];
					const cx = e1y * e2z - e1z * e2y;
					const cy = e1z * e2x - e1x * e2z;
					const cz = e1x * e2y - e1y * e2x;
					const dot =
						cx * normal[0] + cy * normal[1] + cz * normal[2];

					if (dot > 0) {
						writeVertex(vAL, normal, uvAL, aoAL, blockId);
						writeVertex(vAH, normal, uvAH, aoAH, blockId);
						writeVertex(vBH, normal, uvBH, aoBH, blockId);
						writeVertex(vAL, normal, uvAL, aoAL, blockId);
						writeVertex(vBH, normal, uvBH, aoBH, blockId);
						writeVertex(vBL, normal, uvBL, aoBL, blockId);
					} else {
						writeVertex(vAL, normal, uvAL, aoAL, blockId);
						writeVertex(vBL, normal, uvBL, aoBL, blockId);
						writeVertex(vBH, normal, uvBH, aoBH, blockId);
						writeVertex(vAL, normal, uvAL, aoAL, blockId);
						writeVertex(vBH, normal, uvBH, aoBH, blockId);
						writeVertex(vAH, normal, uvAH, aoAH, blockId);
					}
				}

				// --- Emit corner cap triangles ---
				for (const triple of CORNER_FACES) {
					const fA = triple[0];
					const fB = triple[1];
					const fC = triple[2];
					if (
						fA === undefined ||
						fB === undefined ||
						fC === undefined
					)
						continue;

					// All 3 edges meeting at this corner must be beveled
					if (
						!edgeBev[fA][fB] ||
						!edgeBev[fA][fC] ||
						!edgeBev[fB][fC]
					)
						continue;

					const cornersA = faceCorners[fA];
					const cornersB = faceCorners[fB];
					const cornersC = faceCorners[fC];
					const aoA = faceAO[fA];
					const aoB = faceAO[fB];
					const aoC = faceAO[fC];
					if (
						!cornersA ||
						!cornersB ||
						!cornersC ||
						!aoA ||
						!aoB ||
						!aoC
					)
						continue;

					const ciA = getCornerVertexIndex(fA, fB, fC);
					const ciB = getCornerVertexIndex(fB, fA, fC);
					const ciC = getCornerVertexIndex(fC, fA, fB);

					const pA = cornersA[ciA];
					const pB = cornersB[ciB];
					const pC = cornersC[ciC];
					if (!pA || !pB || !pC) continue;

					const dA = FACE_DIRS[fA];
					const dB = FACE_DIRS[fB];
					const dC = FACE_DIRS[fC];
					if (!dA || !dB || !dC) continue;
					const cnx = dA[0] + dB[0] + dC[0];
					const cny = dA[1] + dB[1] + dC[1];
					const cnz = dA[2] + dB[2] + dC[2];
					const cnLen = Math.sqrt(cnx * cnx + cny * cny + cnz * cnz);
					const normal: [number, number, number] = [
						cnx / cnLen,
						cny / cnLen,
						cnz / cnLen,
					];

					const capAoA = AO_CURVE[aoA[ciA]];
					const capAoB = AO_CURVE[aoB[ciB]];
					const capAoC = AO_CURVE[aoC[ciC]];

					// UVs: project through face A's axis
					const projAxis = faceAxis(fA);
					const pU = (projAxis + 1) % 3;
					const pV = (projAxis + 2) % 3;
					const uvPA: [number, number] =
						projAxis === 0
							? [pA[pV] / uvDenom, pA[pU] / uvDenom]
							: [pA[pU] / uvDenom, pA[pV] / uvDenom];
					const uvPB: [number, number] =
						projAxis === 0
							? [pB[pV] / uvDenom, pB[pU] / uvDenom]
							: [pB[pU] / uvDenom, pB[pV] / uvDenom];
					const uvPC: [number, number] =
						projAxis === 0
							? [pC[pV] / uvDenom, pC[pU] / uvDenom]
							: [pC[pU] / uvDenom, pC[pV] / uvDenom];

					// Winding check
					const t1x = pB[0] - pA[0];
					const t1y = pB[1] - pA[1];
					const t1z = pB[2] - pA[2];
					const t2x = pC[0] - pA[0];
					const t2y = pC[1] - pA[1];
					const t2z = pC[2] - pA[2];
					const tcx = t1y * t2z - t1z * t2y;
					const tcy = t1z * t2x - t1x * t2z;
					const tcz = t1x * t2y - t1y * t2x;
					const tdot =
						tcx * normal[0] + tcy * normal[1] + tcz * normal[2];

					if (tdot > 0) {
						writeVertex(pA, normal, uvPA, capAoA, blockId);
						writeVertex(pB, normal, uvPB, capAoB, blockId);
						writeVertex(pC, normal, uvPC, capAoC, blockId);
					} else {
						writeVertex(pA, normal, uvPA, capAoA, blockId);
						writeVertex(pC, normal, uvPC, capAoC, blockId);
						writeVertex(pB, normal, uvPB, capAoB, blockId);
					}
				}

				// --- Emit crude 3-way concave plug triangles ---
				console.log('triple: ', CORNER_FACES);
				for (const triple of CORNER_FACES) {
					const f0 = triple[0];
					const f1 = triple[1];
					const f2 = triple[2];
					if (
						f0 === undefined ||
						f1 === undefined ||
						f2 === undefined
					) {
						continue;
					}

					const faces = [f0, f1, f2];
					for (let inIndex = 0; inIndex < 3; inIndex++) {
						const inwardFace = faces[inIndex];
						const outwardFaceA = faces[(inIndex + 1) % 3];
						const outwardFaceB = faces[(inIndex + 2) % 3];
						if (
							inwardFace === undefined ||
							outwardFaceA === undefined ||
							outwardFaceB === undefined
						) {
							continue;
						}
						if (
							!exposed[inwardFace] ||
							!exposed[outwardFaceA] ||
							!exposed[outwardFaceB]
						) {
							continue;
						}
						if (
							!edgeBev[inwardFace][outwardFaceA] ||
							!edgeBev[inwardFace][outwardFaceB]
						) {
							continue;
						}

						const dIn = FACE_DIRS[inwardFace];
						const dOutA = FACE_DIRS[outwardFaceA];
						const dOutB = FACE_DIRS[outwardFaceB];
						if (!dIn || !dOutA || !dOutB) continue;

						const neighborA: [number, number, number] = [
							lx + dIn[0] + dOutA[0],
							ly + dIn[1] + dOutA[1],
							lz + dIn[2] + dOutA[2],
						];
						const neighborB: [number, number, number] = [
							lx + dIn[0] + dOutB[0],
							ly + dIn[1] + dOutB[1],
							lz + dIn[2] + dOutB[2],
						];
						if (
							!isSolidFast(
								neighborA[0],
								neighborA[1],
								neighborA[2],
							) ||
							!isSolidFast(
								neighborB[0],
								neighborB[1],
								neighborB[2],
							)
						) {
							continue;
						}

						const farDiagSolid = isSolidFast(
							lx + dIn[0] + dOutA[0] + dOutB[0],
							ly + dIn[1] + dOutA[1] + dOutB[1],
							lz + dIn[2] + dOutA[2] + dOutB[2],
						);
						if (farDiagSolid) continue;

						if (
							compareBlockCoords(
								lx,
								ly,
								lz,
								neighborA[0],
								neighborA[1],
								neighborA[2],
							) > 0 ||
							compareBlockCoords(
								lx,
								ly,
								lz,
								neighborB[0],
								neighborB[1],
								neighborB[2],
							) > 0
						) {
							continue;
						}

						const currentFaceCorners = faceCorners[inwardFace];
						const currentFaceAo = faceAO[inwardFace];
						if (!currentFaceCorners || !currentFaceAo) continue;

						const currentCorner = getCornerVertexIndex(
							inwardFace,
							outwardFaceA,
							outwardFaceB,
						);
						const currentPos = currentFaceCorners[currentCorner];
						if (!currentPos) continue;
						const currentAo =
							AO_CURVE[currentFaceAo[currentCorner]];

						const neighborAFace = oppositeFace(outwardFaceA);
						const neighborBFace = oppositeFace(outwardFaceB);
						const neighborACorner = getCornerVertexIndex(
							neighborAFace,
							outwardFaceB,
							inwardFace,
						);
						const neighborBCorner = getCornerVertexIndex(
							neighborBFace,
							outwardFaceA,
							inwardFace,
						);
						const neighborAData = getFaceCornerData(
							neighborA[0],
							neighborA[1],
							neighborA[2],
							neighborAFace,
							neighborACorner,
						);
						const neighborBData = getFaceCornerData(
							neighborB[0],
							neighborB[1],
							neighborB[2],
							neighborBFace,
							neighborBCorner,
						);
						if (!neighborAData || !neighborBData) continue;

						const nnx = dIn[0] + dOutA[0] + dOutB[0];
						const nny = dIn[1] + dOutA[1] + dOutB[1];
						const nnz = dIn[2] + dOutA[2] + dOutB[2];
						const nnLen = Math.sqrt(
							nnx * nnx + nny * nny + nnz * nnz,
						);
						if (nnLen < 1e-6) continue;
						const plugNormal: [number, number, number] = [
							nnx / nnLen,
							nny / nnLen,
							nnz / nnLen,
						];

						console.log('?!?!', plugNormal);

						const projAxis = faceAxis(inwardFace);
						const pU = (projAxis + 1) % 3;
						const pV = (projAxis + 2) % 3;
						const projectUv = (
							p: readonly [number, number, number],
						): [number, number] =>
							projAxis === 0
								? [p[pV] / uvDenom, p[pU] / uvDenom]
								: [p[pU] / uvDenom, p[pV] / uvDenom];

						writeTriangle(
							currentPos,
							neighborAData.pos,
							neighborBData.pos,
							plugNormal,
							projectUv(currentPos),
							projectUv(neighborAData.pos),
							projectUv(neighborBData.pos),
							currentAo,
							neighborAData.ao,
							neighborBData.ao,
							blockId,
						);
					}
				}
			}
		}
	}

	return {
		vertexData: vertexData.subarray(0, vOffset * FLOATS_PER_VERTEX),
		numVertices: vOffset,
	};
}
