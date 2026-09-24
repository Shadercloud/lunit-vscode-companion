import { BlockKind, BlockTest, LunePlan, moduleMatchesSource, TestRef, UnscheduledTest } from './luneBlocks';
import { BlockStatus, BlockSummary, ModuleLoadFailure } from './luneBlockProtocol';
import { RunOutcome } from './luneRunner';
import { aggregateForLabel, ResultRecord } from './resultProtocol';

/**
 * The single source of truth for turning a run's raw output into per-test
 * verdicts, shared by both routes into the runners: the Test Explorer
 * (extension.ts, which maps each verdict onto a `vscode.TestRun`) and the
 * command line (cli.ts, which prints them). Keeping this logic here -- with
 * no `vscode` import -- is what guarantees an agent running tests from a
 * terminal sees exactly the same pass/fail/skip/error outcomes and messages
 * as a user clicking "Run in Roblox Studio" in VS Code.
 */

export type RunVia = 'lune' | 'studio';

/** What identifies one `@Test` method, independent of how it was discovered. */
export interface TestIdentity {
	/** Absolute path of the source file. */
	file: string;
	className: string;
	methodName: string;
	displayName?: string;
}

export type VerdictStatus = 'passed' | 'failed' | 'skipped' | 'errored';

export interface Verdict {
	status: VerdictStatus;
	message?: string;
	elapsedMs?: number;
}

/**
 * Whether a test with these effective `@Tag`s (class-level + method-level,
 * case-insensitive) runs under the given profile: `@Tag("Studio")` means
 * "skip under Lune", `@Tag("Lune")` means "skip under Roblox Studio", no
 * matching tag means "runs under both". See extension.ts for how this maps
 * onto VS Code's TestTags.
 */
export function runsUnder(effectiveTags: readonly string[], via: RunVia): boolean {
	const lower = effectiveTags.map((t) => t.toLowerCase());
	return via === 'lune' ? !lower.includes('studio') : !lower.includes('lune');
}

export const NO_RESULTS_MESSAGE =
	'No structured results were found in the run output. Check the Lunit output channel for compile/runtime errors.';
export const NO_MATCH_MESSAGE =
	'No matching result found in test output for this item. It may not have run (check that its container/tags are discovered by your bootstrap script), or its class name at runtime does not match what was expected.';
export const TIMED_OUT_MESSAGE = 'Run timed out before this test reported a result.';

/** Resolves one test's verdict from the structured result lines a completed run produced. */
export function resolveVerdict(test: TestIdentity, records: readonly ResultRecord[], outcome: RunOutcome): Verdict {
	const baseLabel = test.displayName ?? test.methodName;
	const match = aggregateForLabel(records, test.className, baseLabel);
	if (match) {
		if (match.status === 'passed') {
			return { status: 'passed', elapsedMs: match.elapsedMs };
		}
		if (match.status === 'failed') {
			return { status: 'failed', message: match.message ?? 'Test failed', elapsedMs: match.elapsedMs };
		}
		return { status: 'skipped' };
	}
	if (outcome.timedOut) {
		return { status: 'errored', message: TIMED_OUT_MESSAGE };
	}
	if (outcome.error && records.length === 0) {
		return { status: 'errored', message: outcome.error };
	}
	if (outcome.code !== 0 && records.length === 0) {
		return { status: 'errored', message: NO_RESULTS_MESSAGE };
	}
	return { status: 'errored', message: NO_MATCH_MESSAGE };
}

// ---------------------------------------------------------------------------
// Parallel Lune runs: one report per run, one entry per block
// ---------------------------------------------------------------------------

export type BlockRunStatus = 'pending' | 'running' | BlockStatus;

export interface BlockReport {
	index: number;
	kind: BlockKind;
	label: string;
	tests: BlockTest[];
	status: BlockRunStatus;
	/** Why the whole block is errored. */
	error?: string;
	records: ResultRecord[];
	summary?: BlockSummary;
	/** Modules of this block that failed to load, as the worker reported them. */
	loadFailures: ModuleLoadFailure[];
	seconds?: number;
	exitCode?: number | null;
}

/**
 * Everything a parallel Lune run knows about itself, updated in place as
 * blocks finish so the Test Explorer can report progress and the summary can
 * be printed at the end.
 */
export interface LuneRunReport {
	blocks: BlockReport[];
	unscheduled: UnscheduledTest[];
	notes: string[];
	workers: number;
	/** `lunit.lune.parallel.enabled` false: everything in one Lune process. */
	singleProcess: boolean;
	compileSeconds: number;
	discoverySeconds: number;
	/** Set once the run is over. */
	wallSeconds?: number;
	/** A problem that stopped the run before or while scheduling; every test is errored with it. */
	error?: string;
	/** Modules the discovery step could not load; a test whose source matches one is errored with its reason. */
	loadFailures: ModuleLoadFailure[];
	/** Studio-tagged (or otherwise excluded) classes/tests the run left out, for the closing note. */
	excludedClasses: number;
	excludedTests: number;
	slowLeftOut: number;
	/** Blocks longer than this many seconds are listed at the end as optimization targets, never failed. */
	longBlockSeconds: number;
}

export function createRunReport(
	plan: LunePlan,
	workers: number,
	singleProcess: boolean,
	loadFailures: ModuleLoadFailure[] = [],
): LuneRunReport {
	return {
		loadFailures,
		blocks: plan.blocks.map((block) => ({
			index: block.index,
			kind: block.kind,
			label: block.label,
			tests: block.tests,
			status: 'pending',
			records: [],
			loadFailures: [],
		})),
		unscheduled: plan.unscheduled,
		notes: plan.notes,
		workers,
		singleProcess,
		compileSeconds: 0,
		discoverySeconds: 0,
		excludedClasses: plan.counts.excludedClasses,
		excludedTests: plan.counts.excludedTests,
		slowLeftOut: plan.counts.slowLeftOut,
		longBlockSeconds: 10,
	};
}

function testKey(test: TestRef): string {
	return `${test.className}\u0000${test.methodName}`;
}

/** The blocks whose results a test depends on: one, or one per @Each row of a Parallel class. */
export function blocksForTest(report: LuneRunReport, test: TestRef): BlockReport[] {
	const key = testKey(test);
	return report.blocks.filter((block) => block.tests.some((candidate) => testKey(candidate) === key));
}

export function isTerminalBlockStatus(status: BlockRunStatus): boolean {
	return status === 'passed' || status === 'failed' || status === 'errored' || status === 'cancelled';
}

/**
 * Resolves one test's verdict from a parallel run's report. Every problem
 * is explicit: a block that crashed, was cancelled, never reported a result
 * for the test, or could not be scheduled at all yields an error or a skip
 * with the reason, never a pass by omission.
 */
export function resolveBlockVerdict(test: TestIdentity, report: LuneRunReport): Verdict {
	const unscheduled = report.unscheduled.find((entry) => testKey(entry.test) === testKey(test));
	if (unscheduled) {
		return { status: unscheduled.status, message: unscheduled.reason };
	}
	if (report.error) {
		return { status: 'errored', message: report.error };
	}
	const blocks = blocksForTest(report, test);
	if (blocks.length === 0) {
		const failure = report.loadFailures.find((entry) => moduleMatchesSource(test.file, entry.path));
		if (failure) {
			return { status: 'errored', message: `the compiled test module ${failure.path} failed to load: ${failure.error}` };
		}
		return {
			status: 'errored',
			message: `no compiled test class named "${test.className}" with a @Test method "${test.methodName}" was found in this Lune run. Is the project compiled, and does its module 'export =' the class?`,
		};
	}
	const errored = blocks.find((block) => block.status === 'errored');
	if (errored) {
		return { status: 'errored', message: `block #${errored.index} (${errored.label}): ${errored.error ?? 'errored'}` };
	}
	for (const block of blocks) {
		const membership = block.tests.find((candidate) => testKey(candidate) === testKey(test));
		const loadFailure = membership && block.loadFailures.find((entry) => entry.path === membership.modulePath);
		if (loadFailure) {
			return { status: 'errored', message: `block #${block.index} (${block.label}): failed to load ${loadFailure.path}: ${loadFailure.error}` };
		}
	}
	if (blocks.some((block) => !isTerminalBlockStatus(block.status) || block.status === 'cancelled')) {
		return { status: 'skipped', message: 'the run was cancelled before this test finished' };
	}
	const records = blocks.flatMap((block) => block.records);
	const match = aggregateForLabel(records, test.className, test.displayName ?? test.methodName);
	if (match) {
		if (match.status === 'passed') {
			return { status: 'passed', elapsedMs: match.elapsedMs };
		}
		if (match.status === 'failed') {
			return { status: 'failed', message: match.message ?? 'Test failed', elapsedMs: match.elapsedMs };
		}
		return { status: 'skipped', message: match.message };
	}
	const where = blocks.map((block) => `#${block.index} (${block.label}, exit code ${block.exitCode ?? '?'})`).join(', ');
	return {
		status: 'errored',
		message: `block ${where} finished without reporting a result for this test. Its class name or @DisplayName at run time may differ from the source, or the worker stopped early; see the Lunit output for the block.`,
	};
}

/** Tests of a just-finished block whose every block is now terminal, so their verdicts are final. */
export function testsResolvedBy(report: LuneRunReport, block: BlockReport): TestRef[] {
	const seen = new Set<string>();
	const resolved: TestRef[] = [];
	for (const test of block.tests) {
		const key = testKey(test);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		if (blocksForTest(report, test).every((other) => isTerminalBlockStatus(other.status))) {
			resolved.push({ className: test.className, methodName: test.methodName });
		}
	}
	return resolved;
}

export interface RunTimingSummary {
	blocks: number;
	workers: number;
	wallSeconds: number;
	passed: number;
	failed: number;
	errored: number;
	cancelled: number;
	longest?: { label: string; seconds: number };
	/** Blocks over `report.longBlockSeconds`, longest first. */
	long: { label: string; seconds: number }[];
}

export function summarizeReport(report: LuneRunReport): RunTimingSummary {
	const timed = report.blocks
		.filter((block): block is BlockReport & { seconds: number } => block.seconds !== undefined)
		.map((block) => ({ label: `#${block.index} ${block.label}`, seconds: block.seconds }))
		.sort((a, b) => b.seconds - a.seconds);
	const count = (status: BlockRunStatus) => report.blocks.filter((block) => block.status === status).length;
	return {
		blocks: report.blocks.length,
		workers: report.workers,
		wallSeconds: report.wallSeconds ?? 0,
		passed: count('passed'),
		failed: count('failed'),
		errored: count('errored'),
		cancelled: count('cancelled') + count('pending') + count('running'),
		longest: timed[0],
		long: timed.filter((entry) => entry.seconds > report.longBlockSeconds),
	};
}

/** The closing lines of a parallel Lune run, as printed to the output channel and the terminal. */
export function formatReportSummary(report: LuneRunReport): string[] {
	const summary = summarizeReport(report);
	const seconds = (value: number) => `${value.toFixed(1)} s`;
	const lines: string[] = [];
	const parts = [`${summary.passed} passed`, `${summary.failed} failed`];
	if (summary.errored > 0) {
		parts.push(`${summary.errored} errored`);
	}
	if (summary.cancelled > 0) {
		parts.push(`${summary.cancelled} not run`);
	}
	const how = report.singleProcess ? 'in one Lune process' : `on ${summary.workers} worker${summary.workers === 1 ? '' : 's'}`;
	const phases = [`compile ${seconds(report.compileSeconds)}`, `discovery ${seconds(report.discoverySeconds)}`];
	lines.push(`[lunit] ${summary.blocks} block${summary.blocks === 1 ? '' : 's'} ${how} in ${seconds(summary.wallSeconds)} wall time (${phases.join(', ')}): ${parts.join(', ')}.`);
	if (summary.longest) {
		const over = summary.long.length;
		const list = summary.long
			.slice(0, 5)
			.map((entry) => `${entry.label} (${seconds(entry.seconds)})`)
			.join(', ');
		lines.push(
			`[lunit] longest block ${seconds(summary.longest.seconds)}: ${summary.longest.label}; ${over} block${over === 1 ? '' : 's'} over ${report.longBlockSeconds} s${over > 0 ? `: ${list}${over > 5 ? ', ...' : ''}` : ''}.`,
		);
	}
	if (report.excludedClasses > 0 || report.excludedTests > 0) {
		lines.push(
			`[lunit] Left out ${report.excludedClasses} Studio-tagged test class(es) and ${report.excludedTests} Studio-tagged test(s): run them with the Studio profile.`,
		);
	}
	return lines;
}

export interface TestResultEntry extends TestIdentity, Verdict {}

/**
 * The machine-readable record of one whole run, produced identically by both
 * routes. `error` is set (and `tests` left empty) when the run never got as
 * far as producing verdicts at all -- e.g. no tests matched, a run was
 * already in progress, or the runner threw.
 */
export interface RunSummary {
	via: RunVia;
	cancelled: boolean;
	tests: TestResultEntry[];
	counts: Record<VerdictStatus, number>;
	error?: string;
	/** Slow-tagged tests the run left out (not in `tests`); see runProfiles.ts. */
	slowLeftOut?: number;
	/** Timing and worker details of a parallel Lune run. */
	lune?: RunTimingSummary;
}

/** Marker prefixing the JSON summary line the extension streams back to the CLI at the end of a `/run`. */
export const SUMMARY_MARKER = '@@LUNIT_SUMMARY@@';

export function countVerdicts(tests: readonly Verdict[]): Record<VerdictStatus, number> {
	const counts: Record<VerdictStatus, number> = { passed: 0, failed: 0, skipped: 0, errored: 0 };
	for (const test of tests) {
		counts[test.status]++;
	}
	return counts;
}

export function buildSummary(via: RunVia, tests: TestResultEntry[], cancelled: boolean, error?: string): RunSummary {
	return { via, cancelled, tests, counts: countVerdicts(tests), error };
}

/** Whether the run should count as a failure (non-zero exit) for a caller that only wants a yes/no. */
export function summaryFailed(summary: RunSummary): boolean {
	return summary.error !== undefined || summary.cancelled || summary.counts.failed > 0 || summary.counts.errored > 0;
}

function relativeFile(file: string, workspaceRoot: string): string {
	const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, '');
	if (file.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
		return file.slice(normalizedRoot.length).replace(/^[\\/]/, '').split('\\').join('/');
	}
	return file;
}

/**
 * Human-readable rendering of a summary, in the same order and with the same
 * messages a user would see in the Test Explorer / Test Results panel.
 */
export function formatSummary(summary: RunSummary, workspaceRoot: string): string {
	const lines: string[] = [];
	const target = summary.via === 'studio' ? 'Roblox Studio' : 'Lune';
	if (summary.error) {
		lines.push(`[lunit] run via ${target} did not complete: ${summary.error}`);
		return lines.join('\n');
	}
	if (summary.cancelled) {
		lines.push(`[lunit] run via ${target} was cancelled.`);
		return lines.join('\n');
	}

	const icon: Record<VerdictStatus, string> = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP', errored: 'ERR ' };
	for (const test of summary.tests) {
		const label = test.displayName ?? test.methodName;
		const elapsed = test.elapsedMs !== undefined ? ` (${test.elapsedMs} ms)` : '';
		lines.push(`${icon[test.status]}  ${relativeFile(test.file, workspaceRoot)} > ${test.className} > ${label}${elapsed}`);
		if (test.message && test.status !== 'passed') {
			for (const messageLine of test.message.split(/\r?\n/)) {
				lines.push(`        ${messageLine}`);
			}
		}
	}

	const { passed, failed, skipped, errored } = summary.counts;
	const parts = [`${passed} passed`, `${failed} failed`];
	if (skipped > 0) {
		parts.push(`${skipped} skipped`);
	}
	if (errored > 0) {
		parts.push(`${errored} errored`);
	}
	lines.push('');
	lines.push(`[lunit] ${summary.tests.length} tests via ${target}: ${parts.join(', ')}.`);
	if (summary.lune) {
		const { blocks, workers, wallSeconds, longest } = summary.lune;
		const longestText = longest ? `; longest block ${longest.seconds.toFixed(1)} s (${longest.label})` : '';
		lines.push(`[lunit] ${blocks} block(s) on ${workers} worker(s), ${wallSeconds.toFixed(1)} s wall time${longestText}.`);
	}
	if (summary.slowLeftOut) {
		lines.push(`[lunit] Left out ${summary.slowLeftOut} slow test(s): add --full to run them with Lune.`);
	}
	return lines.join('\n');
}

/**
 * Case-insensitive substring filters an agent can pass on the command line
 * to narrow a run: a test matches if ANY filter appears in its
 * workspace-relative file path, class name, method name, or display name.
 * No filters means "everything".
 */
export function matchesFilters(test: TestIdentity, filters: readonly string[], workspaceRoot: string): boolean {
	if (filters.length === 0) {
		return true;
	}
	const haystacks = [relativeFile(test.file, workspaceRoot), test.className, test.methodName, test.displayName ?? ''].map(
		(s) => s.toLowerCase(),
	);
	return filters.some((filter) => {
		const needle = filter.toLowerCase().split('\\').join('/');
		return haystacks.some((h) => h.includes(needle));
	});
}
