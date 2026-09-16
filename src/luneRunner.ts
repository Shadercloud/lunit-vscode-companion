import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CancelSignal } from './cancelSignal';
import { LunitConfig } from './config';
import { SlowTestFilter } from './luauTestFilterTemplate';
import { LunePlan, PlanError, planLuneRun } from './luneBlocks';
import { assessBlock, ModuleListing, parseModuleListing, WorkerJob } from './luneBlockProtocol';
import { buildLuneGameRunnerScript } from './luneGameScriptTemplate';
import { detectLuneProject, LuneProjectDetection } from './luneProjectKind';
import { resolveWorkerCount, runBlocks } from './luneScheduler';
import { buildLuneRunnerScript } from './luneScriptTemplate';
import { runCommand } from './processRunner';
import { buildRojoDataModelModule } from './rojoDataModelTemplate';
import { BlockReport, createRunReport, formatReportSummary, LuneRunReport, TestIdentity } from './runReport';
import { describeToolFailure } from './toolDiagnostics';

export interface RunOutcome {
	code: number | null;
	output: string;
	timedOut: boolean;
	cancelled: boolean;
}

/**
 * Progress callbacks of a parallel Lune run, so the Test Explorer can move
 * items from queued to running to their verdict as blocks finish rather than
 * only at the end. Every hook receives the live report (runReport.ts).
 */
export interface LuneRunHooks {
	/** The plan is final: blocks, their tests, and what could not be scheduled. */
	onPlan?(report: LuneRunReport): void;
	onBlockStart?(block: BlockReport, report: LuneRunReport): void;
	onBlockDone?(block: BlockReport, report: LuneRunReport): void;
}

export interface LuneRunOptions {
	/** Leaves out the slow tests it does not explicitly allow; undefined runs them all. */
	slow?: SlowTestFilter;
	/** Tests to run; undefined runs everything the profile allows. */
	selection?: readonly TestIdentity[];
	/** Overrides `lunit.lune.parallel.workers` for this run. */
	workers?: number;
	hooks?: LuneRunHooks;
}

/** A Lune run's outcome; `report` is present whenever the run got as far as discovering test modules. */
export interface LuneRunOutcome extends RunOutcome {
	report?: LuneRunReport;
}

const RUNS_DIR_NAME = 'lune-runs';
const GENERATED_SCRIPT_NAME = 'lune-runner.luau';
const GENERATED_GAME_SCRIPT_NAME = 'lune-game-runner.luau';
const GENERATED_DATA_MODEL_NAME = 'lune-rbx.luau';
const LUNIT_PROMISE_RELATIVE = path.join('node_modules', '@rbxts', 'lunit', 'scripts', 'promise.luau');
/** Run directories a crashed session left behind are removed once this old. */
const STALE_RUN_DIR_MS = 24 * 60 * 60 * 1000;

/**
 * Lune's `require()` only accepts `./`, `../`, or `@`-prefixed paths -- never
 * absolute ones -- so the generated script's require of Lunit's `promise.luau`
 * has to stay relative. Returns undefined if no relative path exists at all
 * (Node's `path.relative` falls back to returning `to` unchanged when the two
 * paths are on different Windows drives), so the caller can fall back to
 * putting the generated script somewhere that *can* reach it relatively.
 */
function toLuneRequirePath(fromDir: string, toFileNoExt: string): string | undefined {
	const rel = path.relative(fromDir, toFileNoExt).split(path.sep).join('/');
	if (path.isAbsolute(rel)) {
		return undefined;
	}
	return rel.startsWith('.') ? rel : `./${rel}`;
}

function forwardSlashes(value: string): string {
	return value.split(path.sep).join('/');
}

function seconds(ms: number): number {
	return Math.round(ms / 100) / 10;
}

/** Splits streamed chunks into whole lines and hands each one on with a prefix, so interleaved worker logs stay attributable. */
export function createLinePrefixer(prefix: string, sink: (text: string) => void): { feed: (chunk: string) => void; flush: () => void } {
	let buffer = '';
	return {
		feed: (chunk: string) => {
			buffer += chunk;
			const pieces = buffer.split(/(?<=\n)/);
			const last = pieces[pieces.length - 1];
			buffer = /\n$/.test(last) ? '' : (pieces.pop() ?? '');
			for (const piece of pieces) {
				sink(prefix + piece);
			}
		},
		flush: () => {
			if (buffer.length > 0) {
				sink(prefix + buffer + '\n');
			}
			buffer = '';
		},
	};
}

/** The generated scripts of one run, in a directory no other run writes to. */
interface PreparedScripts {
	runDir: string;
	listCommand: string;
	jobCommand: (jobFile: string) => string;
	/** How a worker module path is shown to users and matched against dependency groups. */
	displayName: (modulePath: string) => string;
	/** Where the run looks for tests, for the "nothing found" message. */
	whereTests: string;
	cleanup: () => Promise<void>;
}

async function pruneStaleRuns(runsDir: string): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(runsDir, { withFileTypes: true });
	} catch {
		return;
	}
	const cutoff = Date.now() - STALE_RUN_DIR_MS;
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const full = path.join(runsDir, entry.name);
		try {
			const stat = await fs.promises.stat(full);
			if (stat.mtimeMs < cutoff) {
				await fs.promises.rm(full, { recursive: true, force: true });
			}
		} catch {
			// Another run may be using it; leave it.
		}
	}
}

/**
 * Writes this run's generated scripts into a fresh directory under the
 * extension's storage, so concurrent runs (two Test Explorer runs, or the
 * command line beside one) never overwrite each other's files, and returns
 * the commands that drive them.
 */
async function prepareScripts(
	config: LunitConfig,
	detection: LuneProjectDetection,
	onOutput: (chunk: string) => void,
): Promise<PreparedScripts | { error: string }> {
	const cwd = config.workspaceRoot;
	const runId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
	let baseDir = config.storageDir;
	let promiseRequirePath: string | undefined;

	if (detection.kind === 'package') {
		const promisePath = path.join(cwd, LUNIT_PROMISE_RELATIVE);
		if (!fs.existsSync(promisePath)) {
			return { error: `[lunit] could not find ${LUNIT_PROMISE_RELATIVE} -- is @rbxts/lunit installed in this project?` };
		}
		const promiseNoExt = promisePath.replace(/\.luau$/, '');
		promiseRequirePath = toLuneRequirePath(path.join(baseDir, RUNS_DIR_NAME, runId), promiseNoExt);
		if (promiseRequirePath === undefined) {
			// storageDir and the project are on different drives, so no relative
			// path between them exists -- fall back to generating inside the
			// workspace (the one case where that's unavoidable) rather than
			// producing a script that can never load Lunit.
			baseDir = path.join(cwd, '.vscode', 'lunit');
			promiseRequirePath = toLuneRequirePath(path.join(baseDir, RUNS_DIR_NAME, runId), promiseNoExt);
			onOutput(
				`[lunit] ${config.storageDir} is on a different drive than this project; generating the Lune scripts into ${baseDir} instead.\n`,
			);
		}
	}

	const runsDir = path.join(baseDir, RUNS_DIR_NAME);
	const runDir = path.join(runsDir, runId);
	await fs.promises.mkdir(runDir, { recursive: true });
	void pruneStaleRuns(runsDir);
	const cleanup = async () => {
		try {
			await fs.promises.rm(runDir, { recursive: true, force: true });
		} catch {
			// Best effort; pruneStaleRuns catches it next time.
		}
	};
	const quote = (value: string) => `"${forwardSlashes(value)}"`;

	if (detection.kind === 'game') {
		const projectFile = detection.projectFile!;
		await fs.promises.writeFile(path.join(runDir, GENERATED_DATA_MODEL_NAME), buildRojoDataModelModule(), 'utf8');
		const scriptPath = path.join(runDir, GENERATED_GAME_SCRIPT_NAME);
		await fs.promises.writeFile(
			scriptPath,
			buildLuneGameRunnerScript(`./${GENERATED_DATA_MODEL_NAME.replace(/\.luau$/, '')}`),
			'utf8',
		);
		// A Rojo project's `$path` entries and `globIgnorePaths` are both relative
		// to the project file, and the generated DataModel matches ignore patterns
		// against project-relative paths -- so pass a relative project path
		// whenever one exists, and run from the workspace root.
		const relative = forwardSlashes(path.relative(cwd, projectFile));
		const projectArg =
			relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : forwardSlashes(projectFile);
		const base = `${config.lune.executable} run ${quote(scriptPath)} "${projectArg}"`;
		return {
			runDir,
			listCommand: `${base} --list`,
			jobCommand: (jobFile) => `${base} --job ${quote(jobFile)}`,
			displayName: (modulePath) => modulePath,
			whereTests: `the tree described by "${projectArg}" (set "lunit.lune.projectFile" if a different Rojo project describes your tests)`,
			cleanup,
		};
	}

	const scriptPath = path.join(runDir, GENERATED_SCRIPT_NAME);
	await fs.promises.writeFile(scriptPath, buildLuneRunnerScript(promiseRequirePath!), 'utf8');
	// The generated script's own path-manipulation (Parent lookups, child
	// concatenation -- see luneScriptTemplate.ts / luauShimTemplate.ts) is all
	// forward-slash string logic, since that's what Lune's require() needs.
	// testsRoot/lunitRoot flow into that same logic via process.args, so they
	// need the same normalization -- `path.join`-built values contain
	// backslashes on Windows, which silently breaks any relative import
	// inside a test file (confirmed: a file with no relative imports of its
	// own loaded fine, one that imported a sibling module failed with
	// "attempt to index nil with 'Parent'").
	const testsRootArg = forwardSlashes(config.lune.testsRoot);
	const lunitRootArg = forwardSlashes(config.lune.lunitRoot);
	const base = `${config.lune.executable} run ${quote(scriptPath)} "${testsRootArg}" "${lunitRootArg}"`;
	const root = forwardSlashes(cwd).replace(/\/+$/, '');
	return {
		runDir,
		listCommand: `${base} --list`,
		jobCommand: (jobFile) => `${base} --job ${quote(jobFile)}`,
		displayName: (modulePath) => {
			const normalized = forwardSlashes(modulePath);
			return normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? normalized.slice(root.length + 1) : normalized;
		},
		whereTests: `"${testsRootArg}" (set "lunit.testsRoot" if your compiled tests live somewhere else)`,
		cleanup,
	};
}

function errorReport(message: string, singleProcess: boolean, compileSeconds: number, discoverySeconds: number): LuneRunReport {
	return {
		blocks: [],
		unscheduled: [],
		notes: [],
		workers: 0,
		singleProcess,
		compileSeconds,
		discoverySeconds,
		error: message,
		loadFailures: [],
		excludedClasses: 0,
		excludedTests: 0,
		slowLeftOut: 0,
		longBlockSeconds: 10,
	};
}

function describeEmptyPlan(listing: ModuleListing, plan: LunePlan, whereTests: string): string {
	if (listing.modules.length === 0 && listing.excludedModules.length === 0 && listing.loadFailures.length === 0) {
		return `[lunit] No tests found in ${whereTests}.`;
	}
	const reasons: string[] = [];
	if (plan.counts.excludedClasses > 0 || plan.counts.excludedTests > 0) {
		reasons.push(
			`${plan.counts.excludedClasses} Studio-tagged test class(es) and ${plan.counts.excludedTests} Studio-tagged test(s) belong to the Studio profile`,
		);
	}
	if (plan.counts.slowLeftOut > 0) {
		reasons.push(`${plan.counts.slowLeftOut} slow test(s) left out (run with Lune (Full))`);
	}
	if (listing.loadFailures.length > 0) {
		reasons.push(`${listing.loadFailures.length} test module(s) failed to load`);
	}
	const errored = plan.unscheduled.filter((entry) => entry.status === 'errored').length;
	if (errored > 0) {
		reasons.push(`${errored} selected test(s) could not be scheduled`);
	}
	return `[lunit] nothing to run under this profile${reasons.length > 0 ? `: ${reasons.join('; ')}` : ''}.`;
}

/**
 * Compiles the project (unless skipped), then runs the Lune profile as a
 * pool of independent Lune processes:
 *
 * 1. A discovery process loads every test module once and lists each
 *    class's compiled Lunit metadata (luneBlockProtocol.ts).
 * 2. The planner (luneBlocks.ts) turns that, the selection, the slow rule
 *    and `lunit.lune.parallel.dependencyGroups` into blocks: one module per
 *    block, one method or @Each row per block for @Tag("Parallel") classes,
 *    one process for a dependency group.
 * 3. The scheduler (luneScheduler.ts) runs them through at most `workers`
 *    processes, starting the next pending block the moment one finishes.
 *    Each worker's output streams through `onOutput` prefixed with its block
 *    id; its result lines and closing summary are judged by `assessBlock`.
 *
 * The returned outcome carries the live report, from which verdicts are
 * resolved (runReport.ts). With `lunit.lune.parallel.enabled` off, the plan
 * is one block holding every module, in one process.
 */
export async function runViaLune(
	config: LunitConfig,
	token: CancelSignal,
	onOutput: (chunk: string) => void,
	options: LuneRunOptions = {},
): Promise<LuneRunOutcome> {
	const cwd = config.workspaceRoot;
	const startedAt = Date.now();
	const singleProcess = !config.lune.parallel.enabled;
	let compileSeconds = 0;

	if (!config.skipCompile) {
		onOutput(`> ${config.compileCommand}\n`);
		const compileStarted = Date.now();
		const compileResult = await runCommand(config.compileCommand, { cwd, env: config.env, token, onOutput });
		compileSeconds = seconds(Date.now() - compileStarted);
		if (compileResult.cancelled || compileResult.timedOut) {
			return compileResult;
		}
		if (compileResult.code !== 0) {
			const diagnosis = describeToolFailure(compileResult.output);
			onOutput(
				diagnosis
					? `\n${diagnosis}\n`
					: `\n[lunit] compile command exited with code ${compileResult.code}, aborting test run.\n`,
			);
			return compileResult;
		}
	}

	const detection = detectLuneProject({
		workspaceRoot: cwd,
		outDir: config.outDir,
		configuredProjectFile: config.lune.projectFile,
	});
	if (detection.blocked) {
		const message = `${detection.blocked}\n`;
		onOutput(message);
		return { code: null, output: message, timedOut: false, cancelled: false };
	}
	if (detection.kind === 'game') {
		onOutput(`[lunit] ${detection.reason}.\n`);
	}

	const prepared = await prepareScripts(config, detection, onOutput);
	if ('error' in prepared) {
		const message = `${prepared.error}\n`;
		onOutput(message);
		return { code: null, output: message, timedOut: false, cancelled: false };
	}

	try {
		// 1. Discovery.
		const discoveryStarted = Date.now();
		onOutput(`> ${prepared.listCommand}\n`);
		const listResult = await runCommand(prepared.listCommand, {
			cwd,
			env: config.env,
			token,
			onOutput,
			killTree: true,
			windowsHide: true,
		});
		const discoverySeconds = seconds(Date.now() - discoveryStarted);
		if (listResult.cancelled || listResult.timedOut) {
			return listResult;
		}
		const parsed = parseModuleListing(listResult.output);
		if ('error' in parsed) {
			const diagnosis = describeToolFailure(listResult.output);
			const message =
				diagnosis ?? `[lunit] test discovery failed (Lune exited with code ${listResult.code}): ${parsed.error}.`;
			onOutput(`\n${message}\n`);
			return {
				code: listResult.code ?? 1,
				output: listResult.output,
				timedOut: false,
				cancelled: false,
				report: errorReport(message, singleProcess, compileSeconds, discoverySeconds),
			};
		}
		const listing = parsed.listing;

		// 2. Plan.
		let plan: LunePlan;
		try {
			plan = planLuneRun({
				listing,
				selection: options.selection,
				slow: options.slow,
				excludedTag: detection.kind === 'game' ? 'Studio' : undefined,
				dependencyGroups: config.lune.parallel.dependencyGroups,
				isolation: singleProcess ? 'single' : 'blocks',
				displayName: prepared.displayName,
			});
		} catch (err) {
			if (!(err instanceof PlanError)) {
				throw err;
			}
			const message = `[lunit] ${err.message}`;
			onOutput(`${message}\n`);
			return {
				code: 1,
				output: listResult.output,
				timedOut: false,
				cancelled: false,
				report: errorReport(message, singleProcess, compileSeconds, discoverySeconds),
			};
		}
		const workers = resolveWorkerCount({
			configured: config.lune.parallel.workers,
			override: options.workers,
			blockCount: plan.blocks.length,
		});
		const report = createRunReport(plan, workers, singleProcess, listing.loadFailures);
		report.compileSeconds = compileSeconds;
		report.discoverySeconds = discoverySeconds;
		for (const note of plan.notes) {
			onOutput(`${note}\n`);
		}
		for (const entry of plan.unscheduled) {
			if (entry.status === 'errored') {
				onOutput(`[lunit] ${entry.test.className}.${entry.test.methodName}: ${entry.reason}\n`);
			}
		}
		if (plan.blocks.length === 0) {
			onOutput(`${describeEmptyPlan(listing, plan, prepared.whereTests)}\n`);
			report.wallSeconds = seconds(Date.now() - startedAt);
			options.hooks?.onPlan?.(report);
			return {
				code: listing.loadFailures.length > 0 ? 1 : 0,
				output: listResult.output,
				timedOut: false,
				cancelled: false,
				report,
			};
		}
		const shape = singleProcess
			? 'every module in one Lune process (lunit.lune.parallel.enabled is off)'
			: [
					`${plan.blocks.length} block${plan.blocks.length === 1 ? '' : 's'} on ${workers} worker${workers === 1 ? '' : 's'}`,
					plan.counts.parallelClasses > 0
						? `${plan.counts.parallelClasses} @Tag("Parallel") class(es) split into ${plan.counts.caseBlocks} case block(s)`
						: undefined,
				]
					.filter((part) => part !== undefined)
					.join('; ');
		onOutput(`[lunit] ${shape}.\n`);
		onOutput(`> ${prepared.jobCommand('<job>')}\n`);
		options.hooks?.onPlan?.(report);

		// 3. Schedule.
		const jobPath = (index: number) => path.join(prepared.runDir, `job-${index}.json`);
		await Promise.all(
			plan.blocks.map((block) => {
				const job: WorkerJob = { block: `#${block.index}`, modules: block.modules };
				return fs.promises.writeFile(jobPath(block.index), JSON.stringify(job), 'utf8');
			}),
		);
		const outputs: string[] = [];
		let anyFailed = false;
		await runBlocks(
			report.blocks,
			workers,
			async (block) => {
				block.status = 'running';
				options.hooks?.onBlockStart?.(block, report);
				onOutput(`[lunit] #${block.index} started: ${block.label}\n`);
				const blockStarted = Date.now();
				const prefixer = createLinePrefixer(`[#${block.index}] `, onOutput);
				const result = await runCommand(prepared.jobCommand(jobPath(block.index)), {
					cwd,
					env: config.env,
					token,
					onOutput: prefixer.feed,
					killTree: true,
					windowsHide: true,
				});
				prefixer.flush();
				return { result, seconds: seconds(Date.now() - blockStarted) };
			},
			(block, _index, { result, seconds: blockSeconds }) => {
				const assessment = assessBlock(result);
				block.status = assessment.status;
				block.error = assessment.error;
				block.records = assessment.records;
				block.summary = assessment.summary;
				block.loadFailures = assessment.summary?.loadFailures ?? [];
				block.seconds = blockSeconds;
				block.exitCode = result.code;
				outputs.push(`[#${block.index}] ${block.label}\n${result.output}`);
				const verdict = { passed: 'PASS', failed: 'FAIL', errored: 'ERROR', cancelled: 'CANCELLED' }[assessment.status];
				if (assessment.status === 'failed' || assessment.status === 'errored') {
					anyFailed = true;
				}
				const detail = assessment.error ? `: ${assessment.error.split(/\r?\n/)[0]}` : '';
				onOutput(`[lunit] #${block.index} ${verdict} ${block.label} (${blockSeconds.toFixed(1)} s)${detail}\n`);
				options.hooks?.onBlockDone?.(block, report);
			},
			() => token.isCancellationRequested,
		);

		const cancelled = token.isCancellationRequested;
		let notRun = 0;
		for (const block of report.blocks) {
			if (block.status === 'pending' || block.status === 'running') {
				block.status = 'cancelled';
				notRun += 1;
			}
		}
		report.wallSeconds = seconds(Date.now() - startedAt);
		if (cancelled) {
			onOutput(`[lunit] run cancelled; ${notRun} block(s) did not run.\n`);
		}
		for (const line of formatReportSummary(report)) {
			onOutput(`${line}\n`);
		}
		return { code: anyFailed ? 1 : 0, output: outputs.join('\n'), timedOut: false, cancelled, report };
	} finally {
		await prepared.cleanup();
	}
}
