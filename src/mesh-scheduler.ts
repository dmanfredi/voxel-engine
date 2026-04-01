import { wrap, transfer } from 'comlink';
import type { Remote } from 'comlink';
import type { MeshWorkerApi } from './mesh-worker';
import type { BlockProps } from './block';
import type { GreedyMeshResult } from './greedy-mesh';

type MeshResultCallback = (
	key: string,
	cx: number,
	cy: number,
	cz: number,
	result: GreedyMeshResult,
) => void;

interface PendingJob {
	key: string;
	revision: number;
	paddedBlocks: Uint8Array;
	cx: number;
	cy: number;
	cz: number;
	priority: 'interactive' | 'streaming';
}

/**
 * Single-worker mesh scheduler with key-based dedup and revision checks.
 *
 * Queues mesh jobs, sends them to a web worker one at a time, and delivers
 * results via callback. Interactive jobs (block break/place) are prioritized
 * over streaming jobs (chunk loading). Superseded jobs are dropped.
 */
export class MeshScheduler {
	private worker: Remote<MeshWorkerApi>;
	private rawWorker: Worker;
	private queue: PendingJob[] = [];
	private busy = false;
	private revisions = new Map<string, number>();
	private blockSize: number;
	private onResult: MeshResultCallback;

	constructor(
		blockSize: number,
		blockProps: BlockProps,
		onResult: MeshResultCallback,
	) {
		this.blockSize = blockSize;
		this.onResult = onResult;

		this.rawWorker = new Worker(
			new URL('./mesh-worker.ts', import.meta.url),
			{ type: 'module' },
		);
		this.worker = wrap<MeshWorkerApi>(this.rawWorker);
		void this.worker.init(blockProps);
	}

	/**
	 * Schedule a mesh job. If a job for the same chunk key is already queued,
	 * it is replaced. If a job for this key is in-flight, its result will be
	 * discarded when it returns (revision mismatch).
	 */
	scheduleMesh(
		key: string,
		paddedBlocks: Uint8Array,
		cx: number,
		cy: number,
		cz: number,
		priority: 'interactive' | 'streaming',
	): void {
		// Bump revision — any in-flight result for an older revision gets dropped
		const revision = (this.revisions.get(key) ?? 0) + 1;
		this.revisions.set(key, revision);

		// Replace any queued job for the same chunk
		const existingIdx = this.queue.findIndex((j) => j.key === key);
		if (existingIdx !== -1) {
			this.queue.splice(existingIdx, 1);
		}

		const job: PendingJob = {
			key,
			revision,
			paddedBlocks,
			cx,
			cy,
			cz,
			priority,
		};

		// Interactive jobs go before streaming jobs
		if (priority === 'interactive') {
			const insertIdx = this.queue.findIndex(
				(j) => j.priority !== 'interactive',
			);
			if (insertIdx === -1) {
				this.queue.push(job);
			} else {
				this.queue.splice(insertIdx, 0, job);
			}
		} else {
			this.queue.push(job);
		}

		void this.processNext();
	}

	/** Cancel any pending/in-flight work for a chunk key (e.g. on unload). */
	cancel(key: string): void {
		this.queue = this.queue.filter((j) => j.key !== key);
		// Bump revision so any in-flight result for this key gets dropped
		this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
	}

	private async processNext(): Promise<void> {
		if (this.busy || this.queue.length === 0) return;

		this.busy = true;
		const job = this.queue.shift();
		if (!job) {
			this.busy = false;
			return;
		}

		try {
			const result = await this.worker.mesh(
				transfer(job.paddedBlocks, [job.paddedBlocks.buffer]),
				job.cx,
				job.cy,
				job.cz,
				this.blockSize,
			);

			// Only deliver if this is still the latest revision for this key
			if (this.revisions.get(job.key) === job.revision) {
				this.onResult(job.key, job.cx, job.cy, job.cz, result);
			}
		} catch (err: unknown) {
			console.error('Mesh worker error:', err);
		}

		this.busy = false;
		void this.processNext();
	}

	dispose(): void {
		this.rawWorker.terminate();
	}
}
