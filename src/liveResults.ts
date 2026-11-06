import { aggregateForLabel, LiveEvent, ResultRecord } from './resultProtocol';
import { TestIdentity, Verdict } from './runReport';

/**
 * Live Studio results (live-sync): maps the start/result events a run streams
 * (resultProtocol.ts LiveEvent) onto the tests it was asked to run, so the
 * Test Explorer and the CLI can report each test as it finishes, then
 * reconciles that with the run's final report.
 *
 * Mapping is the end-of-run rule (`aggregateForLabel`): a test matches its
 * class and its display name, or an `@Each` row "<name> (<args>)" of it. An
 * `@Each` test's live verdict folds in its rows so far, so it can move from
 * passed to failed as rows arrive. A retried test streams one result per
 * try; the latest try stands.
 *
 * No VS Code dependency, so it is unit-tested directly.
 */
export type LiveUpdate =
	| { kind: 'started'; index: number }
	| { kind: 'verdict'; index: number; verdict: Verdict };

export interface Reconciled {
	verdict: Verdict;
	/** False when the test already shows this verdict from the stream: report nothing more. */
	report: boolean;
}

export class LiveResults {
	/** Class name -> tests in that class, longest name first (so "a (b)" beats "a"). */
	private readonly byClass = new Map<string, { base: string; index: number }[]>();
	/** Per test: its latest record per row label. */
	private readonly rows = new Map<number, Map<string, ResultRecord>>();
	private readonly verdicts = new Map<number, Verdict>();
	private readonly started = new Set<number>();

	constructor(private readonly tests: readonly TestIdentity[]) {
		tests.forEach((test, index) => {
			const list = this.byClass.get(test.className) ?? [];
			list.push({ base: baseLabel(test), index });
			this.byClass.set(test.className, list);
		});
		for (const list of this.byClass.values()) {
			list.sort((a, b) => b.base.length - a.base.length);
		}
	}

	/** Tests (indexes into the constructor's list) a streamed label belongs to. */
	private match(className: string, label: string): number[] {
		const list = this.byClass.get(className);
		if (!list) {
			return [];
		}
		const exact = list.filter((entry) => entry.base === label);
		if (exact.length > 0) {
			return exact.map((entry) => entry.index);
		}
		const row = list.find((entry) => label.startsWith(`${entry.base} (`));
		return row ? list.filter((entry) => entry.base === row.base).map((entry) => entry.index) : [];
	}

	/** Applies one event; returns what changed, for the caller to show. */
	apply(event: LiveEvent): LiveUpdate[] {
		const updates: LiveUpdate[] = [];
		if (event.kind === 'started') {
			for (const index of this.match(event.className, event.label)) {
				if (!this.started.has(index) && !this.verdicts.has(index)) {
					this.started.add(index);
					updates.push({ kind: 'started', index });
				}
			}
			return updates;
		}
		const { record } = event;
		for (const index of this.match(record.className, record.label)) {
			const rows = this.rows.get(index) ?? new Map<string, ResultRecord>();
			rows.set(record.label, record);
			this.rows.set(index, rows);
			const test = this.tests[index];
			const aggregate = aggregateForLabel([...rows.values()], test.className, baseLabel(test));
			if (!aggregate) {
				continue;
			}
			const verdict: Verdict = aggregate.status === 'passed'
				? { status: 'passed', elapsedMs: aggregate.elapsedMs }
				: aggregate.status === 'failed'
					? { status: 'failed', message: aggregate.message ?? 'Test failed', elapsedMs: aggregate.elapsedMs }
					: { status: 'skipped' };
			const previous = this.verdicts.get(index);
			this.verdicts.set(index, verdict);
			if (!previous || !sameVerdict(previous, verdict)) {
				updates.push({ kind: 'verdict', index, verdict });
			}
		}
		return updates;
	}

	/** The verdict the stream gave a test, if it reported. */
	liveVerdict(index: number): Verdict | undefined {
		return this.verdicts.get(index);
	}

	/**
	 * The test's final verdict, given the run's final result records and the
	 * verdict the end-of-run rule gives it (`resolveVerdict`).
	 * - The final report has the test: that verdict wins. If the stream showed
	 *   the same, nothing more is reported (no duplicates); if it differs (an
	 *   error in teardown after passing, say), the final verdict is reported
	 *   and its message says so.
	 * - The final report lacks it (a run cancelled, timed out or released
	 *   partway) but it streamed a result: that real result stands.
	 * - Neither: the end-of-run fallback (errored with the reason, or skipped
	 *   for a cancelled run).
	 */
	reconcile(index: number, finalRecords: readonly ResultRecord[], finalVerdict: Verdict): Reconciled {
		const test = this.tests[index];
		const live = this.verdicts.get(index);
		const inFinal = aggregateForLabel(finalRecords, test.className, baseLabel(test)) !== undefined;
		if (!inFinal && live) {
			return { verdict: live, report: false };
		}
		if (!live) {
			return { verdict: finalVerdict, report: true };
		}
		if (sameVerdict(live, finalVerdict)) {
			return { verdict: finalVerdict, report: false };
		}
		const note = `The final result (${finalVerdict.status}) replaces the result reported while the run was going (${live.status}).`;
		return {
			verdict: { ...finalVerdict, message: finalVerdict.message ? `${finalVerdict.message}\n${note}` : note },
			report: true,
		};
	}
}

function baseLabel(test: TestIdentity): string {
	return test.displayName ?? test.methodName;
}

function sameVerdict(a: Verdict, b: Verdict): boolean {
	return a.status === b.status && (a.message ?? '') === (b.message ?? '');
}
