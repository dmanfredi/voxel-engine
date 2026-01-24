import { mat4, vec3 } from 'wgpu-matrix';
import MainShader from './shader';
import WireframeShader from './wireframe';

import { BuildDebug, debuggerParams, stats } from './debug';
import buildBlocks, {
	CHUNK_SIZE_X,
	CHUNK_SIZE_Y,
	CHUNK_SIZE_Z,
} from './block-builder';
import { greedyMesh } from './greedy-mesh';

// Practical TODO
// - different blocks with different textures
// - multiple chunks

if (!navigator.gpu) {
	alert('WebGPU not supported on this browser.');
	throw new Error('WebGPU not supported on this browser.');
}

const BLOCK_SIZE = 10;
const blocks = buildBlocks();

// Generate optimized mesh using greedy meshing algorithm
const { vertexData: meshVertexData, numVertices: meshNumVertices } = greedyMesh(
	blocks,
	[CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z],
	BLOCK_SIZE,
);

const degToRad = (d: number) => (d * Math.PI) / 180;
const up = vec3.create(0, 1, 0);

const cameraPos = vec3.create(0, 100, 300);
const cameraFront = vec3.create(0, 0, -1);
// const cameraTarget = vec3.create(0, 0, 1);

// const cameraDirection = vec3.normalize(vec3.subtract(cameraPos, cameraTarget));
// const cameraRight = vec3.normalize(vec3.cross(up, cameraDirection));
const cameraUp = up;

let cameraYaw = -90;
let cameraPitch = 0;

async function main(): Promise<void> {
	const canvas = document.querySelector<HTMLCanvasElement>('canvas');
	if (!canvas) {
		throw new Error('Canvas element not found.');
	}

	// Get a WebGPU context from the canvas and configure it
	const context = canvas.getContext('webgpu');
	if (!context) {
		throw new Error('No WebGPU context found!');
	}

	const adapter = await navigator.gpu.requestAdapter();
	if (!adapter) {
		alert('No appropriate GPUAdapter found.');
		throw new Error('No appropriate GPUAdapter found.');
	}

	let renderRequestId: number;
	canvas.addEventListener('click', () => {
		void canvas.requestPointerLock();
	});

	// ============================================
	// MOVEMENT START
	// ============================================

	document.addEventListener(
		'mousemove',
		(e) => {
			if (document.pointerLockElement !== canvas) return;

			const sensitivity = 40;
			const step = sensitivity * 0.001;
			cameraYaw += e.movementX * step;
			cameraPitch -= e.movementY * step;

			// prevents doing somersaults
			if (cameraPitch + step >= 88) cameraPitch = 88 - step;
			if (cameraPitch - step <= -88) cameraPitch = -88 + step;

			// if (cameraPitch - 0.1 <= -(Math.PI / 2))
			// 	cameraPitch = -(Math.PI / 2) + 0.1;

			const direction = vec3.create(
				Math.cos(degToRad(cameraYaw)) * Math.cos(degToRad(cameraPitch)),
				Math.sin(degToRad(cameraPitch)),
				Math.sin(degToRad(cameraYaw)) * Math.cos(degToRad(cameraPitch)),
			);

			vec3.normalize(direction, cameraFront);

			requestRender();
		},
		false,
	);

	document.addEventListener('keydown', (e) => {
		// Use e.code so it's layout-independent ("KeyW" stays KeyW on AZERTY, etc.)
		if (
			e.code === 'KeyW' ||
			e.code === 'KeyA' ||
			e.code === 'KeyS' ||
			e.code === 'KeyD' ||
			e.code === 'KeyE' ||
			e.code === 'KeyQ'
		) {
			e.preventDefault();
			keysDown.add(e.code);
		}
	});

	document.addEventListener('keyup', (e) => {
		keysDown.delete(e.code);
	});

	// Prevent "stuck key" if the tab loses focus mid-press
	window.addEventListener('blur', () => {
		keysDown.clear();
	});

	let lastT = 0;
	const keysDown = new Set();

	function tick(t: number) {
		const dt = Math.min(0.05, (t - lastT) / 1000);
		lastT = t;

		const speed = 500; // units per second
		const units = speed * dt;

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
		if (keysDown.has('KeyQ')) {
			// move up
			vec3.add(cameraPos, vec3.mulScalar(cameraUp, units), cameraPos);
		}
		if (keysDown.has('KeyE')) {
			// move down
			vec3.sub(cameraPos, vec3.mulScalar(cameraUp, units), cameraPos);
		}

		requestRender();

		requestAnimationFrame(tick);
	}

	requestAnimationFrame((t) => {
		lastT = t;
		tick(t);
	});

	// ============================================
	// MOVEMENT END
	// ============================================

	const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
	const device = await adapter.requestDevice();

	context.configure({
		device,
		format: presentationFormat,
		alphaMode: 'premultiplied',
	});

	const module = device.createShaderModule({
		code: MainShader,
	});

	const wireframeModule = device.createShaderModule({
		code: WireframeShader,
	});

	const pipeline = device.createRenderPipeline({
		label: '3 attributes',
		layout: 'auto',
		vertex: {
			module,
			entryPoint: 'vs',
			buffers: [
				{
					arrayStride: (3 + 2 + 1) * 4, // pos , uv, color (4 bytes each)
					attributes: [
						{ shaderLocation: 0, offset: 0, format: 'float32x3' }, // posistion
						{ shaderLocation: 1, offset: 12, format: 'float32x2' }, // uv
						{ shaderLocation: 2, offset: 20, format: 'unorm8x4' }, // color
					],
				},
			],
		},
		fragment: {
			module,
			entryPoint: 'fs',
			targets: [{ format: presentationFormat }],
		},
		primitive: {
			cullMode: 'back',
		},
		depthStencil: {
			depthWriteEnabled: true,
			depthCompare: 'less',
			format: 'depth24plus',
		},
		// wire frame everywhere mode
		// depthStencil: {
		// 	depthWriteEnabled: false,
		// 	depthCompare: 'always',
		// 	format: 'depth24plus',
		// },
	});

	const barycentricCoordinatesBasedWireframePipeline =
		device.createRenderPipeline({
			label: 'barycentric coordinates based wireframe pipeline',
			layout: 'auto',
			vertex: {
				module: wireframeModule,
				entryPoint: 'vsIndexedU32BarycentricCoordinateBasedLines',
			},
			fragment: {
				module: wireframeModule,
				entryPoint: 'fsBarycentricCoordinateBasedLines',
				targets: [
					{
						format: presentationFormat,
						blend: {
							color: {
								srcFactor: 'one',
								dstFactor: 'one-minus-src-alpha',
							},
							alpha: {
								srcFactor: 'one',
								dstFactor: 'one-minus-src-alpha',
							},
						},
					},
				],
			},
			primitive: {
				topology: 'triangle-list',
			},
			depthStencil: {
				depthWriteEnabled: true,
				depthCompare: 'less-equal',
				format: 'depth24plus',
			},
		});

	// Load texture
	const response = await fetch('../assets/dirt.png');
	const imageBitmap = await createImageBitmap(await response.blob());

	const cubeTexture: GPUTexture = device.createTexture({
		size: [imageBitmap.width, imageBitmap.height, 1],
		format: 'rgba8unorm',
		usage:
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_DST |
			GPUTextureUsage.RENDER_ATTACHMENT,
	});
	device.queue.copyExternalImageToTexture(
		{ source: imageBitmap },
		{ texture: cubeTexture },
		[imageBitmap.width, imageBitmap.height],
	);

	// nearest filtering for crisp textures.
	// repeat mode for tiling across greedy-meshed quads
	const sampler = device.createSampler({
		magFilter: 'nearest',
		minFilter: 'nearest',
		addressModeU: 'repeat',
		addressModeV: 'repeat',
	});

	// Single uniform buffer for the view-projection matrix
	const uniformBufferSize = 16 * 4; // mat4x4
	const uniformBuffer = device.createBuffer({
		label: 'uniforms',
		size: uniformBufferSize,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const uniformValues = new Float32Array(uniformBufferSize / 4);

	// Single vertex buffer for the entire greedy-meshed chunk
	const vertexBuffer = device.createBuffer({
		label: 'greedy mesh vertex buffer',
		size: meshVertexData.byteLength,
		usage:
			GPUBufferUsage.VERTEX |
			GPUBufferUsage.STORAGE |
			GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(vertexBuffer, 0, meshVertexData);

	// Single bind group for the entire chunk
	const bindGroup = device.createBindGroup({
		label: 'bind group for chunk',
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			{ binding: 1, resource: sampler },
			{ binding: 2, resource: cubeTexture.createView() },
		],
	});

	// Wireframe bind group
	const wireframeBindGroup = device.createBindGroup({
		label: 'wireframe bindgroup',
		layout: barycentricCoordinatesBasedWireframePipeline.getBindGroupLayout(
			0,
		),
		entries: [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			{ binding: 1, resource: { buffer: vertexBuffer } },
		],
	});

	let depthTexture: GPUTexture;

	function ensureDepthTexture(width: number, height: number) {
		if (
			!depthTexture ||
			depthTexture.width !== width ||
			depthTexture.height !== height
		) {
			depthTexture?.destroy();
			depthTexture = device.createTexture({
				size: [width, height],
				format: 'depth24plus',
				usage: GPUTextureUsage.RENDER_ATTACHMENT,
			});
		}
	}

	function requestRender() {
		if (!renderRequestId) {
			renderRequestId = requestAnimationFrame(() => {
				render();
			});
		}
	}

	BuildDebug(render);
	function render(): void {
		stats.begin();
		renderRequestId = 0;
		debuggerParams.vertices = 0;

		if (canvas === null) throw new Error('No canvas found!');
		// Get the current texture from the canvas context and
		// set it as the texture to render to.
		const canvasTexture = context?.getCurrentTexture();
		if (!canvasTexture) throw new Error('No canvasTexture found!');

		ensureDepthTexture(canvasTexture.width, canvasTexture.height);

		const renderPassDescriptor: GPURenderPassDescriptor = {
			label: 'main pass',
			colorAttachments: [
				{
					view: canvasTexture.createView(),
					loadOp: 'clear',
					storeOp: 'store',
					clearValue: { r: 0, g: 0, b: 0, a: 0 }, // clear totally
				},
			],
			depthStencilAttachment: {
				view: depthTexture.createView(),
				depthClearValue: 1.0,
				depthLoadOp: 'clear',
				depthStoreOp: 'store',
			},
		};

		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass(renderPassDescriptor);
		pass.setPipeline(pipeline);
		pass.setVertexBuffer(0, vertexBuffer);

		const aspect = canvas.clientWidth / canvas.clientHeight;
		const projection = mat4.perspective(
			degToRad(60), // fieldOfView,
			aspect,
			1, // zNear
			5000, // zFar
		);

		const viewMatrix = mat4.lookAt(
			cameraPos,
			vec3.add(cameraPos, cameraFront),
			cameraUp,
		);
		// Compute the view projection matrix
		const viewProjectionMatrix = mat4.multiply(projection, viewMatrix);

		// Upload the view-projection matrix (positions are baked into the mesh)
		uniformValues.set(viewProjectionMatrix);
		device.queue.writeBuffer(uniformBuffer, 0, uniformValues);

		// Single draw call for the entire greedy-meshed chunk
		pass.setBindGroup(0, bindGroup);
		pass.draw(meshNumVertices);
		debuggerParams.vertices = meshNumVertices;

		// Draw wireframes
		if (debuggerParams.wireframe) {
			pass.setPipeline(barycentricCoordinatesBasedWireframePipeline);
			pass.setBindGroup(0, wireframeBindGroup);
			pass.draw(meshNumVertices);
		}

		pass.end();

		const commandBuffer = encoder.finish();
		device.queue.submit([commandBuffer]);

		stats.end();
	}

	const observer = new ResizeObserver((entries) => {
		for (const entry of entries) {
			const canvas = entry.target as HTMLCanvasElement;
			const boxSize = entry.contentBoxSize[0];
			const width = boxSize
				? boxSize.inlineSize
				: entry.contentRect.width;
			const height = boxSize
				? boxSize.blockSize
				: entry.contentRect.height;
			canvas.width = Math.max(
				1,
				Math.min(width, device.limits.maxTextureDimension2D),
			);
			canvas.height = Math.max(
				1,
				Math.min(height, device.limits.maxTextureDimension2D),
			);
			// re-render
			render();
		}
	});
	observer.observe(canvas);

	return;
}
await main();
