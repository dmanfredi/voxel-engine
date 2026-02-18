import { vec3, type Vec3 } from 'wgpu-matrix';

export function FREECAM(
	keysDown: Set<string>,
	cameraPos: Vec3,
	cameraFront: Vec3,
	cameraUp: Vec3,
	units: number,
) {
	if (keysDown.has('KeyW')) {
		vec3.add(cameraPos, vec3.mulScalar(cameraFront, units), cameraPos);
	}
	if (keysDown.has('KeyS')) {
		vec3.sub(cameraPos, vec3.mulScalar(cameraFront, units), cameraPos);
	}
	if (keysDown.has('KeyA')) {
		// get the right vector
		const right = vec3.cross(cameraFront, cameraUp);

		// normalize it
		const normalRight = vec3.normalize(right);

		// how much to move leftward on the right vector
		const move = vec3.mulScalar(normalRight, units);

		// move
		vec3.sub(cameraPos, move, cameraPos);
	}
	if (keysDown.has('KeyD')) {
		// get the right vector
		const right = vec3.cross(cameraFront, cameraUp);

		// normalize it
		const normalRight = vec3.normalize(right);

		// how much to move on the right vector
		const move = vec3.mulScalar(normalRight, units);

		// move
		vec3.add(cameraPos, move, cameraPos);
	}
	if (keysDown.has('Space')) {
		// move up
		vec3.add(cameraPos, vec3.mulScalar(cameraUp, units), cameraPos);
	}
	if (keysDown.has('ShiftLeft')) {
		// move down
		vec3.sub(cameraPos, vec3.mulScalar(cameraUp, units), cameraPos);
	}
}

export function FPSCAM(
	keysDown: Set<string>,
	cameraFront: Vec3,
	cameraUp: Vec3,
	units: number,
): [number, number, number] {
	const delta: [number, number, number] = [0, 0, 0];

	if (keysDown.has('KeyW')) {
		const right = vec3.cross(cameraFront, cameraUp);
		const forward = vec3.normalize(vec3.cross(cameraUp, right));
		delta[0] += (forward[0] ?? 0) * units;
		delta[2] += (forward[2] ?? 0) * units;
	}
	if (keysDown.has('KeyS')) {
		const right = vec3.cross(cameraFront, cameraUp);
		const forward = vec3.normalize(vec3.cross(cameraUp, right));
		delta[0] -= (forward[0] ?? 0) * units;
		delta[2] -= (forward[2] ?? 0) * units;
	}
	if (keysDown.has('KeyA')) {
		const right = vec3.normalize(vec3.cross(cameraFront, cameraUp));
		delta[0] -= (right[0] ?? 0) * units;
		delta[2] -= (right[2] ?? 0) * units;
	}
	if (keysDown.has('KeyD')) {
		const right = vec3.normalize(vec3.cross(cameraFront, cameraUp));
		delta[0] += (right[0] ?? 0) * units;
		delta[2] += (right[2] ?? 0) * units;
	}

	return delta;
}
