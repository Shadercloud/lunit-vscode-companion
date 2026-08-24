import * as http from 'http';

/** Structurally compatible with vscode.CancellationToken, without importing `vscode`. */
export interface CancelSignal {
	isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

/**
 * Local (127.0.0.1-only) HTTP server the companion Studio plugin
 * (studioPluginTemplate.ts) polls for on-demand test-run jobs. Deliberately
 * plain Node `http`, no `vscode` dependency, so it's easy to reason about
 * and test in isolation.
 *
 * Runs continuously from extension activation (not just while a test run is
 * in flight) specifically so `isPluginConnected` reflects reality *before*
 * the user asks to run anything -- that's what lets studioRunner.ts decide
 * between the live-sync fast path and building+launching a fresh Studio
 * without the user having to choose.
 */
export class LiveSyncBridge {
	private server: http.Server | undefined;
	private lastPluginSeenAt = 0;
	private currentJob: { id: string; code: string; resolve: (output: string) => void } | undefined;
	private jobCounter = 0;

	constructor(
		private readonly port: number,
		private readonly onError?: (err: Error) => void,
	) {}

	start(): void {
		if (this.server) {
			return;
		}
		const server = http.createServer((req, res) => this.handleRequest(req, res));
		server.on('error', (err) => this.onError?.(err));
		server.listen(this.port, '127.0.0.1');
		this.server = server;
	}

	stop(): void {
		this.server?.close();
		this.server = undefined;
	}

	/** True once the plugin has polled recently enough to be considered live right now. */
	get isPluginConnected(): boolean {
		return this.server !== undefined && Date.now() - this.lastPluginSeenAt < 5000;
	}

	/**
	 * Queues `code` for the next plugin poll and resolves with whatever it
	 * returns once the plugin posts a result back, or rejects on timeout.
	 * Only one job may be in flight at a time (the plugin itself only ever
	 * runs one job per poll cycle anyway).
	 */
	runJob(code: string, timeoutMs: number, cancelSignal?: CancelSignal): Promise<string> {
		if (this.currentJob) {
			return Promise.reject(new Error('a live-sync test run is already in progress'));
		}
		return new Promise<string>((resolve, reject) => {
			const id = `job-${++this.jobCounter}-${Date.now()}`;

			const settle = (fn: () => void) => {
				if (this.currentJob?.id === id) {
					this.currentJob = undefined;
				}
				cancelSub?.dispose();
				clearTimeout(timeoutHandle);
				fn();
			};

			const timeoutHandle = setTimeout(() => {
				settle(() =>
					reject(
						new Error(
							`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the Roblox Studio plugin to run the tests and report back -- is it still installed and enabled?`,
						),
					),
				);
			}, timeoutMs);

			const cancelSub = cancelSignal?.onCancellationRequested(() => {
				settle(() => reject(new Error('cancelled')));
			});

			this.currentJob = {
				id,
				code,
				resolve: (output) => settle(() => resolve(output)),
			};
		});
	}

	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		if (req.method === 'GET' && req.url === '/poll') {
			this.lastPluginSeenAt = Date.now();
			res.setHeader('Content-Type', 'application/json');
			res.end(
				this.currentJob
					? JSON.stringify({ jobId: this.currentJob.id, code: this.currentJob.code })
					: JSON.stringify({ jobId: null }),
			);
			return;
		}

		if (req.method === 'POST' && req.url === '/result') {
			let body = '';
			req.on('data', (chunk: Buffer) => {
				body += chunk.toString('utf8');
			});
			req.on('end', () => {
				try {
					const parsed = JSON.parse(body) as { jobId?: string; output?: string };
					if (this.currentJob && parsed.jobId === this.currentJob.id) {
						const job = this.currentJob;
						this.currentJob = undefined;
						job.resolve(parsed.output ?? '');
					}
				} catch {
					// Malformed body -- ignore; the job will time out naturally if this
					// was meant to be its result.
				}
				res.end('{}');
			});
			return;
		}

		res.statusCode = 404;
		res.end();
	}
}
