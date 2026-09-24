import * as path from 'path';

/**
 * Deliberately free of any `vscode` import: this module (and everything the
 * runners in luneRunner.ts / studioRunner.ts pull in) is shared verbatim
 * with the standalone command-line entry point (cli.ts), which runs in a
 * plain Node process where the `vscode` module doesn't exist. The VS Code
 * side of config -- reading `lunit.*` settings -- lives in vscodeConfig.ts.
 */

function resolveTokens(input: string, tokens: Record<string, string>): string {
	let result = input;
	for (const [key, value] of Object.entries(tokens)) {
		result = result.split(`\${${key}}`).join(value);
	}
	return result;
}

export interface LunitConfig {
	/** Absolute path of the workspace folder (the roblox-ts project root). */
	workspaceRoot: string;
	/**
	 * Absolute directory, outside the workspace, where this extension writes
	 * everything it generates (compiled Lune runner scripts, the Studio test
	 * Rojo project, the Studio bootstrap script, the built place file, Studio's
	 * output log) -- nothing should end up sitting in the user's project. Comes
	 * from VS Code's own per-workspace extension storage
	 * (`ExtensionContext.storageUri`), namespaced by workspace folder name; the
	 * standalone CLI substitutes a per-project temp directory instead.
	 */
	storageDir: string;
	testGlob: string;
	excludeGlob: string;
	skipCompile: boolean;
	compileCommand: string;
	outDir: string;
	env: Record<string, string>;
	lune: {
		executable: string;
		testsRoot: string;
		lunitRoot: string;
		/**
		 * Rojo project file describing the DataModel for a roblox-ts game
		 * project. Empty means "work it out from the compiled output" --
		 * see luneProjectKind.ts.
		 */
		projectFile: string;
		/**
		 * Tags marking slow tests, left out of "Run with Lune" and "Run in
		 * Roblox Studio" unless selected explicitly; "Run with Lune (Full)"
		 * runs them. Empty turns the feature (and the Full profile) off.
		 */
		slowTags: string[];
		parallel: {
			/**
			 * Run each test module (or, for a @Tag("Parallel") class, each
			 * test method and @Each row) in its own Lune process, several at
			 * a time. False runs every module in one Lune process, sharing one
			 * module cache, as the profile did before 0.7.0.
			 */
			enabled: boolean;
			/** Maximum concurrent Lune processes; 0 picks min(32, logical CPUs). Capped by the number of blocks. */
			workers: number;
			/**
			 * Modules that must run in prerequisite-first order inside one
			 * Lune process (see luneBlocks.ts). Validated before scheduling.
			 */
			dependencyGroups: string[][];
		};
	};
	studio: {
		enabled: boolean;
		executablePath: string;
		/**
		 * The place-building command with every token but `${projectFile}`
		 * resolved: which Rojo project it builds is decided per run (the
		 * project's own for a roblox-ts game project, the generated
		 * `projectFile` for a package) -- see studioProjectKind.ts and
		 * `resolveBuildPlaceCommand`.
		 */
		buildPlaceCommand: string;
		/**
		 * `lunit.studio.rojoProject`: the project's own Rojo file to build the
		 * standalone test place from. Empty means "work it out": the compile
		 * command's `--rojo` flag, else the compiled output (studioProjectKind.ts).
		 */
		rojoProject: string;
		/** The generated, self-contained Rojo project for a package project's test place. */
		projectFile: string;
		placeFile: string;
		bootstrapScript: string;
		outputFile: string;
		quitAfterExecution: boolean;
		timeoutSeconds: number;
		liveSync: {
			enabled: boolean;
			port: number;
			timeoutSeconds: number;
			syncDelaySeconds: number;
		};
	};
}

export const DEFAULT_LIVE_SYNC_PORT = 34873;

/**
 * Reads one `lunit.*` setting by its key *without* the `lunit.` prefix (e.g.
 * `studio.liveSync.port`), returning `fallback` when unset. Mirrors
 * `WorkspaceConfiguration.get` so the VS Code side can pass that straight
 * through, while the CLI backs it with the workspace's `.vscode/settings.json`.
 */
export type SettingReader = <T>(key: string, fallback: T) => T;

/** A hand-edited settings value as a clean tag list: strings only, trimmed, no blanks. */
function normalizeTagList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter((tag) => tag.length > 0);
}

/** A non-negative integer worker count, or 0 ("automatic") for anything else. */
function normalizeWorkers(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 0;
}

/**
 * Dependency groups as the planner validates them. Nothing is dropped
 * silently: a malformed entry is kept in a shape the planner will reject
 * with a message naming it, rather than quietly running without it.
 */
function normalizeDependencyGroups(value: unknown): string[][] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((group) =>
		Array.isArray(group)
			? group.map((member) => String(member).trim()).filter((member) => member.length > 0)
			: [String(group).trim()],
	);
}

/** Every default in one place -- must match the `contributes.configuration` block in package.json. */
export function buildConfig(root: string, storageDir: string, get: SettingReader): LunitConfig {
	const outDirName = get<string>('outDir', 'out');
	const outDir = path.join(root, outDirName);

	const baseTokens = {
		workspaceFolder: root,
		storageDir,
		outDir,
	};

	const projectFile = resolveTokens(get<string>('studio.projectFile', '${storageDir}/studio-test.project.json'), baseTokens);
	const placeFile = resolveTokens(get<string>('studio.placeFile', '${storageDir}/test-place.rbxl'), baseTokens);

	// `${projectFile}` is deliberately left in buildPlaceCommand: which Rojo
	// project it names is decided per run (resolveBuildPlaceCommand).
	const studioTokens = { ...baseTokens, placeFile };

	return {
		workspaceRoot: root,
		storageDir,
		testGlob: get<string>('testGlob', '**/*.{test,spec}.{ts,tsx}'),
		excludeGlob: get<string>('excludeGlob', '**/node_modules/**'),
		skipCompile: get<boolean>('skipCompile', false),
		compileCommand: resolveTokens(get<string>('compileCommand', 'npx rbxtsc'), baseTokens),
		outDir,
		env: get<Record<string, string>>('env', {}),
		lune: {
			executable: get<string>('lune.executable', 'lune'),
			testsRoot: resolveTokens(get<string>('testsRoot', '${workspaceFolder}'), baseTokens),
			lunitRoot: resolveTokens(get<string>('lunitRoot', '${workspaceFolder}/node_modules/@rbxts/lunit/out'), baseTokens),
			projectFile: resolveTokens(get<string>('lune.projectFile', ''), baseTokens),
			slowTags: normalizeTagList(get<unknown>('lune.slowTags', [])),
			parallel: {
				enabled: get<boolean>('lune.parallel.enabled', true) !== false,
				workers: normalizeWorkers(get<unknown>('lune.parallel.workers', 0)),
				dependencyGroups: normalizeDependencyGroups(get<unknown>('lune.parallel.dependencyGroups', [])),
			},
		},
		studio: {
			enabled: get<boolean>('studio.enabled', true),
			executablePath: get<string>('studio.executablePath', ''),
			buildPlaceCommand: resolveTokens(
				get<string>('studio.buildPlaceCommand', 'npx rojo build "${projectFile}" --output "${placeFile}"'),
				studioTokens,
			),
			rojoProject: resolveTokens(get<string>('studio.rojoProject', ''), baseTokens),
			projectFile,
			placeFile,
			bootstrapScript: resolveTokens(get<string>('studio.bootstrapScript', '${storageDir}/studio-bootstrap.luau'), studioTokens),
			outputFile: resolveTokens(get<string>('studio.outputFile', '${storageDir}/studio-output.log'), studioTokens),
			quitAfterExecution: get<boolean>('studio.quitAfterExecution', true),
			timeoutSeconds: get<number>('studio.timeoutSeconds', 180),
			liveSync: {
				enabled: get<boolean>('studio.liveSync.enabled', true),
				port: get<number>('studio.liveSync.port', DEFAULT_LIVE_SYNC_PORT),
				timeoutSeconds: get<number>('studio.liveSync.timeoutSeconds', 30),
				syncDelaySeconds: get<number>('studio.liveSync.syncDelaySeconds', 1),
			},
		},
	};
}

/** The place-building command for one run, naming the Rojo project it builds. */
export function resolveBuildPlaceCommand(buildPlaceCommand: string, projectFile: string): string {
	return resolveTokens(buildPlaceCommand, { projectFile });
}
