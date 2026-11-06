import { execFile } from 'child_process';

/**
 * Whether a Roblox Studio process is running on this machine, for the
 * live-sync bridge (liveSyncBridge.ts `studioRunning`): a plugin heartbeat
 * that goes quiet means either Studio is busy (a synchronous test holds its
 * main thread, so the plugin cannot send anything) or Studio is gone. The
 * process list tells those apart: no Studio process means gone, release the
 * run now; a Studio process means busy, keep waiting.
 *
 * Only asked while a heartbeat is overdue, at most every few seconds (the
 * bridge caches the answer). Uses the cheap `tasklist` on Windows and `ps`
 * elsewhere, never WMI. Resolves undefined when the list cannot be read, so
 * the bridge falls back to its plain heartbeat timeout.
 *
 * With several Studio windows open, closing the one running the tests leaves
 * the others: then the answer is "running" and the run is released at
 * lunit.studio.testTimeoutSeconds rather than at once.
 */
const TIMEOUT_MS = 5_000;

function run(file: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
			resolve(error ? undefined : stdout);
		});
	});
}

/** True if `stdout` of the process listing names a Roblox Studio process. */
export function listsRobloxStudio(stdout: string, platform: NodeJS.Platform): boolean {
	return platform === 'win32'
		? /RobloxStudioBeta\.exe/i.test(stdout)
		: stdout.split('\n').some((line) => /RobloxStudio(Beta)?(\.app)?\b/i.test(line) && !/RobloxStudioInstaller/i.test(line));
}

export async function isRobloxStudioRunning(): Promise<boolean | undefined> {
	const stdout = process.platform === 'win32'
		? await run('tasklist.exe', ['/FI', 'IMAGENAME eq RobloxStudioBeta.exe', '/FO', 'CSV', '/NH'])
		: await run('ps', ['-A', '-o', 'comm=']);
	return stdout === undefined ? undefined : listsRobloxStudio(stdout, process.platform);
}
