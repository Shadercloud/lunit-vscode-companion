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

/** What `POST /cancel` (lunit-cli --cancel) and the reset command report. */
export interface CancelReport {
	/** A Studio job was held (queued, or delivered and awaited) and has been released. */
	releasedJob: boolean;
	/** CLI-initiated runs in flight that were cancelled. */
	cancelledRuns: number;
}

/**
 * A delivered job's plugin heartbeats (see studioPluginTemplate.ts) arrive
 * about once a second. When a *different* plugin session polls and the owning
 * session has been silent this long, the Studio that took the job is gone
 * (restarted, or its plugin reloaded) and the job is released at once.
 */
const SESSION_SWITCH_SILENCE_MS = 2500;

/** `runJob` options. */
export interface RunJobOptions {
	/**
	 * While the plugin reports the job running tests, a Studio still running
	 * on this machine may go this long without a heartbeat (a synchronous test
	 * holds its main thread) before the run is released. Default 120 s.
	 */
	testTimeoutMs?: number;
	/** Each batch of output lines the plugin streams while the job runs (live results). */
	onLines?: (lines: string[]) => void;
}

/**
 * How `runJob` fails when the run had to be released partway (Studio silent
 * or gone, the run timed out, or it was released by hand): carries the
 * output the plugin had streamed so far, so results already in are kept.
 */
export class LiveSyncReleasedError extends Error {
	constructor(
		message: string,
		/** Output lines streamed in heartbeats before the release, joined by newlines. */
		readonly partialOutput: string,
		/** Why the tests that never reported were not run to the end; the verdict for each of them. */
		readonly unfinishedReason: string,
	) {
		super(message);
	}
}

/** The job's state as its latest heartbeat reported it. */
interface JobProgress {
	/** "loading" | "tests" while the job runs; undefined before the first heartbeat. */
	phase?: string;
	/** The test running at the last heartbeat (class > label), if any. */
	test?: string;
	/** Date.now() when that test started, from the plugin's own clock. */
	testStartedAt?: number;
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
	private currentJob: {
		id: string;
		code: string;
		delivered: boolean;
		/** The plugin session (one per loaded plugin) the job was delivered to. */
		session?: string;
		lastHeartbeat: number;
		progress: JobProgress;
		/** Output lines the plugin streamed with its heartbeats. */
		partialLines: string[];
		testTimeoutMs: number;
		onLines?: (lines: string[]) => void;
		resolve: (output: string) => void;
		/** Releases the job: fails the waiting run, keeping the output streamed so far. */
		release: (message: string, unfinishedReason?: string) => void;
	} | undefined;
	private readonly cliRuns = new Set<CancelSource>();
	/**
	 * A delivered job whose plugin has sent no heartbeat for this long is
	 * released: Studio was closed, crashed or restarted -- unless the job is
	 * busy running tests (then `testTimeoutMs` applies) or Studio is known to
	 * still be running. Only applies to plugins that report a session id.
	 */
	heartbeatTimeoutMs = 15000;
	/**
	 * Whether a Roblox Studio process is running on this machine: true, false,
	 * or undefined when that cannot be told. Installed by the extension and the
	 * CLI (studioProcess.ts). It lets a heartbeat silence be read: Studio gone
	 * means release now; Studio running means a blocking test, so wait.
	 */
	studioRunning: (() => Promise<boolean | undefined>) | undefined;
	private probe: { at: number; value: boolean | undefined; pending?: Promise<void> } = { at: 0, value: undefined };
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
	 * returns once the plugin posts a result back, or rejects on timeout,
	 * cancellation, `abandonCurrentJob`, or a Studio that stops sending
	 * heartbeats. Only one job may be in flight at a time.
	 *
	 * The run lock never outlives the caller's wait: however the wait ends,
	 * the job is released at once. A plugin still executing a released job
	 * learns from its next heartbeat (`active: false`) and cancels it before
	 * it polls again, so the next job never runs alongside the old one.
	 */
	runJob(code: string, timeoutMs: number, cancelSignal?: CancelSignal, options: RunJobOptions = {}): Promise<string> {
		if (cancelSignal?.isCancellationRequested) {
			return Promise.reject(new Error('cancelled'));
		}
		if (this.currentJob) {
			return Promise.reject(new Error('another live-sync test run is executing in Studio right now. Wait for it, stop it, or release it with "Lunit: Cancel and Release the Roblox Studio Live-Sync Run" (or lunit-cli --cancel)'));
		}
		return new Promise<string>((resolve, reject) => {
			const id = `job-${++this.jobCounter}-${Date.now()}`;

			let settled = false;
			let cancelSub: { dispose(): void } | undefined;
			const settle = (fn: () => void) => {
				if (settled) { return; }
				settled = true;
				if (this.currentJob?.id === id) {
					this.currentJob = undefined;
				}
				cancelSub?.dispose();
				clearTimeout(timeoutHandle);
				clearInterval(watchdog);
				fn();
			};
			const release = (message: string, unfinishedReason = message) => {
				const lines = this.currentJob?.id === id ? this.currentJob.partialLines : [];
				settle(() => reject(new LiveSyncReleasedError(message, lines.join('\n'), unfinishedReason)));
			};

			const timeoutHandle = setTimeout(() => {
				release(
					`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the Roblox Studio plugin to run the tests and report back; the run was released and Studio told to abandon the job`,
					`the run timed out after ${Math.round(timeoutMs / 1000)}s before this test reported a result`,
				);
			}, timeoutMs);

			const watchdog = setInterval(() => this.checkHeartbeat(id), Math.min(1000, Math.max(10, Math.floor(this.heartbeatTimeoutMs / 4))));
			watchdog.unref?.();

			this.currentJob = {
				id,
				code,
				delivered: false,
				lastHeartbeat: Date.now(),
				progress: {},
				partialLines: [],
				testTimeoutMs: options.testTimeoutMs ?? 120000,
				onLines: options.onLines,
				resolve: (output) => settle(() => resolve(output)),
				release,
			};
			cancelSub = cancelSignal?.onCancellationRequested(() => {
				settle(() => reject(new Error('cancelled')));
			});
			if (settled) { cancelSub?.dispose(); }

		});
	}

	/** True while a job is queued or delivered and its caller is still waiting for it. */
	get hasActiveJob(): boolean {
		return this.currentJob !== undefined;
	}

	/**
	 * Releases the run lock now, failing the waiting run with `reason`. A
	 * plugin still running the job abandons it at its next heartbeat. Returns
	 * whether there was a job to release.
	 */
	abandonCurrentJob(reason: string): boolean {
		const job = this.currentJob;
		if (!job) { return false; }
		job.release(reason);
		return true;
	}

	/**
	 * Reads a delivered job's heartbeat silence (see `heartbeatTimeoutMs`):
	 * - Studio known gone (no Studio process) after `heartbeatTimeoutMs`: released.
	 * - Busy -- the plugin reported the job running tests, or a Studio process is
	 *   still running -- the silence may last `testTimeoutMs` (a synchronous test
	 *   holds Studio's main thread); past that the run is released, naming the test.
	 * - Otherwise `heartbeatTimeoutMs` of silence releases it, as before.
	 */
	private checkHeartbeat(id: string): void {
		const job = this.currentJob;
		if (job?.id !== id || !job.delivered || !job.session) { return; }
		const now = Date.now();
		const silence = now - job.lastHeartbeat;
		if (silence <= this.heartbeatTimeoutMs) { return; }
		const studio = this.studioProbe(now);
		const { test, testStartedAt, phase } = job.progress;
		const seconds = (ms: number) => Math.round(ms / 1000);
		const culprit = test
			? `${test} (running ${seconds(now - (testStartedAt ?? job.lastHeartbeat))}s when the run was released)`
			: undefined;
		if (studio === false) {
			job.release(
				`Roblox Studio is no longer running (no plugin heartbeat for ${seconds(silence)}s${culprit ? `; the last test it reported was ${culprit}` : ''}). The run was released.`,
				`run released: Roblox Studio stopped running${test ? ` during ${test}` : ''}`,
			);
			return;
		}
		const busy = phase === 'tests' || studio === true;
		// The probe's first answer takes a moment; give it a few seconds before
		// reading an unexplained silence as a dead Studio.
		if (!busy && studio === undefined && this.studioRunning && silence <= this.heartbeatTimeoutMs + 5000) { return; }
		if (!busy) {
			job.release(
				`Roblox Studio stopped responding while running the tests (no plugin heartbeat for ${seconds(silence)}s): it was probably closed, restarted, or its Lunit plugin reloaded. The run was released.`,
				`run released: no heartbeat from Roblox Studio for ${seconds(silence)}s`,
			);
			return;
		}
		if (silence > job.testTimeoutMs) {
			const limit = seconds(job.testTimeoutMs);
			job.release(
				`Roblox Studio sent no heartbeat for ${seconds(silence)}s while running the tests${culprit ? `; the last test it reported was ${culprit}` : ''}. That is past lunit.studio.testTimeoutSeconds (${limit}s), so the run was released. A test that runs this long without yielding blocks Studio: tag it Slow or make it yield.`,
				`run released after ${test ?? 'a test'} ran ${limit}s+ without a heartbeat`,
			);
		}
	}

	private recordProgress(job: NonNullable<LiveSyncBridge['currentJob']>, body: string): void {
		let parsed: { phase?: unknown; test?: unknown; testSeconds?: unknown; lines?: unknown };
		try {
			parsed = JSON.parse(body);
		} catch {
			return;
		}
		if (Array.isArray(parsed.lines)) {
			const lines = parsed.lines.filter((line): line is string => typeof line === 'string');
			job.partialLines.push(...lines);
			if (lines.length > 0 && job.onLines) {
				try { job.onLines(lines); } catch { /* a consumer's error must not break the bridge */ }
			}
		}
		const test = typeof parsed.test === 'string' ? parsed.test : undefined;
		const testSeconds = typeof parsed.testSeconds === 'number' && Number.isFinite(parsed.testSeconds) ? parsed.testSeconds : 0;
		job.progress = {
			phase: typeof parsed.phase === 'string' ? parsed.phase : undefined,
			test,
			testStartedAt: test ? Date.now() - Math.max(0, testSeconds) * 1000 : undefined,
		};
	}

	/** The cached `studioRunning` answer, refreshed in the background at most every 3 s. */
	private studioProbe(now: number): boolean | undefined {
		const probe = this.studioRunning;
		if (!probe) { return undefined; }
		if (now - this.probe.at > 3000 && !this.probe.pending) {
			this.probe.pending = probe()
				.then((value) => { this.probe = { at: Date.now(), value }; }, () => { this.probe = { at: Date.now(), value: undefined }; })
				.finally(() => { this.probe.pending = undefined; });
		}
		// A stale answer (from before this silence) is not evidence either way.
		return now - this.probe.at <= 6000 ? this.probe.value : undefined;
	}

	/** `lunit-cli --cancel` and the reset command: cancels CLI runs in flight and releases any held job. */
	cancelAll(reason: string): CancelReport {
		// Cancelling a run waiting on the job already releases it; report the
		// job as released either way.
		const held = this.hasActiveJob;
		const runs = [...this.cliRuns];
		for (const run of runs) { run.cancel(); }
		this.abandonCurrentJob(reason);
		return { releasedJob: held, cancelledRuns: runs.length };
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
		const session = url.searchParams.get('session') ?? undefined;
		if (req.method === 'GET' && url.pathname === '/poll') {
			this.lastPluginSeenAt = Date.now();
			res.setHeader('Content-Type', 'application/json');
			const held = this.currentJob;
			// A new plugin session polling while the session holding the job has
			// gone quiet: Studio restarted or the plugin reloaded mid-job. The old
			// job can never report back, so release it now instead of at timeout.
			if (held?.delivered && held.session && session && session !== held.session
				&& Date.now() - held.lastHeartbeat > SESSION_SWITCH_SILENCE_MS) {
				held.release(
					'Roblox Studio reconnected with a new plugin session (Studio restarted or the Lunit plugin reloaded) before the delivered job reported back. The run was released.',
					'run released: Roblox Studio restarted (or its Lunit plugin reloaded) before this test reported a result',
				);
			}
			const job = this.currentJob;
			if (job && !job.delivered) {
				job.delivered = true;
				job.session = session;
				job.lastHeartbeat = Date.now();
				res.end(JSON.stringify({ jobId: job.id, code: job.code }));
				job.code = '';
			} else {
				res.end(JSON.stringify({ jobId: null }));
			}
			return;
		}

		// While a plugin executes a job it reports in about once a second. The
		// answer tells it whether anyone still wants the job; when not, it
		// cancels the job and cleans up before polling again.
		// A POST (current plugins) also carries the job's progress: its phase,
		// the test running and for how long, and new output lines.
		if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/heartbeat') {
			let body = '';
			req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
			req.on('end', () => {
				this.lastPluginSeenAt = Date.now();
				const job = this.currentJob;
				const active = job !== undefined && job.delivered && job.id === url.searchParams.get('jobId');
				if (job && active) {
					job.lastHeartbeat = Date.now();
					job.session ??= session;
					if (body) { this.recordProgress(job, body); }
				}
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify({ active }));
			});
			return;
		}

		if (req.method === 'POST' && url.pathname === '/cancel') {
			req.resume();
			req.on('end', () => {
				const report = this.cancelAll('the live-sync run was cancelled and released (lunit-cli --cancel)');
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify(report));
			});
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
			this.cliRuns.add(cancel);
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
				.finally(() => this.cliRuns.delete(cancel))
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
