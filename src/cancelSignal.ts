/**
 * Structurally compatible with `vscode.CancellationToken`, without importing
 * `vscode` -- so the runners (luneRunner.ts, studioRunner.ts, processRunner.ts)
 * and the live-sync bridge can be shared as-is by the standalone CLI
 * (cli.ts), which runs outside VS Code entirely.
 */
export interface CancelSignal {
	isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

/** Minimal CancellationTokenSource equivalent for use outside VS Code. */
export class CancelSource {
	private cancelled = false;
	private readonly listeners = new Set<() => void>();
	readonly token: CancelSignal;

	constructor() {
		const self = this;
		this.token = {
			get isCancellationRequested() {
				return self.cancelled;
			},
			onCancellationRequested(listener) {
				self.listeners.add(listener);
				if (self.cancelled) {
					listener();
				}
				return { dispose: () => self.listeners.delete(listener) };
			},
		};
	}

	cancel(): void {
		if (this.cancelled) {
			return;
		}
		this.cancelled = true;
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}
