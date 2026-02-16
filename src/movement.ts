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
	cameraPos: Vec3,
	cameraFront: Vec3,
	cameraUp: Vec3,
	units: number,
) {
	if (keysDown.has('KeyW')) {
		// get the foward vector
		const right = vec3.cross(cameraFront, cameraUp);
		const foward = vec3.cross(cameraUp, right);

		// normalize it
		const normalFoward = vec3.normalize(foward);

		// how much to move foward
		const move = vec3.mulScalar(normalFoward, units);

		// move
		vec3.add(cameraPos, move, cameraPos);
	}
	if (keysDown.has('KeyS')) {
		// get the foward vector
		const right = vec3.cross(cameraFront, cameraUp);
		const foward = vec3.cross(cameraUp, right);

		// normalize it
		const normalFoward = vec3.normalize(foward);

		// how much to move backward
		const move = vec3.mulScalar(normalFoward, units);

		vec3.sub(cameraPos, move, cameraPos);
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
	// if (keysDown.has('Space')) {
	// 	// move up
	// 	vec3.add(cameraPos, vec3.mulScalar(cameraUp, units), cameraPos);
	// }
	// if (keysDown.has('ShiftLeft')) {
	// 	// move down
	// 	vec3.sub(cameraPos, vec3.mulScalar(cameraUp, units), cameraPos);
	// }
}
