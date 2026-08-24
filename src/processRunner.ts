import * as cp from 'child_process';
import * as vscode from 'vscode';

export interface RunOptions {
	cwd: string;
	env?: Record<string, string>;
	token?: vscode.CancellationToken;
	timeoutMs?: number;
	onOutput?: (chunk: string) => void;
}

export interface RunResult {
	code: number | null;
	output: string;
	timedOut: boolean;
	cancelled: boolean;
}

/**
 * Runs a shell command, streaming combined stdout/stderr to `onOutput` as it
 * arrives and resolving once the process exits (or is cancelled/timed out).
 */
export function runCommand(command: string, options: RunOptions): Promise<RunResult> {
	return new Promise((resolve) => {
		let output = '';
		let timedOut = false;
		let cancelled = false;
		let settled = false;

		const child = cp.spawn(command, {
			cwd: options.cwd,
			shell: true,
			env: { ...process.env, ...(options.env ?? {}) },
		});

		const append = (data: Buffer) => {
			const text = data.toString();
			output += text;
			options.onOutput?.(text);
		};

		child.stdout?.on('data', append);
		child.stderr?.on('data', append);

		const finish = (code: number | null) => {
			if (settled) {
				return;
			}
			settled = true;
			cancelSub?.dispose();
			if (timer) {
				clearTimeout(timer);
			}
			resolve({ code, output, timedOut, cancelled });
		};

		const cancelSub = options.token?.onCancellationRequested(() => {
			cancelled = true;
			child.kill();
		});

		const timer = options.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, options.timeoutMs)
			: undefined;

		child.on('close', (code) => finish(code));
		child.on('error', (err) => {
			append(Buffer.from(`\n[lunit] failed to launch process: ${err.message}\n`));
			finish(null);
		});
	});
}
