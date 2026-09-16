import { parseResultLines, ResultRecord } from './resultProtocol';

/**
 * The wire protocol between the extension and the generated Lune worker
 * scripts (luneScriptTemplate.ts, luneGameScriptTemplate.ts), on top of the
 * per-test result lines of resultProtocol.ts. A parallel run talks to Lune in
 * two steps:
 *
 * 1. `--list`: one process loads every test module once and prints a
 *    `@@LUNIT_MODULES@@{json}` line describing each class's compiled Lunit
 *    metadata (tests, tags, @Each row counts, lifecycle hooks, @Order, @Only),
 *    which the planner (luneBlocks.ts) turns into blocks.
 * 2. `--job <file>`: one process per block reads a WorkerJob (an ordered list
 *    of modules, each with the exact test methods or @Each row to keep), runs
 *    it, prints the usual `@@LUNIT_RESULT@@` lines and ends with one
 *    `@@LUNIT_BLOCK@@{json}` summary. A block whose summary is missing,
 *    malformed, or disagrees with the result lines is an error, never a pass.
 */

export const MODULES_MARKER = '@@LUNIT_MODULES@@';
export const BLOCK_MARKER = '@@LUNIT_BLOCK@@';

/** Every marker a generated Lune script prints for machines rather than people. */
export const PROTOCOL_MARKERS = [MODULES_MARKER, BLOCK_MARKER];

export interface DiscoveredMethod {
	name: string;
	/** `@Test`; false for a lifecycle hook that only appears in the metadata table. */
	isTest: boolean;
	tags: string[];
	displayName?: string;
	/** Number of `@Each` rows; undefined when the method is not parameterized. */
	cases?: number;
	/** Lunit lifecycle names: "BeforeEach", "AfterEach", "BeforeAll", "AfterAll". */
	lifecycles: string[];
	/** `@Order(n)` was applied. */
	ordered: boolean;
	only: boolean;
	disabled: boolean;
}

export interface DiscoveredTestClass {
	className: string;
	tags: string[];
	displayName?: string;
	disabled: boolean;
	methods: DiscoveredMethod[];
}

export interface DiscoveredModule {
	/** What the worker loads: a filesystem path (package project) or a DataModel full name (game project). */
	path: string;
	class: DiscoveredTestClass;
}

export interface ModuleLoadFailure {
	path: string;
	error: string;
}

export interface ModuleListing {
	modules: DiscoveredModule[];
	loadFailures: ModuleLoadFailure[];
	/** Modules left out before loading, e.g. a class-level @Tag("Studio") found in the compiled source. */
	excludedModules: string[];
}

function asArray(value: unknown): unknown[] {
	// Lune's serde encodes an empty Luau table as `{}`, so an empty list may arrive as an object.
	return Array.isArray(value) ? value : [];
}

function stringList(value: unknown): string[] {
	return asArray(value).filter((v): v is string => typeof v === 'string');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseMethod(value: unknown): DiscoveredMethod | undefined {
	const raw = asRecord(value);
	if (!raw || typeof raw.name !== 'string') {
		return undefined;
	}
	const cases = typeof raw.cases === 'number' && raw.cases > 0 ? Math.floor(raw.cases) : undefined;
	return {
		name: raw.name,
		isTest: raw.isTest === true,
		tags: stringList(raw.tags),
		displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined,
		cases,
		lifecycles: stringList(raw.lifecycles),
		ordered: raw.ordered === true,
		only: raw.only === true,
		disabled: raw.disabled === true,
	};
}

function parseClass(value: unknown): DiscoveredTestClass | undefined {
	const raw = asRecord(value);
	if (!raw || typeof raw.className !== 'string') {
		return undefined;
	}
	const methods: DiscoveredMethod[] = [];
	for (const entry of asArray(raw.methods)) {
		const method = parseMethod(entry);
		if (method) {
			methods.push(method);
		}
	}
	return {
		className: raw.className,
		tags: stringList(raw.tags),
		displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined,
		disabled: raw.disabled === true,
		methods,
	};
}

function parseLoadFailures(value: unknown): ModuleLoadFailure[] {
	const failures: ModuleLoadFailure[] = [];
	for (const entry of asArray(value)) {
		const raw = asRecord(entry);
		if (raw && typeof raw.path === 'string') {
			failures.push({ path: raw.path, error: typeof raw.error === 'string' ? raw.error : 'unknown error' });
		}
	}
	return failures;
}

/** Decodes the `--list` step's output; an absent or malformed listing is an error, never "no tests". */
export function parseModuleListing(output: string): { listing: ModuleListing } | { error: string } {
	const line = output.split(/\r?\n/).find((candidate) => candidate.includes(MODULES_MARKER));
	if (line === undefined) {
		return { error: 'the discovery step produced no module listing' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.slice(line.indexOf(MODULES_MARKER) + MODULES_MARKER.length));
	} catch (err) {
		return { error: `the module listing is not valid JSON (${String(err)})` };
	}
	const raw = asRecord(parsed);
	if (!raw) {
		return { error: 'the module listing is not a JSON object' };
	}
	const modules: DiscoveredModule[] = [];
	for (const entry of asArray(raw.modules)) {
		const module = asRecord(entry);
		const cls = module ? parseClass(module.class) : undefined;
		if (!module || typeof module.path !== 'string' || !cls) {
			return { error: 'the module listing contains a malformed module entry' };
		}
		modules.push({ path: module.path, class: cls });
	}
	return {
		listing: {
			modules,
			loadFailures: parseLoadFailures(raw.loadFailures),
			excludedModules: stringList(raw.excludedModules),
		},
	};
}

/**
 * Which test methods of a class a worker keeps: `all` leaves the class as
 * compiled, otherwise every `@Test` method not named is removed (lifecycle
 * hooks always stay) and a number keeps only that one-based `@Each` row.
 */
export type ClassSpec = { all: true } | { methods: Record<string, true | number> };

export interface WorkerJobModule {
	path: string;
	/** Expected `tostring(class)`; the worker refuses a module that exports a different class. */
	className: string;
	spec: ClassSpec;
}

/** What one Lune worker process runs: modules in this order, inside one VM. */
export interface WorkerJob {
	block: string;
	modules: WorkerJobModule[];
}

export interface BlockSummary {
	/** Number of `@@LUNIT_RESULT@@` lines the worker printed. */
	results: number;
	failed: number;
	loadFailures: ModuleLoadFailure[];
	elapsedMs: number;
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Decodes the last `@@LUNIT_BLOCK@@` line; undefined when absent or malformed. */
export function parseBlockSummary(output: string): BlockSummary | undefined {
	const lines = output.split(/\r?\n/).filter((line) => line.includes(BLOCK_MARKER));
	const line = lines[lines.length - 1];
	if (line === undefined) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.slice(line.indexOf(BLOCK_MARKER) + BLOCK_MARKER.length));
	} catch {
		return undefined;
	}
	const raw = asRecord(parsed);
	if (!raw) {
		return undefined;
	}
	const results = nonNegativeInteger(raw.results);
	const failed = nonNegativeInteger(raw.failed);
	if (results === undefined || failed === undefined) {
		return undefined;
	}
	const elapsed = typeof raw.elapsedMs === 'number' && raw.elapsedMs >= 0 ? raw.elapsedMs : 0;
	return { results, failed, loadFailures: parseLoadFailures(raw.loadFailures), elapsedMs: elapsed };
}

export interface WorkerProcessResult {
	code: number | null;
	output: string;
	cancelled: boolean;
	timedOut: boolean;
}

export type BlockStatus = 'passed' | 'failed' | 'errored' | 'cancelled';

export interface BlockAssessment {
	status: BlockStatus;
	/** Why the block is errored: every test of the block is reported with it. */
	error?: string;
	records: ResultRecord[];
	summary?: BlockSummary;
}

/** The last few human-readable lines of a worker's output, for an error message. */
export function outputTail(output: string, maxLines = 12): string {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0 && !line.includes('@@LUNIT_'));
	return lines.slice(-maxLines).join('\n');
}

/**
 * Judges one finished worker process. Only a process that exited normally
 * (0, or 1 for "some test failed"), reported a block summary, and whose
 * summary agrees with the result lines it printed is trusted; anything else
 * -- a crash, a kill, garbage where the summary should be, results the
 * summary doesn't account for -- errors the whole block.
 */
export function assessBlock(result: WorkerProcessResult): BlockAssessment {
	const records = parseResultLines(result.output);
	if (result.cancelled) {
		return { status: 'cancelled', records };
	}
	const summary = parseBlockSummary(result.output);
	const tail = outputTail(result.output);
	const detail = tail.length > 0 ? `\n${tail}` : '';
	if (result.timedOut) {
		return { status: 'errored', error: `the Lune worker timed out${detail}`, records, summary };
	}
	if (result.code === null || (result.code !== 0 && result.code !== 1)) {
		const how = result.code === null ? 'was killed or failed to start' : `exited with code ${result.code}`;
		return { status: 'errored', error: `the Lune worker ${how}${detail}`, records, summary };
	}
	if (!summary) {
		return {
			status: 'errored',
			error: `the Lune worker exited with code ${result.code} without reporting a block summary${detail}`,
			records,
		};
	}
	if (summary.results !== records.length) {
		return {
			status: 'errored',
			error: `the Lune worker reported ${summary.results} result(s) but ${records.length} were received${detail}`,
			records,
			summary,
		};
	}
	const failed = summary.failed > 0 || summary.loadFailures.length > 0 || records.some((r) => r.status === 'failed');
	return { status: failed ? 'failed' : 'passed', records, summary };
}
