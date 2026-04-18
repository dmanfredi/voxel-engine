/** Procedural beveled cube mesh generation. */

import type { MeshData } from './icosphere';

// Face index 0..5 = +X, -X, +Y, -Y, +Z, -Z. f = axis*2 + (dir<0 ? 1 : 0).
function faceAxis(f: number): number {
	return f >> 1;
}
function faceDir(f: number): number {
	return (f & 1) === 0 ? 1 : -1;
}

// 12 edges as (faceA, faceB) pairs with axes differing. Each edge runs along
// the third axis (the one not in either face).
const EDGES: readonly (readonly [number, number])[] = [
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

// 8 corners as (faceA, faceB, faceC) — one per octant of the cube.
const CORNERS: readonly (readonly [number, number, number])[] = [
	[0, 2, 4],
	[0, 2, 5],
	[0, 3, 4],
	[0, 3, 5],
	[1, 2, 4],
	[1, 2, 5],
	[1, 3, 4],
	[1, 3, 5],
];

/**
 * Face-local UV from a position on the cube surface.
 *
 * Values are in "entity-relative units" — the two in-plane coords passed
 * through directly, then divided by `inner` so that a vertex at the inset
 * corner maps to ±1 (the inset face spans the full -1..+1 UV range, not
 * -inner..+inner). The shader multiplies this by the per-entity `texScale`
 * to produce final sampled UVs; see the texScale comment in `entity.ts`.
 *
 * Axis-0 swap (X faces use U=Z, V=Y) matches the greedy mesher so texture
 * V maps to world Y on side-facing surfaces at rest — textures stay
 * upright on walls, consistent with cube blocks.
 */
function faceUV(
	axis: number,
	x: number,
	y: number,
	z: number,
	inner: number,
): [number, number] {
	switch (axis) {
		case 0:
			return [z / inner, y / inner]; // X faces swap U/V
		case 1:
			return [x / inner, z / inner];
		case 2:
			return [x / inner, y / inner];
		default:
			return [0, 0];
	}
}

/**
 * Generate a beveled unit cube spanning [-1, +1]³, with chamfered edges and
 * triangular corner caps. Returns a non-indexed triangle list with
 * pos+normal+uv vertex format matching the icosphere mesher.
 *
 * `bevel` is the inset distance (from each face plane to the bevel boundary)
 * in unit-cube space. Subtle range: 0.05–0.10. Larger values (≥0.2) start to
 * look like a soft die rather than a cube.
 *
 * Topology: 6 inset face quads + 12 edge chamfer quads + 8 corner cap
 * triangles = 132 vertices. Vertices on shared boundaries (face↔chamfer,
 * chamfer↔cap) are coincident in position so there are no holes. Normals
 * differ across those boundaries — the face is flat, the chamfer is angled,
 * the cap is diagonal — which produces a visible facet edge in shading.
 *
 * UV strategy: faces, chamfers, and corner caps are each their own UV
 * island with face-density matching (same UV-units-per-world-unit across
 * all three). Faces use planar per-face mapping normalized so the inset
 * face spans UV ±1. Chamfers use chamfer-local (U along edge, V across
 * bevel) so the 4-corner quad is non-degenerate. Corner caps use a small
 * cap-local triangle.
 *
 * This creates tiny UV seams at face↔chamfer and chamfer↔cap boundaries.
 * For isotropic tiling textures (marble, noise) the seams are invisible.
 * For directional textures (brick, plank) the seams would show as offset
 * pattern breaks at the bevel — a future fix is to align chamfer UVs with
 * one of the adjacent faces' mappings at the cost of some density
 * mismatch, but that's deferred until a cube enemy actually uses a
 * directional material.
 */
export function createBeveledCube(bevel = 0.08): MeshData {
	if (bevel < 0 || bevel >= 1) {
		throw new Error(`bevel must be in [0, 1), got ${String(bevel)}`);
	}
	const inner = 1 - bevel;
	const VERTEX_COUNT = 6 * 6 + 12 * 6 + 8 * 3; // 132
	const FLOATS_PER_VERTEX = 8;
	const vertices = new Float32Array(VERTEX_COUNT * FLOATS_PER_VERTEX);
	let cursor = 0;

	function emitVertex(
		p: readonly [number, number, number],
		n: readonly [number, number, number],
		uv: readonly [number, number],
	): void {
		vertices[cursor++] = p[0];
		vertices[cursor++] = p[1];
		vertices[cursor++] = p[2];
		vertices[cursor++] = n[0];
		vertices[cursor++] = n[1];
		vertices[cursor++] = n[2];
		vertices[cursor++] = uv[0];
		vertices[cursor++] = uv[1];
	}

	function emitTri(
		p0: readonly [number, number, number],
		uv0: readonly [number, number],
		p1: readonly [number, number, number],
		uv1: readonly [number, number],
		p2: readonly [number, number, number],
		uv2: readonly [number, number],
		n: readonly [number, number, number],
	): void {
		emitVertex(p0, n, uv0);
		emitVertex(p1, n, uv1);
		emitVertex(p2, n, uv2);
	}

	function emitQuad(
		p0: readonly [number, number, number],
		uv0: readonly [number, number],
		p1: readonly [number, number, number],
		uv1: readonly [number, number],
		p2: readonly [number, number, number],
		uv2: readonly [number, number],
		p3: readonly [number, number, number],
		uv3: readonly [number, number],
		n: readonly [number, number, number],
	): void {
		// CCW quad p0→p1→p2→p3 splits into triangles (p0,p1,p2) and (p0,p2,p3)
		emitTri(p0, uv0, p1, uv1, p2, uv2, n);
		emitTri(p0, uv0, p2, uv2, p3, uv3, n);
	}

	// ── Inset faces ────────────────────────────────────────────────────
	for (let f = 0; f < 6; f++) {
		const a = faceAxis(f);
		const d = faceDir(f);
		const u = (a + 1) % 3;
		const v = (a + 2) % 3;

		const n: [number, number, number] = [0, 0, 0];
		n[a] = d;

		// Sign pattern around face perimeter, CCW from outside. The order
		// flips when the face direction reverses (otherwise the apparent
		// winding from the exterior also reverses).
		const signs: readonly (readonly [number, number])[] =
			d > 0
				? [
						[-1, -1],
						[1, -1],
						[1, 1],
						[-1, 1],
					]
				: [
						[1, -1],
						[-1, -1],
						[-1, 1],
						[1, 1],
					];

		const ps: [number, number, number][] = [];
		const uvs: [number, number][] = [];
		for (const [su, sv] of signs) {
			const p: [number, number, number] = [0, 0, 0];
			p[a] = d;
			p[u] = su * inner;
			p[v] = sv * inner;
			ps.push(p);
			uvs.push(faceUV(a, p[0], p[1], p[2], inner));
		}
		emitQuad(ps[0], uvs[0], ps[1], uvs[1], ps[2], uvs[2], ps[3], uvs[3], n);
	}

	// ── Edge chamfers ──────────────────────────────────────────────────
	const invSqrt2 = 1 / Math.sqrt(2);
	for (const [fA, fB] of EDGES) {
		const aA = faceAxis(fA);
		const dA = faceDir(fA);
		const aB = faceAxis(fB);
		const dB = faceDir(fB);
		const aC = 3 - aA - aB; // edge runs along this axis

		const n: [number, number, number] = [0, 0, 0];
		n[aA] = dA * invSqrt2;
		n[aB] = dB * invSqrt2;

		// Chamfer quad has 4 corners. A-side vertices sit on face A's inset
		// boundary; B-side vertices sit on face B's inset boundary. The two
		// pairs are at C = ±inner (the chamfer ends where corner caps begin).
		const makeP = (
			side: 'A' | 'B',
			cSign: number,
		): [number, number, number] => {
			const p: [number, number, number] = [0, 0, 0];
			p[aA] = side === 'A' ? dA : dA * inner;
			p[aB] = side === 'A' ? dB * inner : dB;
			p[aC] = cSign * inner;
			return p;
		};

		const pAneg = makeP('A', -1);
		const pApos = makeP('A', 1);
		const pBneg = makeP('B', -1);
		const pBpos = makeP('B', 1);

		// Chamfer-local UV: U along edge axis (matches face density), V
		// across the bevel. Inheriting UV from adjacent face mappings was
		// tried first but produced degenerate quads — the faces' UV
		// conventions happen to give identical values at chamfer corners.
		//
		// Face UVs use coord/inner, so face density is (1/inner) UV-units
		// per world unit. Chamfer uses the same 1/inner density for
		// consistency. Along edge: U = pos[aC]/inner (same scheme as face).
		// Across bevel: chamfer width in world = bevel·√2 (diagonal across
		// corner); V spans bevel·√2/inner in UV. The formula
		//   √2·(pos[aB]·dB − inner) / inner
		// gives V = 0 on face A's boundary (pos[aB]·dB = inner) and
		// V = √2·bevel/inner on face B's (pos[aB]·dB = 1). Sign-agnostic.
		const sqrt2 = Math.sqrt(2);
		const chamferUV = (
			p: readonly [number, number, number],
		): [number, number] => [
			p[aC] / inner,
			(sqrt2 * (p[aB] * dB - inner)) / inner,
		];
		const uvAneg = chamferUV(pAneg);
		const uvApos = chamferUV(pApos);
		const uvBneg = chamferUV(pBneg);
		const uvBpos = chamferUV(pBpos);

		// Winding: pick CCW from outside (along +n). The correct order
		// depends on the axis pair and direction signs, so derive it via
		// cross-product check rather than enumerating all 12 cases.
		const e1x = pApos[0] - pAneg[0];
		const e1y = pApos[1] - pAneg[1];
		const e1z = pApos[2] - pAneg[2];
		const e2x = pBpos[0] - pAneg[0];
		const e2y = pBpos[1] - pAneg[1];
		const e2z = pBpos[2] - pAneg[2];
		const cx = e1y * e2z - e1z * e2y;
		const cy = e1z * e2x - e1x * e2z;
		const cz = e1x * e2y - e1y * e2x;
		const ccw = cx * n[0] + cy * n[1] + cz * n[2] > 0;

		if (ccw) {
			emitQuad(
				pAneg,
				uvAneg,
				pApos,
				uvApos,
				pBpos,
				uvBpos,
				pBneg,
				uvBneg,
				n,
			);
		} else {
			emitQuad(
				pAneg,
				uvAneg,
				pBneg,
				uvBneg,
				pBpos,
				uvBpos,
				pApos,
				uvApos,
				n,
			);
		}
	}

	// ── Corner caps ────────────────────────────────────────────────────
	const invSqrt3 = 1 / Math.sqrt(3);
	for (const [fA, fB, fC] of CORNERS) {
		const aA = faceAxis(fA);
		const dA = faceDir(fA);
		const aB = faceAxis(fB);
		const dB = faceDir(fB);
		const aC = faceAxis(fC);
		const dC = faceDir(fC);

		const n: [number, number, number] = [0, 0, 0];
		n[aA] = dA * invSqrt3;
		n[aB] = dB * invSqrt3;
		n[aC] = dC * invSqrt3;

		// Each of the 3 cap vertices sits on one face's inset boundary —
		// coincident with a chamfer endpoint, so cap and chamfers share edges.
		const makeP = (face: 'A' | 'B' | 'C'): [number, number, number] => {
			const p: [number, number, number] = [0, 0, 0];
			p[aA] = face === 'A' ? dA : dA * inner;
			p[aB] = face === 'B' ? dB : dB * inner;
			p[aC] = face === 'C' ? dC : dC * inner;
			return p;
		};

		const pA = makeP('A');
		const pB = makeP('B');
		const pC = makeP('C');

		// Corner-local UV: small equilateral triangle in UV space with side
		// length bevel·√2 (the cap's side length in world). Matches face
		// density (1 UV-unit per entity-relative world unit). Inheriting
		// UV from adjacent face mappings collapses to a single point —
		// all three faces' mappings agree at the cap vertices because of
		// the (x,y,z)-symmetric axis-swap convention.
		const capSide = (1 - inner) * Math.sqrt(2); // = bevel·√2
		const uvA: [number, number] = [0, 0];
		const uvB: [number, number] = [capSide, 0];
		const uvC: [number, number] = [
			capSide / 2,
			(capSide * Math.sqrt(3)) / 2,
		];

		// Same winding determination as for chamfers
		const e1x = pB[0] - pA[0];
		const e1y = pB[1] - pA[1];
		const e1z = pB[2] - pA[2];
		const e2x = pC[0] - pA[0];
		const e2y = pC[1] - pA[1];
		const e2z = pC[2] - pA[2];
		const cx = e1y * e2z - e1z * e2y;
		const cy = e1z * e2x - e1x * e2z;
		const cz = e1x * e2y - e1y * e2x;
		const ccw = cx * n[0] + cy * n[1] + cz * n[2] > 0;

		if (ccw) {
			emitTri(pA, uvA, pB, uvB, pC, uvC, n);
		} else {
			emitTri(pA, uvA, pC, uvC, pB, uvB, n);
		}
	}

	return { vertices, vertexCount: VERTEX_COUNT };
}
