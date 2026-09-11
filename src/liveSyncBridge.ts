import * as http from 'http';
import { CancelSignal, CancelSource } from './cancelSignal';
import { RunSummary, RunVia, SUMMARY_MARKER } from './runReport';

/** Body of a `POST /run` request from the CLI (cli.ts) -- see `LiveSyncBridge.runHandler`. */
export interface CliRunRequest {
	/** Absolute directory the CLI was invoked from; the handler maps it to one of its workspace folders. */
	cwd: string;
	via: RunVia;
	/** See runReport.ts's `matchesFilters`. */
	filters: string[];
}

/**
 * Executes one CLI-initiated run end-to-end, streaming human-readable output
 * to `onOutput` as it happens and resolving with the run's structured
 * summary once done. Installed by extension.ts, where it goes through the
 * exact same code path as a Test Explorer run (so results land in the
 * Testing view too).
 */
export type CliRunHandler = (
	request: CliRunRequest,
	onOutput: (text: string) => void,
	cancel: CancelSignal,
) => Promise<RunSummary>;

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
	/**
	 * When set, `POST /run` (from cli.ts) is accepted and delegated here. Only
	 * the VS Code extension installs one -- the CLI's own standalone bridge
	 * (used when no extension is listening on the port) leaves it unset and
	 * answers 503, so a second CLI can never accidentally run through a first.
	 */
	runHandler: CliRunHandler | undefined;

	private server: http.Server | undefined;
	private lastPluginSeenAt = 0;
	private currentJob: { id: string; code: string; delivered: boolean; resolve: (output: string) => void } | undefined;
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
		return this.server !== undefined && (this.currentJob?.delivered === true || Date.now() - this.lastPluginSeenAt < 5000);
	}

	/**
	 * Queues `code` for the next plugin poll and resolves with whatever it
	 * returns once the plugin posts a result back, or rejects on timeout.
	 * Only one job may be in flight at a time (the plugin itself only ever
	 * runs one job per poll cycle anyway).
	 */
	runJob(code: string, timeoutMs: number, cancelSignal?: CancelSignal): Promise<string> {
		if (cancelSignal?.isCancellationRequested) {
			return Promise.reject(new Error('cancelled'));
		}
		if (this.currentJob) {
			return Promise.reject(new Error('a live-sync test run is still executing or awaiting cleanup acknowledgement in Studio'));
		}
		return new Promise<string>((resolve, reject) => {
			const id = `job-${++this.jobCounter}-${Date.now()}`;

			let settled = false;
			let cancelSub: { dispose(): void } | undefined;
			const settle = (fn: () => void, drain = false) => {
				if (settled) { return; }
				settled = true;
				if (this.currentJob?.id === id && !(drain && this.currentJob.delivered)) {
					this.currentJob = undefined;
				}
				if (drain && this.currentJob?.id === id) {
					// Keep only the acknowledgement lock after the caller has left.
					this.currentJob.code = '';
					this.currentJob.resolve = () => {};
				}
				cancelSub?.dispose();
				clearTimeout(timeoutHandle);
				fn();
			};

			const timeoutHandle = setTimeout(() => {
				settle(() =>
					reject(
						new Error(
							`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the Roblox Studio plugin to run the tests and report back; delivered jobs retain the run lock until Studio finishes and acknowledges cleanup`,
						),
					),
					true,
				);
			}, timeoutMs);

			this.currentJob = {
				id,
				code,
				delivered: false,
				resolve: (output) => settle(() => resolve(output)),
			};
			cancelSub = cancelSignal?.onCancellationRequested(() => {
				settle(() => reject(new Error('cancelled')), true);
			});
			if (settled) { cancelSub?.dispose(); }

		});
	}

	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		if (req.method === 'GET' && req.url === '/poll') {
			this.lastPluginSeenAt = Date.now();
			res.setHeader('Content-Type', 'application/json');
			const job = this.currentJob;
			if (job && !job.delivered) {
				job.delivered = true;
				res.end(JSON.stringify({ jobId: job.id, code: job.code }));
				job.code = '';
			} else {
				res.end(JSON.stringify({ jobId: null }));
			}
			return;
		}

		if (req.method === 'POST' && req.url === '/run') {
			this.handleCliRun(req, res);
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

	/**
	 * Streams the run's output back as plain text as it happens, then a final
	 * `@@LUNIT_SUMMARY@@{json}` line (see runReport.ts). The client hanging up
	 * mid-run (Ctrl+C in the terminal) cancels the run, exactly like the
	 * Test Explorer's own stop button.
	 */
	private handleCliRun(req: http.IncomingMessage, res: http.ServerResponse): void {
		let body = '';
		req.on('data', (chunk: Buffer) => {
			body += chunk.toString('utf8');
		});
		req.on('end', () => {
			const handler = this.runHandler;
			if (!handler) {
				res.statusCode = 503;
				res.setHeader('Content-Type', 'text/plain; charset=utf-8');
				res.end('The process listening on this port is not the Lunit VS Code extension (it cannot accept test runs).');
				return;
			}
			let request: CliRunRequest;
			try {
				const parsed = JSON.parse(body) as Partial<CliRunRequest>;
				if (typeof parsed.cwd !== 'string' || (parsed.via !== 'lune' && parsed.via !== 'studio')) {
					throw new Error('missing cwd/via');
				}
				request = { cwd: parsed.cwd, via: parsed.via, filters: Array.isArray(parsed.filters) ? parsed.filters.map(String) : [] };
			} catch {
				res.statusCode = 400;
				res.end('Malformed /run request body.');
				return;
			}

			res.statusCode = 200;
			res.setHeader('Content-Type', 'text/plain; charset=utf-8');
			res.setHeader('Cache-Control', 'no-cache');
			res.setHeader('X-Content-Type-Options', 'nosniff');
			res.flushHeaders();

			const cancel = new CancelSource();
			res.on('close', () => {
				if (!res.writableFinished) {
					cancel.cancel();
				}
			});

			handler(request, (text) => {
				if (!res.writableEnded) {
					res.write(text);
				}
			}, cancel.token)
				.then((summary) => {
					if (!res.writableEnded) {
						res.end(`\n${SUMMARY_MARKER}${JSON.stringify(summary)}\n`);
					}
				})
				.catch((err: unknown) => {
					if (!res.writableEnded) {
						const summary: RunSummary = {
							via: request.via,
							cancelled: false,
							tests: [],
							counts: { passed: 0, failed: 0, skipped: 0, errored: 0 },
							error: err instanceof Error ? err.message : String(err),
						};
						res.end(`\n${SUMMARY_MARKER}${JSON.stringify(summary)}\n`);
					}
				});
		});
	}
}
