import { buildTestSelection, SlowTestFilter } from './luauTestFilterTemplate';
import { RunVia, TestIdentity } from './runReport';

/**
 * The run profiles and the slow-test rule, kept free of any `vscode` import
 * so the Test Explorer (extension.ts) and the command line (cli.ts) share one
 * definition, and so both can be unit-tested in plain Node.
 */

export type RunProfileId = 'lune' | 'luneFull' | 'studio';

export interface RunProfileSpec {
	id: RunProfileId;
	label: string;
	via: RunVia;
	/** Whether slow-tagged tests run even when not selected explicitly. */
	includeSlow: boolean;
	isDefault: boolean;
}

export interface RunProfileSettings {
	studioEnabled: boolean;
	slowTags: readonly string[];
}

/**
 * Which profiles to register: "Run with Lune" always (and by default), "Run
 * with Lune (Full)" only when `lunit.lune.slowTags` names a tag, so projects
 * without slow tests see no change, and "Run in Roblox Studio" unless
 * disabled.
 */
export function runProfileSpecs(settings: RunProfileSettings): RunProfileSpec[] {
	const specs: RunProfileSpec[] = [
		{ id: 'lune', label: 'Run with Lune', via: 'lune', includeSlow: false, isDefault: true },
	];
	if (settings.slowTags.length > 0) {
		specs.push({ id: 'luneFull', label: 'Run with Lune (Full)', via: 'lune', includeSlow: true, isDefault: false });
	}
	if (settings.studioEnabled) {
		specs.push({ id: 'studio', label: 'Run in Roblox Studio', via: 'studio', includeSlow: false, isDefault: false });
	}
	return specs;
}

/** Whether effective (class + method) tags carry a slow tag, case-insensitively. */
export function hasSlowTag(tags: readonly string[], slowTags: readonly string[]): boolean {
	if (slowTags.length === 0) {
		return false;
	}
	const wanted = new Set(slowTags.map((tag) => tag.toLowerCase()));
	return tags.some((tag) => wanted.has(tag.toLowerCase()));
}

export interface SlowCandidate {
	/** Effective tags: the class's and the method's. */
	tags: readonly string[];
	/** Whether the run asked for this very test, rather than a folder, file or class containing it. */
	explicit: boolean;
}

export interface SlowPartition<T> {
	/** Tests to run, including explicitly selected slow ones. */
	run: T[];
	/** Slow tests left out: not reported as skipped or failed, only counted. */
	leftOut: T[];
	/** The slow tests in `run`, which the runner must let through. */
	explicitSlow: T[];
}

/**
 * Applies the slow rule: unless `includeSlow`, a slow test runs only when it
 * was selected explicitly.
 */
export function partitionSlowTests<T>(
	items: readonly T[],
	slowTags: readonly string[],
	includeSlow: boolean,
	describe: (item: T) => SlowCandidate,
): SlowPartition<T> {
	const partition: SlowPartition<T> = { run: [], leftOut: [], explicitSlow: [] };
	for (const item of items) {
		const candidate = describe(item);
		if (includeSlow || !hasSlowTag(candidate.tags, slowTags)) {
			partition.run.push(item);
		} else if (candidate.explicit) {
			partition.run.push(item);
			partition.explicitSlow.push(item);
		} else {
			partition.leftOut.push(item);
		}
	}
	return partition;
}

/** What the generated runner needs to apply the same rule on its side; undefined leaves nothing out. */
export function slowTestFilterFor(
	slowTags: readonly string[],
	includeSlow: boolean,
	explicitSlow: readonly TestIdentity[],
): SlowTestFilter | undefined {
	if (includeSlow || slowTags.length === 0) {
		return undefined;
	}
	return { tags: slowTags, allowed: explicitSlow.length > 0 ? buildTestSelection(explicitSlow) : undefined };
}

export function slowLeftOutMessage(count: number, hint = 'run with Lune (Full)'): string {
	return `Left out ${count} slow test(s): ${hint}.`;
}
