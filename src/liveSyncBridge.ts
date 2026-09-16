import * as http from 'http';
import { randomUUID } from 'crypto';
import { CancelSignal, CancelSource } from './cancelSignal';
import { RunSummary, RunVia, SUMMARY_MARKER } from './runReport';

/** Body of a `POST /run` request from the CLI (cli.ts) -- see `LiveSyncBridge.runHandler`. */
export interface CliRunRequest {
	/** Absolute directory the CLI was invoked from; the handler maps it to one of its workspace folders. */
	cwd: string;
	via: RunVia;
	/** See runReport.ts's `matchesFilters`. */
	filters: string[];
	/** With `via: 'lune'`, "Run with Lune (Full)": include slow-tagged tests. */
	full?: boolean;
	/** With `via: 'lune'`, overrides `lunit.lune.parallel.workers` for this run. */
	workers?: number;
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

export const BRIDGE_PORT_COUNT = 20;
export interface BridgeWorkspace { name: string; path: string }

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
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private listenError: NodeJS.ErrnoException | undefined;
	private lastPluginSeenAt = 0;
	private currentJob: { id: string; code: string; delivered: boolean; resolve: (output: string) => void } | undefined;
	private jobCounter = 0;
	private candidatePort = this.port;
	private readonly instanceId = randomUUID();

	constructor(
		private readonly port: number,
		private readonly onError?: (err: Error) => void,
		private readonly retryDelayMs = 0,
		private readonly workspaces?: BridgeWorkspace[],
	) {}

	start(): void {
		if (this.server) {
			return;
		}
		const server = http.createServer((req, res) => this.handleRequest(req, res));
		this.server = server;
		server.on('listening', () => { this.listenError = undefined; });
		server.on('error', (err: NodeJS.ErrnoException) => {
			if (this.server !== server) { return; }
			if (err.code === 'EADDRINUSE' && this.workspaces && this.candidatePort < Math.min(65535, this.port + BRIDGE_PORT_COUNT - 1)) {
				server.listen(++this.candidatePort, '127.0.0.1');
				return;
			}
			const changed = this.listenError?.message !== err.message;
			this.listenError = err;
			if (err.code === 'EADDRINUSE' && this.retryDelayMs > 0 && !this.retryTimer) {
				this.retryTimer = setTimeout(() => {
					this.retryTimer = undefined;
					this.candidatePort = this.port;
					if (this.server === server) { server.listen(this.candidatePort, '127.0.0.1'); }
				}, this.retryDelayMs);
				this.retryTimer.unref();
			}
			if (changed) { this.onError?.(err); }
		});
		this.candidatePort = this.port;
		server.listen(this.candidatePort, '127.0.0.1');
	}

	stop(): void {
		clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.server?.close();
		this.server = undefined;
		this.listenError = undefined;
		this.lastPluginSeenAt = 0;
	}

	get connectionError(): string | undefined {
		if (!this.listenError) { return undefined; }
		if (this.listenError.code === 'EADDRINUSE') {
			if (this.workspaces) { return `All Studio bridge ports ${this.port}-${Math.min(65535, this.port + BRIDGE_PORT_COUNT - 1)} are occupied. Close unused VS Code windows, or change lunit.studio.liveSync.port and reinstall the Studio plugin. Retrying automatically.`; }
			return `Port ${this.port} is already in use by another process (often another VS Code window). This window cannot receive Studio polls. Close the other window or disable Lunit there, then reload this window if needed. Alternatively, change lunit.studio.liveSync.port, reload this window, and reinstall and reload the Studio plugin to match.`;
		}
		return `Cannot start the Studio bridge on 127.0.0.1:${this.port}: ${this.listenError.message}`;
	}

	/** True once the plugin has polled recently enough to be considered live right now. */
	get isPluginConnected(): boolean {
		return this.server?.listening === true && (this.currentJob?.delivered === true || Date.now() - this.lastPluginSeenAt < 5000);
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
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		if (req.method === 'GET' && url.pathname === '/info') {
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ protocol: 'lunit-bridge-1', instanceId: this.instanceId,
				workspaces: this.workspaces ?? [], pid: process.pid, acceptsRuns: !!this.runHandler }));
			return;
		}
		// A selected window's port can be reused after it exits. Never accept
		// a stale selection as a heartbeat or deliver a different window's job.
		if (url.searchParams.has('instanceId') && url.searchParams.get('instanceId') !== this.instanceId) {
			res.statusCode = 409;
			res.end('The selected VS Code window has closed. Select a window again in Studio.');
			return;
		}
		if (req.method === 'GET' && url.pathname === '/poll') {
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

		if (req.method === 'POST' && url.pathname === '/run') {
			this.handleCliRun(req, res);
			return;
		}

		if (req.method === 'POST' && url.pathname === '/result') {
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
				request = {
					cwd: parsed.cwd,
					via: parsed.via,
					filters: Array.isArray(parsed.filters) ? parsed.filters.map(String) : [],
					full: parsed.full === true,
					workers: typeof parsed.workers === 'number' && Number.isInteger(parsed.workers) && parsed.workers > 0 ? parsed.workers : undefined,
				};
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
