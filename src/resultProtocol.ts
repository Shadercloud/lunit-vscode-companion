/**
 * A tiny, unambiguous wire protocol carried inside otherwise-human-readable
 * Lune/Studio output: one line per test invocation, prefixed with a marker,
 * fields base64-encoded and tab-separated so class/label/error text can
 * contain anything (newlines, tabs, unicode) without corrupting the line.
 *
 * Emitted from Luau via the `onTestEnd` reporter hook (see luauEmitHelpers.ts,
 * used by both luneScriptTemplate.ts and bootstrapTemplate.ts) and decoded
 * here. This replaces trying to regex-parse Lunit's pretty-printed tree
 * report, which is meant for humans and isn't a stable machine format.
 */

export const RESULT_MARKER = '@@LUNIT_RESULT@@';

/**
 * Wraps a "display this line" sink so `@@LUNIT_RESULT@@...` protocol lines
 * (base64-encoded, meant for `parseResultLines` above, not humans) never
 * reach it -- while everything else still streams through untouched. Chunks
 * from `onOutput` can split mid-line, so this buffers until it sees a full
 * line before deciding whether to forward or drop it; call `flush()` once
 * the run is done to emit anything left over (e.g. a final line with no
 * trailing newline). This only ever affects what's *displayed* -- callers
 * still run `parseResultLines` against the raw, unfiltered output.
 */
export function createResultLineFilter(sink: (text: string) => void): {
	feed: (chunk: string) => void;
	flush: () => void;
} {
	let buffer = '';
	const feed = (chunk: string): void => {
		buffer += chunk;
		const pieces = buffer.split(/(?<=\r?\n)/);
		const last = pieces[pieces.length - 1];
		const lastComplete = /\r?\n$/.test(last);
		buffer = lastComplete ? '' : (pieces.pop() ?? '');
		for (const piece of pieces) {
			if (!piece.includes(RESULT_MARKER)) {
				sink(piece);
			}
		}
	};
	const flush = (): void => {
		if (buffer.length > 0 && !buffer.includes(RESULT_MARKER)) {
			sink(buffer);
		}
		buffer = '';
	};
	return { feed, flush };
}

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface ResultRecord {
	className: string;
	label: string;
	status: TestStatus;
	elapsedMs: number;
	error?: string;
}

function decodeBase64(value: string): string {
	return Buffer.from(value, 'base64').toString('utf8');
}

export function parseResultLines(output: string): ResultRecord[] {
	const records: ResultRecord[] = [];
	for (const line of output.split(/\r?\n/)) {
		const idx = line.indexOf(RESULT_MARKER);
		if (idx === -1) {
			continue;
		}
		const payload = line.slice(idx + RESULT_MARKER.length);
		const parts = payload.split('\t');
		if (parts.length < 5) {
			continue;
		}
		const [classB64, labelB64, status, elapsedStr, errorB64] = parts;
		if (status !== 'passed' && status !== 'failed' && status !== 'skipped') {
			continue;
		}
		records.push({
			className: decodeBase64(classB64),
			label: decodeBase64(labelB64),
			status,
			elapsedMs: Number(elapsedStr) || 0,
			error: errorB64.length > 0 ? decodeBase64(errorB64) : undefined,
		});
	}
	return records;
}

export interface AggregatedResult {
	status: TestStatus;
	message?: string;
	elapsedMs: number;
	matchCount: number;
}

/**
 * Matches every record belonging to a given `@Test` method to one VS Code
 * TestItem. Each record already reflects Lunit's own final, fully-resolved
 * outcome for one test slot (retries/repeats are folded in by Lunit itself
 * before a record is ever emitted -- see luneScriptTemplate.ts). The one case
 * where a single method legitimately maps to several records is `@Each`,
 * which produces one independent record per row, labeled "label (args)".
 * Those are folded into one aggregate here: any row failing fails the item,
 * otherwise all rows skipped skips it, otherwise it passed.
 */
export function aggregateForLabel(
	records: ReadonlyArray<ResultRecord>,
	className: string,
	baseLabel: string,
): AggregatedResult | undefined {
	const matches = records.filter(
		(r) => r.className === className && (r.label === baseLabel || r.label.startsWith(`${baseLabel} (`)),
	);
	if (matches.length === 0) {
		return undefined;
	}

	let anyFailed = false;
	let allSkipped = true;
	let elapsedMs = 0;
	const messages: string[] = [];

	for (const match of matches) {
		elapsedMs += match.elapsedMs;
		if (match.status !== 'skipped') {
			allSkipped = false;
		}
		if (match.status === 'failed') {
			anyFailed = true;
			messages.push(matches.length > 1 ? `${match.label}: ${match.error ?? 'failed'}` : match.error ?? 'Test failed');
		}
	}

	const status: TestStatus = anyFailed ? 'failed' : allSkipped ? 'skipped' : 'passed';
	if (status === 'skipped') {
		const reasons = matches.map((m) => m.error).filter((m): m is string => !!m);
		if (reasons.length > 0) {
			messages.push(...reasons);
		}
	}

	return {
		status,
		message: messages.length > 0 ? messages.join('\n') : undefined,
		elapsedMs,
		matchCount: matches.length,
	};
}
