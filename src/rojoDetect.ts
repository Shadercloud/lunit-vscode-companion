import { execFile } from 'child_process';

/**
 * Best-effort check for whether a `rojo serve` process is currently running
 * anywhere on this machine -- used to warn when the live-sync Studio plugin
 * is connected but `rojo serve` itself doesn't appear to be, since in that
 * case tests would still "work" (the plugin runs fine) but silently run
 * against whatever was last synced -- possibly stale, or from an entirely
 * different project -- rather than your current changes.
 *
 * Looks at the OS process list rather than probing a fixed port: `rojo
 * serve` can be started on any port (`--port`, or a project's `servePort`),
 * so there's no single port that's reliably correct to probe, and asking
 * the OS what's actually running avoids needing a port setting at all.
 *
 * The status bar asks every 2 seconds, so the answer is cached for
 * CACHE_MS and only one check runs at a time. On Windows, reading a
 * process's command line needs WMI, which is expensive (a PowerShell start
 * plus the WMI process provider) and keeps working even after the
 * PowerShell that asked is killed -- polling it every 2 seconds from
 * several windows piled queries up and pinned the CPU in WmiPrvSE. So the
 * cheap `tasklist` runs first, and WMI only when a rojo.exe exists.
 */
const CACHE_MS = 15_000;
const TIMEOUT_MS = 10_000;

let cached: { value: boolean; at: number } | undefined;
let inFlight: Promise<boolean> | undefined;

export function isRojoServeRunning(): Promise<boolean> {
	if (cached && Date.now() - cached.at < CACHE_MS) {
		return Promise.resolve(cached.value);
	}
	if (!inFlight) {
		inFlight = detect()
			.then((value) => {
				cached = { value, at: Date.now() };
				return value;
			})
			.finally(() => {
				inFlight = undefined;
			});
	}
	return inFlight;
}

/** Clears the cache; for tests. */
export function resetRojoDetectCache(): void {
	cached = undefined;
}

function run(file: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
			resolve(error || !stdout ? undefined : stdout);
		});
	});
}

function hasRojoServe(stdout: string | undefined): boolean {
	return (stdout ?? '').split('\n').some((line) => /\brojo(\.exe)?\b/i.test(line) && /\bserve\b/i.test(line));
}

async function detect(): Promise<boolean> {
	if (process.platform !== 'win32') {
		return hasRojoServe(await run('ps', ['-A', '-o', 'args=']));
	}
	const list = await run('tasklist.exe', ['/FI', 'IMAGENAME eq rojo.exe', '/FO', 'CSV', '/NH']);
	if (!list || !/rojo\.exe/i.test(list)) {
		return false;
	}
	return hasRojoServe(
		await run('powershell.exe', [
			'-NoProfile',
			'-Command',
			"Get-CimInstance Win32_Process -Filter \"Name = 'rojo.exe'\" | Select-Object -ExpandProperty CommandLine",
		]),
	);
}
