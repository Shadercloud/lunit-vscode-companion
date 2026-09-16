import { SlowTestFilter } from './luauTestFilterTemplate';
import {
	ClassSpec,
	DiscoveredMethod,
	DiscoveredModule,
	DiscoveredTestClass,
	ModuleListing,
	WorkerJobModule,
} from './luneBlockProtocol';
import { TestIdentity } from './runReport';

/**
 * Turns the `--list` step's module listing (luneBlockProtocol.ts) plus the
 * run's selection and rules into the blocks a parallel Lune run executes.
 * Pure data in, pure data out, no `vscode` or process dependency, so every
 * scheduling rule is unit-testable without Lune:
 *
 * - One test module per block by default. The module's methods keep their
 *   Lunit ordering, lifecycle hooks and shared state, since the whole class
 *   runs in one VM exactly as before.
 * - A class-level `@Tag("Parallel")` opts into one block per test method
 *   and per `@Each` row, each in a fresh VM with a fresh class instance and
 *   its own BeforeEach/AfterEach. A class that cannot be split safely
 *   (suite-level BeforeAll/AfterAll, @Order, a method that is both a test
 *   and a hook) is rejected: its tests are reported as errored with the
 *   reason, rather than silently run some other way.
 * - `lunit.lune.parallel.dependencyGroups` names modules that must share a
 *   VM in prerequisite order; a group takes precedence over case splitting.
 *   Selecting a test in a group runs the modules listed before its module in
 *   full first (the dependency closure), and the plan says so.
 * - `isolation: 'single'` keeps every module in one block, in one VM: the
 *   behaviour of the profile before parallel runs existed.
 */

export interface TestRef {
	className: string;
	methodName: string;
}

export interface BlockTest extends TestRef {
	/** The module (as a worker names it) whose class produces this test's result. */
	modulePath: string;
	/** Set for a case block that runs one `@Each` row (one-based). */
	caseIndex?: number;
}

export type BlockKind = 'module' | 'group' | 'case' | 'all';

export interface PlannedBlock {
	/** One-based; shown as `#n` in the output. */
	index: number;
	kind: BlockKind;
	label: string;
	modules: WorkerJobModule[];
	/** Tests whose results this block produces (a test appears in every row block of its method). */
	tests: BlockTest[];
}

export interface UnscheduledTest {
	test: TestRef;
	status: 'errored' | 'skipped';
	reason: string;
}

export interface PlanCounts {
	/** Classes left out by the profile's tag rule (e.g. @Tag("Studio") under Lune), loaded or not. */
	excludedClasses: number;
	/** Methods left out by the profile's tag rule. */
	excludedTests: number;
	slowLeftOut: number;
	/** @Tag("Parallel") classes that were split. */
	parallelClasses: number;
	/** Blocks that run a single method or @Each row. */
	caseBlocks: number;
	/** Modules whose class defines at least one test, before any rule. */
	testModules: number;
}

export interface LunePlan {
	blocks: PlannedBlock[];
	/** Tests the run asked for (or would have covered) that no block runs, and why. */
	unscheduled: UnscheduledTest[];
	/** Human-readable explanations to print before the run starts. */
	notes: string[];
	counts: PlanCounts;
}

export interface PlanOptions {
	listing: ModuleListing;
	/** Tests to run; undefined runs everything the rules allow. */
	selection?: readonly TestIdentity[];
	/** Slow-test rule; undefined runs slow tests too. */
	slow?: SlowTestFilter;
	/** Tests carrying this tag (class or method, case-insensitive) never run under this profile. */
	excludedTag?: string;
	dependencyGroups?: readonly (readonly string[])[];
	isolation?: 'blocks' | 'single';
	/** The class-level tag opting into per-case blocks; "Parallel" by default. */
	parallelTag?: string;
	/** Turns a worker module path into the name shown to users and matched against dependency groups. */
	displayName?: (modulePath: string) => string;
}

/** A configuration problem that stops the run before anything is scheduled. */
export class PlanError extends Error {}

const DEPENDENCY_SETTING = 'lunit.lune.parallel.dependencyGroups';

function hasTag(tags: readonly string[], tag: string | undefined): boolean {
	if (tag === undefined) {
		return false;
	}
	const wanted = tag.toLowerCase();
	return tags.some((candidate) => candidate.toLowerCase() === wanted);
}

function hasAnyTag(tags: readonly string[], wanted: readonly string[]): boolean {
	return wanted.some((tag) => hasTag(tags, tag));
}

/** The last path segment of a worker module path, minus a `.luau` extension: `foo.test`. */
export function moduleBasename(modulePath: string): string {
	const segments = modulePath.split(/[\\/]/);
	const last = segments[segments.length - 1] ?? modulePath;
	return last.replace(/\.luau$/, '');
}

/**
 * How many trailing name segments a source file and a worker module path
 * share (`src/b/Util.test.ts` and `out/b/Util.test` share `b`, `Util`,
 * `test`), so a class name defined in several modules is attributed to the
 * one whose location matches best. Case-insensitive: Rojo folder names may
 * differ from source directories in case.
 */
function trailingMatch(file: string, modulePath: string): number {
	const a = unifyName(file).toLowerCase().split('.');
	const b = unifyName(modulePath).toLowerCase().split('.');
	let count = 0;
	while (count < a.length && count < b.length && a[a.length - 1 - count] === b[b.length - 1 - count]) {
		count += 1;
	}
	return count;
}

/**
 * Why a class-level @Tag("Parallel") cannot be honoured, one reason per
 * problem, or an empty list when the class can be split per case.
 */
export function parallelIncompatibilities(cls: DiscoveredTestClass): string[] {
	const reasons: string[] = [];
	const names = (methods: readonly DiscoveredMethod[]) => methods.map((m) => m.name).sort().join(', ');
	const suite = cls.methods.filter((m) => m.lifecycles.some((l) => l === 'BeforeAll' || l === 'AfterAll'));
	if (suite.length > 0) {
		reasons.push(
			`suite-level @BeforeAll/@AfterAll hook(s) ${names(suite)} (they run once per class, which independent blocks cannot share)`,
		);
	}
	const ordered = cls.methods.filter((m) => m.isTest && m.ordered);
	if (ordered.length > 0) {
		reasons.push(`ordered method(s) ${names(ordered)} (@Order means the methods depend on running in sequence)`);
	}
	const both = cls.methods.filter((m) => m.isTest && m.lifecycles.length > 0);
	if (both.length > 0) {
		reasons.push(`method(s) ${names(both)} that are both a @Test and a lifecycle hook`);
	}
	return reasons;
}

/**
 * How many dotted segments a module's own name takes: the file name for a
 * path (`out/a/foo.test` -> `foo.test` -> 2), and for a DataModel name the
 * `.test`/`.spec` suffix plus the name before it (`RS.Tests.foo.test` -> 2).
 */
function ownNameSegments(name: string): number {
	if (/[\\/]/.test(name)) {
		return unifyName(moduleBasename(name)).split('.').length;
	}
	const parts = unifyName(name).split('.');
	return parts.length >= 2 && /^(test|spec)$/i.test(parts[parts.length - 1]) ? 2 : 1;
}

/** Unifies path and DataModel spellings so `src/foo/bar.test.ts` can name `out/foo/bar.test` or `ReplicatedStorage.Foo.bar.test`. */
function unifyName(name: string): string {
	return name
		.trim()
		.replace(/\\/g, '/')
		.replace(/\.(tsx?|luau|lua)$/, '')
		.replace(/\//g, '.')
		.replace(/^\.+|\.+$/g, '');
}

/**
 * Finds the module a dependency-group member names: an exact name, or the
 * longest trailing part (at a segment boundary) that names exactly one
 * module. `bar.test` is enough when only one module ends that way.
 */
export function matchDependencyMember(member: string, names: readonly string[]): { match?: string; ambiguous?: string[] } {
	const wanted = unifyName(member);
	if (wanted.length === 0) {
		return {};
	}
	const unified = names.map((name) => ({
		name,
		unified: unifyName(name).toLowerCase(),
		// A trailing part must cover the module's own name (`foo.test`): a
		// bare `test` would otherwise match everything.
		minimum: ownNameSegments(name),
	}));
	const lowered = wanted.toLowerCase();
	const exact = unified.filter((entry) => entry.unified === lowered);
	if (exact.length === 1) {
		return { match: exact[0].name };
	}
	if (exact.length > 1) {
		return { ambiguous: exact.map((entry) => entry.name) };
	}
	const segments = lowered.split('.');
	for (let start = 0; start < segments.length; start++) {
		const suffix = segments.slice(start).join('.');
		const length = segments.length - start;
		const matches = unified.filter(
			(entry) => length >= entry.minimum && (entry.unified === suffix || entry.unified.endsWith(`.${suffix}`)),
		);
		if (matches.length === 1) {
			return { match: matches[0].name };
		}
		if (matches.length > 1) {
			return { ambiguous: matches.map((entry) => entry.name) };
		}
	}
	return {};
}

interface ResolvedGroup {
	members: string[];
	label: string;
}

/**
 * Validates `lunit.lune.parallel.dependencyGroups` against the modules the
 * run knows about (loaded, failed to load, or excluded). Unknown, ambiguous
 * and repeated members are configuration errors: silently dropping a
 * prerequisite would run its dependents without it.
 */
export function resolveDependencyGroups(
	groups: readonly (readonly string[])[] | undefined,
	knownNames: readonly string[],
	displayName: (name: string) => string,
): ResolvedGroup[] {
	if (!groups || groups.length === 0) {
		return [];
	}
	const resolved: ResolvedGroup[] = [];
	const owner = new Map<string, number>();
	const known = knownNames.map(displayName);
	const byDisplay = new Map(knownNames.map((name) => [displayName(name), name]));
	const sample = known.slice(0, 20).join(', ') + (known.length > 20 ? `, ... (${known.length} modules)` : '');
	groups.forEach((group, groupIndex) => {
		if (!Array.isArray(group) || group.some((member) => typeof member !== 'string')) {
			throw new PlanError(`${DEPENDENCY_SETTING}: group ${groupIndex + 1} must be an array of module names.`);
		}
		const members = group.map((member) => member.trim()).filter((member) => member.length > 0);
		if (members.length < 2) {
			throw new PlanError(
				`${DEPENDENCY_SETTING}: group ${groupIndex + 1} (${JSON.stringify(group)}) needs at least two modules, in prerequisite-first order.`,
			);
		}
		const resolvedMembers: string[] = [];
		for (const member of members) {
			const found = matchDependencyMember(member, known);
			if (found.ambiguous) {
				throw new PlanError(
					`${DEPENDENCY_SETTING}: "${member}" matches several test modules (${found.ambiguous.join(', ')}); use a longer name.`,
				);
			}
			if (found.match === undefined) {
				throw new PlanError(
					`${DEPENDENCY_SETTING}: no test module matches "${member}". Modules found: ${sample || '(none)'}.`,
				);
			}
			const name = byDisplay.get(found.match) ?? found.match;
			const previous = owner.get(name);
			if (previous !== undefined) {
				throw new PlanError(
					previous === groupIndex
						? `${DEPENDENCY_SETTING}: "${member}" (${found.match}) is listed twice in group ${groupIndex + 1}.`
						: `${DEPENDENCY_SETTING}: "${member}" (${found.match}) belongs to groups ${previous + 1} and ${groupIndex + 1}; a module can be in one group only.`,
				);
			}
			owner.set(name, groupIndex);
			resolvedMembers.push(name);
		}
		resolved.push({ members: resolvedMembers, label: resolvedMembers.map(displayName).join(' -> ') });
	});
	return resolved;
}

interface ModuleState {
	module: DiscoveredModule;
	id: string;
	/** The whole class is left out by the tag rule. */
	classExcluded: boolean;
	/** Test methods the rules allow, in listing order. */
	eligible: DiscoveredMethod[];
	/** Methods the selection named; undefined when the run selects everything. */
	selected?: Set<string>;
	/** Slow tests left out of this module. */
	slowLeftOut: number;
	/** Methods left out by the tag rule. */
	excludedTests: number;
}

function methodSpec(methods: readonly DiscoveredMethod[]): ClassSpec {
	const spec: Record<string, true | number> = {};
	for (const method of methods) {
		spec[method.name] = true;
	}
	return { methods: spec };
}

function testsOf(state: ModuleState, methods: readonly DiscoveredMethod[]): BlockTest[] {
	return methods.map((method) => ({
		className: state.module.class.className,
		methodName: method.name,
		modulePath: state.module.path,
	}));
}

export function planLuneRun(options: PlanOptions): LunePlan {
	const { listing } = options;
	const display = options.displayName ?? ((modulePath: string) => modulePath);
	const parallelTag = options.parallelTag ?? 'Parallel';
	const slowTags = options.slow?.tags ?? [];
	const isolation = options.isolation ?? 'blocks';
	const notes: string[] = [];
	const unscheduled: UnscheduledTest[] = [];
	const counts: PlanCounts = {
		// Modules excluded before loading are only "left out" of a whole-tree run.
		excludedClasses: options.selection ? 0 : listing.excludedModules.length,
		excludedTests: 0,
		slowLeftOut: 0,
		parallelClasses: 0,
		caseBlocks: 0,
		testModules: 0,
	};

	// 1. Map the selection onto discovered modules: by class name, and by the
	//    source file's basename when the same class name appears in several
	//    compiled modules.
	const selectionByModule = new Map<string, Set<string>>();
	const unscheduledKeys = new Set<string>();
	const markUnscheduled = (test: TestRef, status: 'errored' | 'skipped', reason: string) => {
		const key = `${test.className} ${test.methodName}`;
		if (unscheduledKeys.has(key)) {
			return;
		}
		unscheduledKeys.add(key);
		unscheduled.push({ test: { className: test.className, methodName: test.methodName }, status, reason });
	};
	if (options.selection) {
		for (const test of options.selection) {
			let candidates = listing.modules.filter((module) => module.class.className === test.className);
			if (candidates.length > 1) {
				const scored = candidates.map((module) => ({ module, score: trailingMatch(test.file, module.path) }));
				const best = Math.max(...scored.map((entry) => entry.score));
				if (best > 0) {
					candidates = scored.filter((entry) => entry.score === best).map((entry) => entry.module);
				}
			}
			if (candidates.length === 0) {
				// A module that failed to load has no class name to match on: go by
				// its own name against the source file's (`broken.test`).
				const failure = listing.loadFailures.find((entry) => moduleMatchesSource(test.file, entry.path));
				markUnscheduled(
					test,
					'errored',
					failure
						? `the compiled test module ${display(failure.path)} failed to load: ${failure.error}`
						: `no compiled test class named "${test.className}" was found. Is the project compiled, and does its module 'export =' the class?`,
				);
				continue;
			}
			let found = false;
			for (const module of candidates) {
				if (module.class.methods.some((method) => method.isTest && method.name === test.methodName)) {
					found = true;
					let selected = selectionByModule.get(module.path);
					if (!selected) {
						selected = new Set();
						selectionByModule.set(module.path, selected);
					}
					selected.add(test.methodName);
				}
			}
			if (!found) {
				markUnscheduled(
					test,
					'errored',
					`the compiled class "${test.className}" (${candidates.map((c) => display(c.path)).join(', ')}) has no @Test method named "${test.methodName}"; recompile the project.`,
				);
			}
		}
	}

	// 2. Per module: which tests the rules allow, narrowed to the selection.
	const states = new Map<string, ModuleState>();
	const inScope = (state: ModuleState) => options.selection === undefined || state.selected !== undefined;
	for (const module of listing.modules) {
		const cls = module.class;
		const tests = cls.methods.filter((method) => method.isTest);
		if (tests.length > 0) {
			counts.testModules += 1;
		}
		const state: ModuleState = {
			module,
			id: display(module.path),
			classExcluded: hasTag(cls.tags, options.excludedTag),
			eligible: [],
			selected: selectionByModule.get(module.path),
			slowLeftOut: 0,
			excludedTests: 0,
		};
		states.set(module.path, state);
		const scoped = inScope(state);
		if (state.classExcluded) {
			if (scoped) {
				counts.excludedClasses += 1;
				for (const method of tests) {
					if (!state.selected || state.selected.has(method.name)) {
						markUnscheduled(
							{ className: cls.className, methodName: method.name },
							'skipped',
							`the class is tagged "${options.excludedTag}" and does not run under this profile`,
						);
					}
				}
			}
			continue;
		}
		const classSlow = hasAnyTag(cls.tags, slowTags);
		const allowed = options.slow?.allowed?.get(cls.className);
		for (const method of tests) {
			const considered = state.selected === undefined || state.selected.has(method.name);
			if (hasTag(method.tags, options.excludedTag)) {
				if (scoped && considered) {
					state.excludedTests += 1;
					markUnscheduled(
						{ className: cls.className, methodName: method.name },
						'skipped',
						`the test is tagged "${options.excludedTag}" and does not run under this profile`,
					);
				}
				continue;
			}
			if ((classSlow || hasAnyTag(method.tags, slowTags)) && !(allowed && allowed.has(method.name))) {
				if (scoped && considered) {
					state.slowLeftOut += 1;
					markUnscheduled(
						{ className: cls.className, methodName: method.name },
						'skipped',
						'slow test left out of this profile: run it with Lune (Full), or run it directly',
					);
				}
				continue;
			}
			state.eligible.push(method);
		}
		if (scoped) {
			counts.excludedTests += state.excludedTests;
			counts.slowLeftOut += state.slowLeftOut;
		}
	}

	// The methods a module runs: its eligible tests narrowed to the selection,
	// then to @Only when the focus is among them (Lunit would ignore the rest).
	const runSet = (state: ModuleState, narrow: boolean): DiscoveredMethod[] => {
		let methods = state.eligible;
		if (narrow && state.selected) {
			const selected = state.selected;
			methods = methods.filter((method) => selected.has(method.name));
		}
		const focused = methods.filter((method) => method.only);
		if (focused.length > 0) {
			for (const method of methods) {
				if (!method.only) {
					markUnscheduled(
						{ className: state.module.class.className, methodName: method.name },
						'skipped',
						`another test in ${state.module.class.className} is focused with @Only (${focused.map((m) => m.name).join(', ')})`,
					);
				}
			}
			methods = focused;
		}
		return methods;
	};

	// 3. Dependency groups, validated against every name the run knows.
	const knownNames = [
		...listing.modules.map((module) => module.path),
		...listing.loadFailures.map((entry) => entry.path),
		...listing.excludedModules,
	];
	const groups = resolveDependencyGroups(options.dependencyGroups, knownNames, display);
	const grouped = new Set(groups.flatMap((group) => group.members));

	const blocks: PlannedBlock[] = [];
	const addBlock = (kind: BlockKind, label: string, modules: WorkerJobModule[], tests: BlockTest[]) => {
		blocks.push({ index: blocks.length + 1, kind, label, modules, tests });
	};
	const jobModule = (state: ModuleState, methods: readonly DiscoveredMethod[]): WorkerJobModule => ({
		path: state.module.path,
		className: state.module.class.className,
		spec: methodSpec(methods),
	});

	// A group's modules, in order, with what each runs. With a selection, the
	// modules before the last selected one are prerequisites and run in full.
	const planGroup = (group: ResolvedGroup): { modules: WorkerJobModule[]; tests: BlockTest[]; prerequisites: string[]; selectedIds: string[] } | undefined => {
		const memberStates = group.members.map((name) => states.get(name));
		let lastSelected = -1;
		if (options.selection) {
			memberStates.forEach((state, index) => {
				if (state?.selected) {
					lastSelected = index;
				}
			});
			if (lastSelected === -1) {
				return undefined;
			}
		}
		const modules: WorkerJobModule[] = [];
		const tests: BlockTest[] = [];
		const prerequisites: string[] = [];
		const selectedIds: string[] = [];
		const end = options.selection ? lastSelected : memberStates.length - 1;
		for (let index = 0; index <= end; index++) {
			const state = memberStates[index];
			const name = group.members[index];
			if (!state) {
				// Failed to load or excluded before loading: the worker reports a
				// load failure for it, which its tests (if any are known) inherit.
				if (listing.loadFailures.some((entry) => entry.path === name)) {
					modules.push({ path: name, className: '', spec: { all: true } });
				} else {
					notes.push(`[lunit] dependency group ${group.label}: ${display(name)} is left out by the profile's tag rule.`);
				}
				continue;
			}
			if (state.classExcluded) {
				notes.push(`[lunit] dependency group ${group.label}: ${state.id} is left out by the profile's tag rule.`);
				continue;
			}
			const isLast = options.selection !== undefined && index === lastSelected;
			const methods = runSet(state, isLast);
			if (methods.length === 0) {
				continue;
			}
			if (options.selection && !isLast) {
				prerequisites.push(state.id);
			}
			if (state.selected) {
				selectedIds.push(state.id);
			}
			modules.push(jobModule(state, methods));
			tests.push(...testsOf(state, methods));
		}
		return modules.length > 0 ? { modules, tests, prerequisites, selectedIds } : undefined;
	};

	if (isolation === 'single') {
		// One VM for everything, as the profile ran before parallel blocks: the
		// groups first (in order), then every other module in listing order.
		const modules: WorkerJobModule[] = [];
		const tests: BlockTest[] = [];
		for (const group of groups) {
			const planned = planGroup(group);
			if (planned) {
				modules.push(...planned.modules);
				tests.push(...planned.tests);
				if (planned.prerequisites.length > 0) {
					notes.push(
						`[lunit] dependency group ${group.label}: ${planned.prerequisites.join(', ')} run in full before the selected tests in ${planned.selectedIds.join(', ')}.`,
					);
				}
			}
		}
		for (const module of listing.modules) {
			const state = states.get(module.path);
			if (!state || grouped.has(module.path) || state.classExcluded || !inScope(state)) {
				continue;
			}
			const methods = runSet(state, true);
			if (methods.length > 0) {
				modules.push(jobModule(state, methods));
				tests.push(...testsOf(state, methods));
			}
		}
		if (modules.length > 0) {
			addBlock('all', `${modules.length} module(s) in one Lune process`, modules, tests);
		}
		return { blocks, unscheduled, notes, counts };
	}

	for (const group of groups) {
		const planned = planGroup(group);
		if (!planned) {
			continue;
		}
		if (planned.prerequisites.length > 0) {
			notes.push(
				`[lunit] dependency group ${group.label}: ${planned.prerequisites.join(', ')} run in full before the selected tests in ${planned.selectedIds.join(', ')}, in the same Lune process.`,
			);
		}
		addBlock('group', planned.modules.map((module) => display(module.path)).join(' -> '), planned.modules, planned.tests);
	}

	for (const module of listing.modules) {
		const state = states.get(module.path);
		if (!state || grouped.has(module.path) || state.classExcluded || !inScope(state)) {
			continue;
		}
		const methods = runSet(state, true);
		if (methods.length === 0) {
			continue;
		}
		const cls = module.class;
		if (hasTag(cls.tags, parallelTag) && !cls.disabled) {
			const reasons = parallelIncompatibilities(cls);
			if (reasons.length > 0) {
				const diagnostic = `@Tag("${parallelTag}") on class ${cls.className} (${state.id}) cannot be honoured: ${reasons.join('; ')}. Remove the tag to run the class as one block, or restructure the class.`;
				notes.push(`[lunit] ${diagnostic}`);
				for (const method of methods) {
					markUnscheduled({ className: cls.className, methodName: method.name }, 'errored', diagnostic);
				}
				continue;
			}
			counts.parallelClasses += 1;
			for (const method of methods) {
				const rows = method.cases !== undefined && method.cases > 0 ? method.cases : 0;
				if (rows === 0) {
					counts.caseBlocks += 1;
					addBlock(
						'case',
						`${state.id}::${method.name}`,
						[{ path: module.path, className: cls.className, spec: { methods: { [method.name]: true } } }],
						[{ className: cls.className, methodName: method.name, modulePath: module.path }],
					);
					continue;
				}
				for (let row = 1; row <= rows; row++) {
					counts.caseBlocks += 1;
					addBlock(
						'case',
						`${state.id}::${method.name}[${row}]`,
						[{ path: module.path, className: cls.className, spec: { methods: { [method.name]: row } } }],
						[{ className: cls.className, methodName: method.name, modulePath: module.path, caseIndex: row }],
					);
				}
			}
			continue;
		}
		addBlock('module', state.id, [jobModule(state, methods)], testsOf(state, methods));
	}

	return { blocks, unscheduled, notes, counts };
}

/** Whether two test references name the same test. */
export function sameTest(a: TestRef, b: TestRef): boolean {
	return a.className === b.className && a.methodName === b.methodName;
}

/** Whether a worker module path is, by name, the compiled form of a source file (`/src/x/foo.test.ts` -> `out/x/foo.test`). */
export function moduleMatchesSource(file: string, modulePath: string): boolean {
	return trailingMatch(file, modulePath) >= ownNameSegments(modulePath);
}
