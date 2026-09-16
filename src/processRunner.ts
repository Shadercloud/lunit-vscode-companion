import * as cp from 'child_process';
import { CancelSignal } from './cancelSignal';

export interface RunOptions {
	cwd: string;
	env?: Record<string, string>;
	token?: CancelSignal;
	timeoutMs?: number;
	onOutput?: (chunk: string) => void;
	/**
	 * On cancel or timeout, kill the whole process tree rather than only the
	 * shell `spawn` started: with `shell: true` the command runs as a
	 * grandchild (cmd.exe or sh, then lune), and a toolchain shim such as
	 * Rokit's adds another level, so `child.kill()` alone can leave the real
	 * process running. The Lune workers use this; a cancelled run must stop
	 * every one of them.
	 */
	killTree?: boolean;
	/** Never show a console window for the process on Windows (the Lune workers). */
	windowsHide?: boolean;
}

export interface RunResult {
	code: number | null;
	output: string;
	timedOut: boolean;
	cancelled: boolean;
}

/** Ends `child` and, with `tree`, everything it started. Best effort: a process that already exited is left alone. */
export function killProcess(child: cp.ChildProcess, tree: boolean): void {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	if (tree && process.platform === 'win32') {
		try {
			const killer = cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
			killer.on('error', () => child.kill());
			return;
		} catch {
			// taskkill unavailable: fall back to the plain kill below.
		}
	} else if (tree) {
		try {
			// Spawned detached, the shell leads its own process group.
			process.kill(-child.pid, 'SIGTERM');
			return;
		} catch {
			// Not a group leader after all: fall back to the plain kill below.
		}
	}
	child.kill();
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
		const tree = options.killTree === true;

		const child = cp.spawn(command, {
			cwd: options.cwd,
			shell: true,
			env: { ...process.env, ...(options.env ?? {}) },
			windowsHide: options.windowsHide === true,
			detached: tree && process.platform !== 'win32',
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
			killProcess(child, tree);
		});

		const timer = options.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					killProcess(child, tree);
				}, options.timeoutMs)
			: undefined;

		child.on('close', (code) => finish(code));
		child.on('error', (err) => {
			append(Buffer.from(`\n[lunit] failed to launch process: ${err.message}\n`));
			finish(null);
		});
	});
}
