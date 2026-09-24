import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CancelSignal } from './cancelSignal';
import { buildStudioBootstrapScript } from './bootstrapTemplate';
import { LunitConfig, resolveBuildPlaceCommand } from './config';
import { detectStudioProject, describeStudioProjectRemedy, StudioProjectDetection } from './studioProjectKind';
import { LiveSyncBridge } from './liveSyncBridge';
import { buildLiveSyncJobScript } from './liveSyncScriptTemplate';
import { SlowTestFilter, TestSelection } from './luauTestFilterTemplate';
import { RunOutcome } from './luneRunner';
import { runCommand } from './processRunner';
import { parseResultLines } from './resultProtocol';
import { isRojoServeRunning } from './rojoDetect';
import { describeToolFailure } from './toolDiagnostics';
import { buildStudioProjectFile, parsePackageName } from './studioProjectTemplate';
import { buildStudioPluginScript } from './studioPluginTemplate';

const RBXTS_INCLUDE_RELATIVE = path.join('node_modules', 'roblox-ts', 'include');
const NODE_MODULES_RELATIVE = 'node_modules';

function toForwardSlashes(p: string): string {
	return p.split(path.sep).join('/');
}

/** Recursively checks (with early exit) whether a directory contains any .lua/.luau file. */
function containsLuauFile(dir: string): boolean {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (containsLuauFile(full)) {
				return true;
			}
		} else if (/\.luau?$/i.test(entry.name)) {
			return true;
		}
	}
	return false;
}

/**
 * Whether this workspace folder has its own Rojo project file at all (e.g.
 * `default.project.json`, or any other `*.project.json` in the root -- `rojo
 * serve` accepts a custom name as an explicit argument). Used to gate the
 * live-sync path: a connected Studio plugin only means *some* project is
 * currently synced into that Studio instance -- not necessarily this one
 * (e.g. this package has no project file of its own, common for a library
 * normally embedded in a larger dev workspace's own Rojo tree, opened here
 * standalone with Studio left over from a previous session). Without a
 * project file, `rojo serve` has nothing here to serve, so live-sync would
 * just run tests against whatever's currently synced -- possibly nothing to
 * do with this project -- instead of this project's actual code.
 */
function hasRojoProjectFile(rootDir: string): boolean {
	if (fs.existsSync(path.join(rootDir, 'default.project.json'))) {
		return true;
	}
	try {
		return fs.readdirSync(rootDir).some((name) => name.endsWith('.project.json'));
	} catch {
		return false;
	}
}

/**
 * Every "@scope" directory directly under node_modules that actually
 * contains Luau content -- not just @rbxts. A dependency's own internals can
 * be published under a different scope (e.g. @rbxts/react pulls in
 * react-lua's internals under @rbxts-js), and missing one doesn't error, it
 * hangs forever on a WaitForChild that never resolves.
 *
 * Each scope is synced with one wholesale `$path` (not flattened
 * package-by-package): react-lua's packages ship their own nested
 * `default.project.json` (e.g. `{"name": "React", "tree": {"$path": "src"}}`),
 * and Rojo's automatic nested-project discovery renames each resulting
 * instance to that project's own `name` field -- `react-reconciler` becomes
 * `ReactReconciler`, etc. That's not a side effect to route around: hand-written
 * compatibility shims in this ecosystem (e.g. `@rbxts/react/src/init.lua`,
 * which does `script.Parent.Parent:WaitForChild("@rbxts-js").React`) are
 * *written expecting* exactly that renamed, PascalCase layout. An earlier
 * version of this function flattened each package to its resolved content
 * directory specifically to avoid this rename, which fixed a Rojo build
 * failure but broke that cross-scope reference in exchange -- confirmed by
 * a real Studio run ("React is not a valid member of Folder ...@rbxts-js").
 * The actual cause of the build failure was never the rename at all: it was
 * syncing @roblox-ts (pure JS/TS compiler tooling, no default.project.json,
 * but its own deeply nested node_modules, 1000+ files) wholesale, which is
 * exactly what the Luau-content filter below already excludes on its own.
 */
function findNodeModuleScopes(cwd: string): string[] {
	const nodeModulesDir = path.join(cwd, NODE_MODULES_RELATIVE);
	try {
		return fs
			.readdirSync(nodeModulesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith('@'))
			.map((entry) => entry.name)
			.filter((scope) => containsLuauFile(path.join(nodeModulesDir, scope)));
	} catch {
		return [];
	}
}

/**
 * Auto-detects the newest installed RobloxStudioBeta.exe under
 * %LOCALAPPDATA%\\Roblox\\Versions when the user hasn't configured
 * lunit.studio.executablePath explicitly. Windows only; other platforms
 * must set the path manually.
 */
export function findStudioExecutable(configuredPath: string): string | undefined {
	if (configuredPath.trim().length > 0) {
		return configuredPath;
	}
	if (process.platform !== 'win32') {
		return undefined;
	}
	const versionsDir = path.join(os.homedir(), 'AppData', 'Local', 'Roblox', 'Versions');
	if (!fs.existsSync(versionsDir)) {
		return undefined;
	}
	let candidates: string[];
	try {
		candidates = fs.readdirSync(versionsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(versionsDir, entry.name, 'RobloxStudioBeta.exe'))
			.filter((exe) => fs.existsSync(exe));
	} catch {
		return undefined;
	}
	if (candidates.length === 0) {
		return undefined;
	}
	candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	return candidates[0];
}

const PLUGIN_FILE_NAME = 'LunitStudioBridge.lua';
/** Written by an earlier version of installStudioPlugin; cleaned up on (re)install now that the icon comes from Studio's own bundle instead. */
const STALE_PLUGIN_ICON_FILE_NAME = 'LunitStudioBridgeIcon.png';

/**
 * Roblox Studio auto-loads any script dropped directly in this folder as a
 * plugin on startup -- no packaging/publishing step needed. Windows and
 * macOS only; other platforms need a manual install (there's no standard
 * location to guess).
 */
function getStudioPluginsDir(): string | undefined {
	if (process.platform === 'win32') {
		return path.join(os.homedir(), 'AppData', 'Local', 'Roblox', 'Plugins');
	}
	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Documents', 'Roblox', 'Plugins');
	}
	return undefined;
}

/** Whether the companion Studio plugin has already been installed on this machine. */
export function isStudioPluginInstalled(): boolean {
	const pluginsDir = getStudioPluginsDir();
	return pluginsDir !== undefined && fs.existsSync(path.join(pluginsDir, PLUGIN_FILE_NAME));
}

export type InstallPluginResult = { installedPath: string } | { error: string };

/** Regenerates and (re)installs the companion Studio plugin -- see studioPluginTemplate.ts. */
export function installStudioPlugin(port: number): InstallPluginResult {
	const pluginsDir = getStudioPluginsDir();
	if (!pluginsDir) {
		return {
			error: `Automatic install isn't supported on ${process.platform}. Copy the plugin file manually into Roblox Studio's Plugins folder.`,
		};
	}
	try {
		fs.mkdirSync(pluginsDir, { recursive: true });
		fs.rmSync(path.join(pluginsDir, STALE_PLUGIN_ICON_FILE_NAME), { force: true });
		const pluginPath = path.join(pluginsDir, PLUGIN_FILE_NAME);
		fs.writeFileSync(pluginPath, buildStudioPluginScript(port), 'utf8');
		return { installedPath: pluginPath };
	} catch (err) {
		return { error: `Failed to write the plugin file: ${String(err)}` };
	}
}

interface PackageJson {
	name?: string;
}

interface NestedTestPackage {
	scope: string;
	name: string;
	outDirPath: string;
}

/**
 * Finds every OTHER directory in the workspace, besides the top-level
 * `config.outDir` itself, literally named the same as it (default "out")
 * and actually containing compiled Luau -- i.e. every nested roblox-ts
 * package with its own independent tsconfig.json/outDir, embedded somewhere
 * in a larger dev workspace (the standalone-Studio-build counterpart to the
 * `lunit.testsRoot` fix for the Lune profile in config.ts -- same root
 * cause: a package's tests aren't necessarily under the workspace root's own
 * compiled output). Confirmed against a real dev workspace where the actual
 * tests lived under `Packages/<nested-package>/out`, invisible to the
 * previous single-outDir mount -- the built place had nothing under the
 * package-under-test's own node to find, silently.
 *
 * Each match's *own* package.json (its immediate parent directory) provides
 * the scope/name to mount it under, since that's what compiled code
 * importing it by name actually expects at runtime -- not necessarily its
 * folder name (e.g. a real nested package's folder was `rbxts-react-clean-ui`
 * but its package.json `name` was `@rbxts/react-clean-ui`).
 */
function findNestedTestPackages(cwd: string, outDirName: string, topLevelOutDir: string): NestedTestPackage[] {
	const found: NestedTestPackage[] = [];
	const seen = new Set<string>([path.resolve(topLevelOutDir)]);

	function walk(dir: string): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') {
				continue;
			}
			const full = path.join(dir, entry.name);
			if (entry.name === outDirName) {
				const resolved = path.resolve(full);
				if (!seen.has(resolved) && containsLuauFile(full)) {
					seen.add(resolved);
					const pkgName = readPackageName(dir);
					const parsed = parsePackageName(pkgName);
					if (parsed.name) {
						found.push({ scope: parsed.scope, name: parsed.name, outDirPath: toForwardSlashes(full) });
					}
				}
				continue; // don't descend into a matched "out" dir looking for more
			}
			walk(full);
		}
	}

	walk(cwd);
	return found;
}

function readPackageName(cwd: string): string {
	const pkgPath = path.join(cwd, 'package.json');
	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
		if (pkg.name) {
			return pkg.name;
		}
	} catch {
		// fall through
	}
	return path.basename(cwd);
}

/**
 * Which Rojo project the standalone Studio place is built from -- the
 * project's own for a roblox-ts game project, the generated package layout
 * otherwise. See studioProjectKind.ts for the rules and the reason.
 */
export function detectStudioProjectFor(config: LunitConfig): StudioProjectDetection {
	return detectStudioProject({
		workspaceRoot: config.workspaceRoot,
		outDir: config.outDir,
		compileCommand: config.compileCommand,
		configuredProjectFile: config.studio.rojoProject,
		luneProjectFile: config.lune.projectFile,
	});
}

/**
 * Writes the self-contained test Rojo project (studioProjectTemplate.ts) for
 * a roblox-ts *package*, always overwritten -- see that file for why a package
 * needs no default.project.json of its own. Never used for a game project:
 * its compiled output only resolves in the tree its own Rojo file describes.
 */
export function writePackageLayoutProjectFile(config: LunitConfig): string {
	const cwd = config.workspaceRoot;
	const projectFile = config.studio.projectFile;
	fs.mkdirSync(path.dirname(projectFile), { recursive: true });

	const { scope: packageScope, name: packageName } = parsePackageName(readPackageName(cwd));

	const scopePaths = new Map<string, string>();
	for (const scope of findNodeModuleScopes(cwd)) {
		scopePaths.set(scope, toForwardSlashes(path.join(cwd, NODE_MODULES_RELATIVE, scope)));
	}

	const nestedPackages = findNestedTestPackages(cwd, path.basename(config.outDir), config.outDir);

	const projectContent = buildStudioProjectFile({
		rbxtsIncludePath: toForwardSlashes(path.join(cwd, RBXTS_INCLUDE_RELATIVE)),
		scopePaths,
		outDirPath: toForwardSlashes(config.outDir),
		packageScope,
		packageName,
		extraPackages: nestedPackages,
	});
	fs.writeFileSync(projectFile, projectContent, 'utf8');
	return projectFile;
}

/** Writes the bootstrap script (bootstrapTemplate.ts) Studio runs against the built place, always overwritten. */
export function writeStudioBootstrapScript(
	config: LunitConfig,
	layout: 'package' | 'game',
	selection?: TestSelection,
	slow?: SlowTestFilter,
): string {
	fs.mkdirSync(path.dirname(config.studio.bootstrapScript), { recursive: true });
	fs.writeFileSync(config.studio.bootstrapScript, buildStudioBootstrapScript(selection, slow, { layout }), 'utf8');
	return config.studio.bootstrapScript;
}

/**
 * Regenerates what the standalone Studio run would use: the bootstrap script
 * for the detected layout and, for a package project, the generated Rojo
 * project. `projectFile` is the Rojo project the place would be built from
 * (the project's own for a game project), or undefined when the run would
 * be blocked -- see `detection.blocked`.
 */
export function regenerateStudioFiles(
	config: LunitConfig,
	selection?: TestSelection,
	slow?: SlowTestFilter,
): { detection: StudioProjectDetection; projectFile: string | undefined; bootstrapScript: string } {
	const detection = detectStudioProjectFor(config);
	const bootstrapScript = writeStudioBootstrapScript(config, detection.kind, selection, slow);
	if (detection.kind === 'package') {
		return { detection, projectFile: writePackageLayoutProjectFile(config), bootstrapScript };
	}
	return { detection, projectFile: detection.projectFile, bootstrapScript };
}

/**
 * Compiles the project, then runs the tests inside a Roblox Studio instance
 * that's already open with this project live-synced via the consuming
 * project's own `rojo serve` -- detected via the companion Studio plugin
 * (studioPluginTemplate.ts) actively polling `bridge` -- instead of
 * building a place and launching a new Studio process. No Play mode
 * required: plugins run continuously in Edit mode too.
 */
async function runViaLiveSync(
	config: LunitConfig,
	bridge: LiveSyncBridge,
	token: CancelSignal,
	onOutput: (chunk: string) => void,
	selection: TestSelection | undefined,
	slow: SlowTestFilter | undefined,
): Promise<RunOutcome> {
	onOutput(
		'[lunit] an already-open, Rojo-synced Roblox Studio instance was detected (Lunit Studio plugin connected) -- running tests there directly instead of launching a new Studio process.\n',
	);

	if (!(await isRojoServeRunning())) {
		onOutput(
			'[lunit] WARNING: no "rojo serve" was detected on this machine. Tests will still run, but against whatever code was last synced into that Studio instance -- possibly stale, or from a different project -- not necessarily your current changes. Start "rojo serve" for this project if that\'s not what you want.\n',
		);
	}

	if (!config.skipCompile) {
		onOutput(`> ${config.compileCommand}\n`);
		const compileResult = await runCommand(config.compileCommand, {
			cwd: config.workspaceRoot,
			env: config.env,
			token,
			onOutput,
		});
		if (compileResult.cancelled || compileResult.timedOut || compileResult.code !== 0) {
			if (compileResult.code !== 0 && !compileResult.cancelled && !compileResult.timedOut) {
				const diagnosis = describeToolFailure(compileResult.output);
				onOutput(
					diagnosis
						? `\n${diagnosis}\n`
						: `\n[lunit] compile command exited with code ${compileResult.code}, aborting test run.\n`,
				);
			}
			return compileResult;
		}
	}

	if (config.studio.liveSync.syncDelaySeconds > 0) {
		onOutput('[lunit] giving your running "rojo serve" a moment to sync the compiled changes...\n');
		await new Promise((resolve) => setTimeout(resolve, config.studio.liveSync.syncDelaySeconds * 1000));
	}

	try {
		const output = await bridge.runJob(
			buildLiveSyncJobScript({ selection, slow, deadlineSeconds: config.studio.liveSync.timeoutSeconds }),
			config.studio.liveSync.timeoutSeconds * 1000,
			token,
		);
		onOutput(output + '\n');
		const anyFailed = output.includes('[lunit] ERROR:') || parseResultLines(output).some((r) => r.status === 'failed');
		return { code: anyFailed ? 1 : 0, output, timedOut: false, cancelled: false };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message === 'cancelled') {
			return { code: null, output: '', timedOut: false, cancelled: true };
		}
		onOutput(`\n[lunit] ${message}\n`);
		return { code: null, output: message, timedOut: message.includes('timed out'), cancelled: false };
	}
}

/**
 * Compiles the project, regenerates the bootstrap script, builds a standalone
 * place file -- from the project's own Rojo file for a roblox-ts game
 * project, or from the generated self-contained test project for a package
 * (see studioProjectKind.ts) -- and launches Roblox Studio's "--task
 * RunScript" CLI mode to run the bootstrap script against it, capturing its
 * --outputFile log. A game project with no Rojo project to build from, or a
 * failed build, ends the run with code 2 and `error` set. If `bridge` has a connected
 * Studio plugin and `lunit.studio.liveSync.enabled` is true, delegates to
 * the faster live-sync path (runViaLiveSync) instead -- see there.
 *
 * Both paths leave out @Tag("Lune") tests and the slow tests `slow` names; `selection`, when given, narrows
 * the run to the classes/methods of an explicit request.
 */
export async function runViaStudio(
	config: LunitConfig,
	token: CancelSignal,
	onOutput: (chunk: string) => void,
	bridge?: LiveSyncBridge,
	selection?: TestSelection,
	slow?: SlowTestFilter,
): Promise<RunOutcome> {
	const cwd = config.workspaceRoot;
	const studio = config.studio;

	if (bridge && config.studio.liveSync.enabled && bridge.isPluginConnected) {
		if (hasRojoProjectFile(cwd)) {
			return runViaLiveSync(config, bridge, token, onOutput, selection, slow);
		}
		onOutput(
			'[lunit] the Lunit Studio plugin is connected, but this project has no Rojo project file of its own (e.g. default.project.json) -- there\'s nothing here for "rojo serve" to serve, so the connected Studio instance is presumably showing some other project (or nothing). Building a standalone place and launching a new Studio process instead.\n',
		);
	}

	if (!config.skipCompile) {
		onOutput(`> ${config.compileCommand}\n`);
		const compileResult = await runCommand(config.compileCommand, { cwd, env: config.env, token, onOutput });
		if (compileResult.cancelled || compileResult.timedOut || compileResult.code !== 0) {
			if (compileResult.code !== 0 && !compileResult.cancelled && !compileResult.timedOut) {
				const diagnosis = describeToolFailure(compileResult.output);
				onOutput(
					diagnosis
						? `\n${diagnosis}\n`
						: `\n[lunit] compile command exited with code ${compileResult.code}, aborting test run.\n`,
				);
			}
			return compileResult;
		}
	}

	// Which tree the place is built from decides whether the compiled tests
	// can resolve their imports at all -- see studioProjectKind.ts.
	const detection = detectStudioProjectFor(config);
	onOutput(`[lunit] ${detection.reason}.\n`);
	if (detection.blocked) {
		onOutput(`${detection.blocked}\n`);
		return { code: 2, output: detection.blocked, timedOut: false, cancelled: false, error: detection.blocked };
	}

	let projectFile: string;
	if (detection.kind === 'game' && detection.projectFile) {
		projectFile = detection.projectFile;
	} else {
		const rbxtsIncludePath = path.join(cwd, RBXTS_INCLUDE_RELATIVE);
		if (!fs.existsSync(rbxtsIncludePath)) {
			const message = `[lunit] could not find ${RBXTS_INCLUDE_RELATIVE} -- is roblox-ts installed in this project?`;
			onOutput(`${message}\n`);
			return { code: 2, output: message, timedOut: false, cancelled: false, error: message };
		}
		projectFile = writePackageLayoutProjectFile(config);
	}
	writeStudioBootstrapScript(config, detection.kind, selection, slow);

	await fs.promises.mkdir(path.dirname(studio.placeFile), { recursive: true });
	await fs.promises.rm(studio.placeFile, { force: true });
	const buildPlaceCommand = resolveBuildPlaceCommand(studio.buildPlaceCommand, projectFile);
	onOutput(`> ${buildPlaceCommand}\n`);
	const buildResult = await runCommand(buildPlaceCommand, { cwd, env: config.env, token, onOutput });
	if (buildResult.cancelled || buildResult.timedOut) {
		return buildResult;
	}
	if (buildResult.code !== 0) {
		const diagnosis = describeToolFailure(buildResult.output);
		const message = diagnosis
			? diagnosis
			: detection.kind === 'game'
				? `[lunit] "rojo build" failed (exit code ${buildResult.code}) for ${projectFile}, so there is no place to run the tests in. ${describeStudioProjectRemedy()}`
				: `[lunit] failed to build the Studio place file (exit code ${buildResult.code}), aborting test run.`;
		onOutput(`\n${message}\n`);
		return { ...buildResult, code: 2, error: message };
	}

	const executable = findStudioExecutable(studio.executablePath);
	if (!executable) {
		const message =
			'[lunit] could not locate RobloxStudioBeta.exe. Set "lunit.studio.executablePath" in settings.\n';
		onOutput(message);
		return { code: null, output: message, timedOut: false, cancelled: false };
	}
	if (!fs.existsSync(executable)) {
		const message = `[lunit] configured Studio executable does not exist: ${executable}\n`;
		onOutput(message);
		return { code: null, output: message, timedOut: false, cancelled: false };
	}

	await fs.promises.mkdir(path.dirname(studio.outputFile), { recursive: true });
	await fs.promises.rm(studio.outputFile, { force: true });

	const args = [
		'--task', 'RunScript',
		'--localPlaceFile', studio.placeFile,
		'--runScriptFile', studio.bootstrapScript,
		'--outputFile', studio.outputFile,
	];
	if (studio.quitAfterExecution) {
		args.push('--quitAfterExecution');
	}

	const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
	onOutput(`> "${executable}" ${quoted}\n`);

	const studioResult = await runCommand(`"${executable}" ${quoted}`, {
		cwd,
		env: config.env,
		token,
		timeoutMs: studio.timeoutSeconds * 1000,
		onOutput,
	});

	if (studioResult.cancelled) {
		return studioResult;
	}
	if (studioResult.timedOut) {
		onOutput(`\n[lunit] Roblox Studio did not exit within ${studio.timeoutSeconds}s; killed it.\n`);
	}

	let logContents = '';
	try {
		logContents = await fs.promises.readFile(studio.outputFile, 'utf8');
	} catch {
		onOutput(`\n[lunit] no output file was produced at ${studio.outputFile}.\n`);
	}
	onOutput(logContents);

	return {
		code: studioResult.code,
		output: studioResult.output + logContents,
		timedOut: studioResult.timedOut,
		cancelled: studioResult.cancelled,
	};
}
