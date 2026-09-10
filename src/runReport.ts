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
	if (outcome.code !== 0 && records.length === 0) {
		return { status: 'errored', message: NO_RESULTS_MESSAGE };
	}
	return { status: 'errored', message: NO_MATCH_MESSAGE };
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
