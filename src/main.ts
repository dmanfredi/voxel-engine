import { mat4 } from 'wgpu-matrix';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
if (!navigator.gpu) {
	alert('WebGPU not supported on this browser.');
	throw new Error('WebGPU not supported on this browser.');
}

function createCubeVertices() {
	//prettier-ignore
	const positions: number[] = [
		// left
		0, 0,  0,
		0, 0, -10,
		0, 10,  0,
		0, 10, -10,
	
		// right
		10, 0,  0,
		10, 0, -10,
		10, 10,  0,
		10, 10, -10,
	];

	//prettier-ignore
	const indices: number[] = [
		0,  2,  1,    2,  3,  1,   // left
		4,  5,  6,    6,  5,  7,   // right
		0,  4,  2,    2,  4,  6,   // front
		1,  3,  5,    5,  3,  7,   // back
		0,  1,  4,    4,  1,  5,   // bottom
		2,  6,  3,    3,  6,  7,   // top
	];
	//prettier-ignore
	const quadColors: number[] = [
		200,  70, 120,  // left column front
		80,  70, 200,  // left column back
		70, 200, 210,  // top
		160, 160, 220,  // top rung right
		90, 130, 110,  // top rung bottom
		200, 200,  70,  // between top and middle rung
  	];

	const numVertices = indices.length;
	const vertexData = new Float32Array(numVertices * 4); // xyz + color
	const colorData = new Uint8Array(vertexData.buffer);

	for (const [i, index] of indices.entries()) {
		const positionNdx = index * 3;

		const posistion = positions.slice(positionNdx, positionNdx + 3);
		vertexData.set(posistion, i * 4);

		const quadNdx = ((i / 6) | 0) * 3;
		const color = quadColors.slice(quadNdx, quadNdx + 3);
		colorData.set(color, i * 16 + 12); // Set RGB
		colorData[i * 16 + 15] = 255; // Set A
	}

	return {
		vertexData,
		numVertices,
	};
}

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

	const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
	const device = await adapter.requestDevice();

	context.configure({
		device,
		format: presentationFormat,
		alphaMode: 'premultiplied',
	});

	const module = device.createShaderModule({
		code: /*wgsl*/ `
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

			@vertex fn vs(vert: Vertex) -> VSOutput {
				var vsOut: VSOutput;
  				vsOut.position = uni.matrix * vert.position;
				vsOut.color = vert.color;
				return vsOut;
			}

			@fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
				return vsOut.color;
			}
		`,
	});

	const pipeline = device.createRenderPipeline({
		label: '2 attributes',
		layout: 'auto',
		vertex: {
			module,
			buffers: [
				{
					arrayStride: 4 * 4, // (3) floats 4 bytes each+ one 4 byte color
					attributes: [
						{ shaderLocation: 0, offset: 0, format: 'float32x3' }, // posistion
						{ shaderLocation: 1, offset: 12, format: 'unorm8x4' }, // color
					],
				},
			],
		},
		fragment: {
			module,
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
	});

	const numFs = 25;
	const objectInfos: {
		uniformBuffer: GPUBuffer;
		uniformValues: Float32Array<ArrayBuffer>;
		matrixValue: Float32Array<ArrayBuffer>;
		bindGroup: GPUBindGroup;
	}[] = [];
	for (let i = 0; i < numFs; i++) {
		// matrix
		const uniformBufferSize = 16 * 4;
		const uniformBuffer = device.createBuffer({
			label: 'uniforms',
			size: uniformBufferSize,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});

		const uniformValues = new Float32Array(uniformBufferSize / 4);

		// offsets to the various uniform values in float32 indices
		const kMatrixOffset = 0;
		const matrixValue = uniformValues.subarray(
			kMatrixOffset,
			kMatrixOffset + 16
		);

		const bindGroup = device.createBindGroup({
			label: 'bind group for object',
			layout: pipeline.getBindGroupLayout(0),
			entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
		});

		objectInfos.push({
			uniformBuffer,
			uniformValues,
			matrixValue,
			bindGroup,
		});
	}

	const { vertexData, numVertices } = createCubeVertices();
	const vertexBuffer = device.createBuffer({
		label: 'vertex buffer vertices',
		size: vertexData.byteLength,
		usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(vertexBuffer, 0, vertexData);

	const degToRad = (d: number) => (d * Math.PI) / 180;

	let depthTexture: GPUTexture;
	const cameraAngle = 0;
	const radius = 200;
	const fieldOfView = degToRad(100);

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

	function render(canvas: HTMLCanvasElement) {
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
			fieldOfView,
			aspect,
			1, // zNear
			2000 // zFar
		);

		// compute a matrix for the camera.
		// const cameraMatrix = mat4.rotationY(cameraAngle);
		// mat4.translate(cameraMatrix, [0, 0, radius * 1.5], cameraMatrix);

		// compute the position of the first F
		const fPosistion = [radius, 0, 0];

		// Use matrix math to compute a position on a circle where the camera is
		const tempMatrix = mat4.rotationY(cameraAngle);
		mat4.translate(tempMatrix, [0, 0, radius * 1.5], tempMatrix);
		const eye = tempMatrix.slice(12, 15);
		const up = [0, 1, 0];

		// Compute a view matrix
		const viewMatrix = mat4.lookAt(eye, fPosistion, up);
		const viewProjectionMatrix = mat4.multiply(projection, viewMatrix);

		objectInfos.forEach(
			({ matrixValue, uniformBuffer, uniformValues, bindGroup }, i) => {
				const angle = (i / numFs) * Math.PI * 2;
				const x = Math.cos(angle) * radius;
				const z = Math.sin(angle) * radius;

				mat4.translate(viewProjectionMatrix, [x, 0, z], matrixValue);

				// upload the uniform values to the uniform buffer
				device.queue.writeBuffer(uniformBuffer, 0, uniformValues);

				pass.setBindGroup(0, bindGroup);
				pass.draw(numVertices);
			}
		);

		pass.end();

		const commandBuffer = encoder.finish();
		device.queue.submit([commandBuffer]);
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
				Math.min(width, device.limits.maxTextureDimension2D)
			);
			canvas.height = Math.max(
				1,
				Math.min(height, device.limits.maxTextureDimension2D)
			);
			// re-render
			render(canvas);
		}
	});
	observer.observe(canvas);

	return;
}
await main();
