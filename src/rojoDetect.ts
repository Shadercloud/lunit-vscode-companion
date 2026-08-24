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
 */
export function isRojoServeRunning(timeoutMs = 1500): Promise<boolean> {
	const isWindows = process.platform === 'win32';
	const file = isWindows ? 'powershell.exe' : 'ps';
	const args = isWindows
		? [
				'-NoProfile',
				'-Command',
				"Get-CimInstance Win32_Process -Filter \"Name = 'rojo.exe'\" | Select-Object -ExpandProperty CommandLine",
			]
		: ['-A', '-o', 'args='];

	return new Promise((resolve) => {
		execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
			if (error || !stdout) {
				resolve(false);
				return;
			}
			const found = stdout
				.split('\n')
				.some((line) => /\brojo(\.exe)?\b/i.test(line) && /\bserve\b/i.test(line));
			resolve(found);
		});
	});
}
