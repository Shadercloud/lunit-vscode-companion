import * as os from 'os';

/**
 * The bounded worker pool behind the parallel Lune profile, kept free of any
 * process or `vscode` dependency so it can be unit-tested with fake blocks.
 */

/** Never more workers than this by default: beyond it, concurrent VM startup costs more than it saves on the machines measured. */
export const DEFAULT_MAX_WORKERS = 32;

export interface WorkerCountInput {
	/** `lunit.lune.parallel.workers`: 0 means "pick automatically". */
	configured: number;
	/** A per-run override (the command line's `--workers`). */
	override?: number;
	blockCount: number;
	/** Logical CPUs; defaults to the machine's. */
	available?: number;
}

/**
 * How many Lune processes a run may have alive at once: the override, else
 * the setting, else min(32, logical CPUs); never more than there are blocks,
 * never fewer than one.
 */
export function resolveWorkerCount(input: WorkerCountInput): number {
	const available = input.available ?? os.availableParallelism();
	const pick = (value: number | undefined): number | undefined =>
		value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
	const requested = pick(input.override) ?? pick(input.configured) ?? Math.min(DEFAULT_MAX_WORKERS, Math.max(1, available));
	return Math.max(1, Math.min(requested, Math.max(1, input.blockCount)));
}

/**
 * Runs `blocks` through at most `workers` concurrent `run` calls. Each block
 * is started exactly once, in order, and a freed slot immediately takes the
 * next pending block rather than waiting for a whole batch to finish.
 * `onDone` is called for each block as it finishes, in completion order.
 * Once `shouldStop()` reports true no further block starts; blocks already
 * running finish (or are cancelled by whatever `run` observes) on their own.
 * Resolves once every started block has completed.
 */
export async function runBlocks<B, R>(
	blocks: readonly B[],
	workers: number,
	run: (block: B, index: number) => Promise<R>,
	onDone: (block: B, index: number, result: R) => void,
	shouldStop: () => boolean = () => false,
): Promise<void> {
	let cursor = 0;
	const slots = Math.max(1, Math.min(Math.floor(workers), blocks.length));
	const loop = async (): Promise<void> => {
		while (cursor < blocks.length && !shouldStop()) {
			const index = cursor++;
			const result = await run(blocks[index], index);
			onDone(blocks[index], index, result);
		}
	};
	await Promise.all(Array.from({ length: slots }, loop));
}
