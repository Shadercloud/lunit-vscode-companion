import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { installAgentInstructions } from './agentInstructions';
import { DEFAULT_LIVE_SYNC_PORT } from './config';
import { getConfig } from './vscodeConfig';
import { DiscoveredClass, parseTestFile } from './discovery';
import { CliRunRequest, LiveSyncBridge } from './liveSyncBridge';
import { buildTestSelection } from './luauTestFilterTemplate';
import { LuneRunOutcome, RunOutcome, runViaLune } from './luneRunner';
import {
	partitionSlowTests,
	RunProfileId,
	runProfileSpecs,
	slowLeftOutMessage,
	slowTestFilterFor,
} from './runProfiles';
import { createResultLineFilter, parseResultLines, ResultRecord } from './resultProtocol';
import { isRojoServeRunning } from './rojoDetect';
import {
	BlockReport,
	buildSummary,
	LuneRunReport,
	matchesFilters,
	resolveBlockVerdict,
	resolveVerdict,
	RunSummary,
	runsUnder,
	RunVia,
	summarizeReport,
	TestIdentity,
	TestResultEntry,
	testsResolvedBy,
	Verdict,
} from './runReport';
import { TestRef } from './luneBlocks';
import { CancelSignal } from './cancelSignal';
import { writeCliLauncher } from './cliLauncher';
import {
	installStudioPlugin,
	isStudioPluginInstalled,
	regenerateStudioFiles,
	runViaStudio,
} from './studioRunner';

interface TestMeta {
	kind: 'folder' | 'file' | 'class' | 'test';
	uri: vscode.Uri;
	className?: string;
	methodName?: string;
	displayName?: string;
	/** A test's effective @Tag values (class-level and its own). */
	tags?: string[];
}

let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext;
let liveSyncBridge: LiveSyncBridge | undefined;
const metaById = new Map<string, TestMeta>();
/** Resolves once the initial discovery pass (kicked off in activate) has finished. */
let initialDiscovery: Promise<void> = Promise.resolve();
/** The registered run profiles, kept here so runFromCli can attribute its TestRunRequest to the right one. */
const profileRefs = new Map<RunProfileId, vscode.TestRunProfile>();

/**
 * Set as each run profile's own `tag` (see createRunProfile's `tag` param),
 * which VS Code documents as restricting a profile to "eligible" TestItems
 * -- but in practice only affects UI affordances (which profiles are offered
 * for a given item); a whole-tree run still comes through with
 * `request.include === undefined` ("run all tests" -- see TestRunRequest's
 * doc comment), so the actual exclusion happens explicitly against these
 * tags in executeRun's leaf collection below, not from the tag alone.
 *
 * A test/class is tagged based on `@Tag("Studio")` / `@Tag("Lune")` (see
 * discovery.ts, case-insensitive, class-level tags apply to every method in
 * the class): `@Tag("Studio")` means "skip under Lune", `@Tag("Lune")` means
 * "skip under Roblox Studio", no matching tag means "runs under both".
 *
 * Slow tests (`lunit.lune.slowTags`) keep their profile tags on purpose: both
 * "Run with Lune" (for an explicitly selected slow test) and "Run with Lune
 * (Full)", which shares LUNE_TAG, must stay offered for them. The slow rule
 * itself is applied in executeRun.
 */
const LUNE_TAG = new vscode.TestTag('lunit.lune');
const STUDIO_TAG = new vscode.TestTag('lunit.studio');

function computeRunTags(effectiveTags: readonly string[]): vscode.TestTag[] {
	const tags: vscode.TestTag[] = [];
	if (runsUnder(effectiveTags, 'lune')) {
		tags.push(LUNE_TAG);
	}
	if (runsUnder(effectiveTags, 'studio')) {
		tags.push(STUDIO_TAG);
	}
	return tags;
}

function unionTags(tagLists: readonly (readonly vscode.TestTag[])[]): vscode.TestTag[] {
	const seen = new Map<string, vscode.TestTag>();
	for (const tags of tagLists) {
		for (const tag of tags) {
			seen.set(tag.id, tag);
		}
	}
	return [...seen.values()];
}

/**
 * Everything this extension generates (Lune runner scripts, the Studio test
 * Rojo project + bootstrap script, the built place file, Studio's output
 * log) is written here -- VS Code's own per-workspace extension storage,
 * outside the project entirely -- rather than into the workspace itself
 * (e.g. a `.vscode/lunit/` folder), so nothing generated ever shows up in
 * the user's project or needs a .gitignore entry.
 */
function getStorageDir(folder: vscode.WorkspaceFolder): string {
	const base = (extensionContext.storageUri ?? extensionContext.globalStorageUri).fsPath;
	// Namespace by folder name only when it's actually ambiguous (a
	// multi-root workspace); storageUri is already unique per single-folder
	// workspace, so keep those paths short.
	const dir = (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? path.join(base, folder.name) : base;
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

async function installPluginInteractive(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const port = folder ? getConfig(folder, getStorageDir(folder)).studio.liveSync.port : 34873;
	const result = installStudioPlugin(port);
	if ('error' in result) {
		vscode.window.showErrorMessage(`Lunit: ${result.error}`);
		return;
	}
	vscode.window.showInformationMessage(
		`Lunit: installed the Roblox Studio live-sync plugin to ${result.installedPath}. To activate the update without closing Studio, enable Plugin Debugging Enabled in Studio settings, replace the LunitStudioBridge script in PluginDebugService with this file, then right-click its plugin and choose Save and Reload Plugin. Writing the file alone does not update an already-loaded bridge.`,
	);
}

const HAS_PROMPTED_PLUGIN_INSTALL_KEY = 'lunit.hasPromptedPluginInstall';

/**
 * Shown once, the first time the extension activates without the plugin
 * already installed -- without it, "Run in Roblox Studio" silently falls
 * back to the slower build+launch path every time, which looks like it's
 * just working normally, so a user has no obvious signal that they're
 * missing out on the faster live-sync path unless told directly.
 */
async function maybePromptPluginInstall(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(HAS_PROMPTED_PLUGIN_INSTALL_KEY) || isStudioPluginInstalled()) {
		return;
	}
	await context.globalState.update(HAS_PROMPTED_PLUGIN_INSTALL_KEY, true);
	const choice = await vscode.window.showInformationMessage(
		'Lunit: install the companion Roblox Studio plugin? It lets "Run in Roblox Studio" run tests in an already-open, Rojo-synced Studio instance -- faster, and no Play mode needed. One-time setup.',
		'Install Plugin',
		'Later',
	);
	if (choice === 'Install Plugin') {
		await installPluginInteractive();
	}
}

export function activate(context: vscode.ExtensionContext): void {
	extensionContext = context;
	outputChannel = vscode.window.createOutputChannel('Lunit');
	context.subscriptions.push(outputChannel);

	const controller = vscode.tests.createTestController('lunitTests', '@rbxts/lunit Testing');
	context.subscriptions.push(controller);

	// Started once, for the whole session (not per-run), so isPluginConnected
	// reflects reality *before* the user asks to run anything -- see
	// studioRunner.ts's runViaStudio for why that matters. The first folder's
	// configured port starts the discovery range. Each window takes a free
	// port in that range and Studio explicitly selects a window by identity.
	const liveSyncPort =
		vscode.workspace.workspaceFolders?.[0] &&
		getConfig(vscode.workspace.workspaceFolders[0], getStorageDir(vscode.workspace.workspaceFolders[0])).studio
			.liveSync.port;
	liveSyncBridge = new LiveSyncBridge(liveSyncPort ?? DEFAULT_LIVE_SYNC_PORT, (err) =>
		outputChannel.appendLine(`[lunit] live-sync bridge error: ${err.message}`), 2000,
		(vscode.workspace.workspaceFolders ?? []).map(folder => ({ name: folder.name, path: folder.uri.fsPath })),
	);
	// The command-line route (cli.ts): an agent's `POST /run` on the same
	// local server ends up in executeRun below, the exact code path a Test
	// Explorer click takes -- so it produces identical verdicts and the run
	// shows up in the Testing view as well.
	liveSyncBridge.runHandler = (request, onOutput, cancel) => runFromCli(controller, request, onOutput, cancel);
	liveSyncBridge.start();
	context.subscriptions.push({ dispose: () => liveSyncBridge?.stop() });

	// A stable, version-independent path agents can invoke (see cliLauncher.ts).
	const cliLauncherPath = writeCliLauncher(context.globalStorageUri.fsPath, context.extensionPath, (message) =>
		outputChannel.appendLine(message),
	);

	const statusBarItem = vscode.window.createStatusBarItem('lunit.liveSyncStatus', vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'lunit.showLiveSyncStatus';
	context.subscriptions.push(statusBarItem);
	// Refreshed on the same tick this depends on: pluginConnected, rojoDetected.
	// Three real states, not two -- a connected plugin with no rojo serve
	// running is its own warning (see showLiveSyncStatus), not the same as
	// "fully working".
	const refreshStatusBar = async () => {
		const connectionError = liveSyncBridge?.connectionError;
		if (connectionError) {
			statusBarItem.text = '$(error) Lunit: Studio bridge unavailable';
			statusBarItem.tooltip = connectionError;
			statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			return;
		}
		const connected = liveSyncBridge?.isPluginConnected ?? false;
		const rojoRunning = connected ? await isRojoServeRunning() : false;
		if (connected && rojoRunning) {
			statusBarItem.text = '$(beaker) Lunit: Studio connected';
			statusBarItem.tooltip =
				'A Roblox Studio instance with the Lunit live-sync plugin is connected, and "rojo serve" is running -- "Run in Roblox Studio" will run tests there directly.';
			statusBarItem.backgroundColor = undefined;
		} else if (connected) {
			statusBarItem.text = '$(warning) Lunit: Studio connected, rojo serve not detected';
			statusBarItem.tooltip =
				'The Lunit live-sync plugin is connected, but no "rojo serve" was detected on this machine -- tests would still run, but against whatever was last synced (possibly stale, or a different project), not your current changes. Click for details.';
			statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else {
			statusBarItem.text = '$(beaker) Lunit: Studio not connected';
			statusBarItem.tooltip =
				'In Studio, click Lunit and select this workspace. No Studio instance is currently connected to this window. Click for details.';
			statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		}
	};
	void refreshStatusBar();
	statusBarItem.show();
	const statusBarInterval = setInterval(() => void refreshStatusBar(), 2000);
	context.subscriptions.push({ dispose: () => clearInterval(statusBarInterval) });

	controller.resolveHandler = async (item) => {
		if (!item) {
			await discoverAll(controller);
		}
	};
	// Wires up the Test Explorer's own built-in refresh icon (distinct from
	// the "Lunit: Refresh Tests" command) -- without this, that button is a
	// no-op and stale items (e.g. a commented-out @Test) never get re-synced.
	controller.refreshHandler = () => discoverAll(controller);

	// Only one profile should ever be "default" at a time -- VS Code's own
	// "Select Default Profile" picker lets you check several simultaneously
	// (it's built for kinds where running several defaults together makes
	// sense), so each profile's onDidChangeDefault listener below un-defaults
	// the others to force a single-select choice instead. Explicitly running a
	// profile from the Run dropdown also marks it default (and the others not)
	// -- harmless if it already was.
	const profileListeners = new Map<RunProfileId, vscode.Disposable>();
	const makeSoleDefault = (id: RunProfileId) => {
		for (const [otherId, other] of profileRefs) {
			if (otherId !== id) {
				other.isDefault = false;
			}
		}
	};
	// Which profiles exist follows settings (see runProfileSpecs): the Full
	// profile only with lunit.lune.slowTags, the Studio one unless disabled.
	const syncProfiles = () => {
		const folder = vscode.workspace.workspaceFolders?.[0];
		const config = folder ? getConfig(folder, getStorageDir(folder)) : undefined;
		const specs = runProfileSpecs({
			studioEnabled: config?.studio.enabled ?? true,
			slowTags: config?.lune.slowTags ?? [],
		});
		const wanted = new Set(specs.map((spec) => spec.id));
		for (const [id, profile] of [...profileRefs]) {
			if (!wanted.has(id)) {
				profileListeners.get(id)?.dispose();
				profileListeners.delete(id);
				profile.dispose();
				profileRefs.delete(id);
			}
		}
		for (const spec of specs) {
			if (profileRefs.has(spec.id)) {
				continue;
			}
			const profile = controller.createRunProfile(
				spec.label,
				vscode.TestRunProfileKind.Run,
				(request, token) => {
					profile.isDefault = true;
					makeSoleDefault(spec.id);
					return executeRun(controller, request, token, spec.via, { includeSlow: spec.includeSlow }).then(
						() => undefined,
					);
				},
				spec.isDefault,
				spec.via === 'lune' ? LUNE_TAG : STUDIO_TAG,
			);
			profileRefs.set(spec.id, profile);
			profileListeners.set(
				spec.id,
				profile.onDidChangeDefault((isDefault) => {
					if (isDefault) {
						makeSoleDefault(spec.id);
					}
				}),
			);
		}
		// Removing the default profile must not leave none.
		if (![...profileRefs.values()].some((profile) => profile.isDefault)) {
			profileRefs.get('lune')!.isDefault = true;
		}
	};
	syncProfiles();
	context.subscriptions.push({
		dispose: () => {
			profileListeners.forEach((listener) => listener.dispose());
			profileRefs.forEach((profile) => profile.dispose());
			profileListeners.clear();
			profileRefs.clear();
		},
	});
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('lunit.studio.enabled') || e.affectsConfiguration('lunit.lune.slowTags')) {
				syncProfiles();
			}
			if (e.affectsConfiguration('lunit.explorer')) {
				void discoverAll(controller);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lunit.refreshTests', () => discoverAll(controller)),
		vscode.commands.registerCommand('lunit.runAllTests', () =>
			vscode.commands.executeCommand('testing.runAll'),
		),
		vscode.commands.registerCommand('lunit.showOutput', () => outputChannel.show()),
		vscode.commands.registerCommand('lunit.openStudioBootstrapScript', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				vscode.window.showErrorMessage('Lunit: open a workspace folder first.');
				return;
			}
			const config = getConfig(folder, getStorageDir(folder));
			const { bootstrapScript } = regenerateStudioFiles(config);
			const doc = await vscode.workspace.openTextDocument(bootstrapScript);
			await vscode.window.showTextDocument(doc);
		}),
		vscode.commands.registerCommand('lunit.installStudioPlugin', installPluginInteractive),
		vscode.commands.registerCommand('lunit.showCliCommand', async () => {
			const command = cliLauncherPath
				? `node "${cliLauncherPath}" --studio`
				: 'the CLI launcher could not be written (see the Lunit output channel)';
			const choice = await vscode.window.showInformationMessage(
				`Lunit: agents (or you) can run the tests from any terminal with: ${command}  -- results are identical to the Test Explorer's, and also show up there. Add --lune for the Lune profile (--lune --full to include slow tests), --json for machine-readable output, or test/file name filters.`,
				...(cliLauncherPath ? ['Copy Command'] : []),
			);
			if (choice === 'Copy Command') {
				await vscode.env.clipboard.writeText(command);
			}
		}),
		vscode.commands.registerCommand('lunit.installAgentInstructions', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				vscode.window.showErrorMessage('Lunit: open a workspace folder first.');
				return;
			}
			const config = getConfig(folder, getStorageDir(folder));
			const { filePath, updated } = installAgentInstructions(config, cliLauncherPath);
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
			vscode.window.showInformationMessage(
				`Lunit: ${updated ? 'updated the Lunit section in' : 'created'} ${path.basename(filePath)} with instructions for coding agents on writing @rbxts/lunit tests for this project.`,
			);
		}),
		vscode.commands.registerCommand('lunit.showLiveSyncStatus', async () => {
			if (liveSyncBridge?.connectionError) {
				vscode.window.showErrorMessage(`Lunit: ${liveSyncBridge.connectionError}`);
				return;
			}
			const connected = liveSyncBridge?.isPluginConnected ?? false;
			const installed = isStudioPluginInstalled();

			if (connected) {
				const rojoRunning = await isRojoServeRunning();
				if (rojoRunning) {
					vscode.window.showInformationMessage(
						'Lunit: a Roblox Studio instance with the live-sync plugin is connected, and "rojo serve" is running. "Run in Roblox Studio" will run tests there directly instead of launching a new Studio process.',
					);
					return;
				}
				vscode.window.showWarningMessage(
					'Lunit: the live-sync plugin is connected, but no "rojo serve" was detected on this machine. Tests would still run, but against whatever code was last synced into that Studio instance -- possibly stale, or from a different project entirely -- not your current changes. Start "rojo serve" for this project before running tests.',
				);
				return;
			}

			const message = installed
				? 'Lunit: no Studio instance is connected to this VS Code window. In Studio, click Lunit and select this workspace. If the connection window is missing, reinstall and reload the Studio plugin. "Run in Roblox Studio" will otherwise build a place and launch a new Studio process.'
				: 'Lunit: the Roblox Studio live-sync plugin isn\'t installed yet. Without it, "Run in Roblox Studio" builds a place and launches a new Studio process every run instead of using one you already have open.';
			const action = installed ? undefined : 'Install Plugin';
			const choice = await vscode.window.showWarningMessage(message, ...(action ? [action] : []));
			if (action && choice === action) {
				await installPluginInteractive();
			}
		}),
	);

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const config = getConfig(folder, getStorageDir(folder));
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(folder, config.testGlob),
		);
		watcher.onDidCreate((uri) => updateFile(controller, uri));
		watcher.onDidChange((uri) => updateFile(controller, uri));
		watcher.onDidDelete((uri) => removeFile(controller, uri));
		context.subscriptions.push(watcher);
	}

	initialDiscovery = discoverAll(controller).then(() => {
		// Gated on having actually found Lunit tests -- this extension
		// activates on every VS Code window (onStartupFinished), so without
		// this check the prompt would show up in unrelated, non-Roblox
		// projects too.
		if (controller.items.size > 0) {
			void maybePromptPluginInstall(context);
		}
	});
}

let cliRunInProgress = false;

/**
 * Entry point for the command-line route (see cli.ts and
 * LiveSyncBridge.runHandler). Rediscovers tests first so files an agent just
 * created or edited are picked up even if the file watcher hasn't fired
 * yet, then hands off to executeRun -- the very same function both Test
 * Explorer profiles call -- with a real TestRunRequest, so the run is
 * visible in the Testing view too.
 */
async function runFromCli(
	controller: vscode.TestController,
	request: CliRunRequest,
	onOutput: (text: string) => void,
	cancel: CancelSignal,
): Promise<RunSummary> {
	const folder = findWorkspaceFolderContaining(request.cwd);
	if (!folder) {
		const known = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).join(', ') || '(none)';
		return buildSummary(
			request.via,
			[],
			false,
			`the Lunit VS Code extension listening on this port belongs to a different workspace (its folders: ${known}), not ${request.cwd}. Run from inside that workspace, or close that window so the CLI can run standalone.`,
		);
	}
	if (request.via === 'studio' && !getConfig(folder, getStorageDir(folder)).studio.enabled) {
		return buildSummary(request.via, [], false, 'the "Run in Roblox Studio" profile is disabled (lunit.studio.enabled is false).');
	}
	if (cliRunInProgress) {
		return buildSummary(request.via, [], false, 'a command-line test run is already in progress; wait for it to finish.');
	}
	cliRunInProgress = true;
	try {
		await initialDiscovery;
		await discoverAll(controller);

		const requiredTag = request.via === 'lune' ? LUNE_TAG : STUDIO_TAG;
		const include: vscode.TestItem[] = [];
		controller.items.forEach((root) => {
			const leaves: vscode.TestItem[] = [];
			collectLeaves(root, leaves);
			for (const leaf of leaves) {
				const identity = identityOf(leaf);
				if (
					identity &&
					leaf.tags.some((t) => t.id === requiredTag.id) &&
					matchesFilters(identity, request.filters, folder.uri.fsPath)
				) {
					include.push(leaf);
				}
			}
		});
		if (include.length === 0) {
			const why = request.filters.length > 0 ? ` matching ${request.filters.map((f) => `"${f}"`).join(', ')}` : '';
			return buildSummary(request.via, [], false, `no ${request.via === 'lune' ? 'Lune' : 'Roblox Studio'} tests were found${why}.`);
		}

		// --full only means something for Lune; slow tests matched by a CLI
		// filter are never "explicitly selected" (use --full for those).
		const includeSlow = request.via === 'lune' && request.full === true;
		const profile =
			request.via === 'studio'
				? profileRefs.get('studio')
				: (includeSlow && profileRefs.get('luneFull')) || profileRefs.get('lune');
		const runRequest = new vscode.TestRunRequest(include, undefined, profile);
		return await executeRun(controller, runRequest, cancel, request.via, {
			includeSlow,
			onOutput,
			explicitTests: false,
			workers: request.workers,
		});
	} finally {
		cliRunInProgress = false;
	}
}

function findWorkspaceFolderContaining(dir: string): vscode.WorkspaceFolder | undefined {
	const normalize = (p: string) => {
		const resolved = path.resolve(p).split('\\').join('/').replace(/\/+$/, '');
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	};
	const target = normalize(dir);
	const candidates = (vscode.workspace.workspaceFolders ?? []).filter((folder) => {
		const root = normalize(folder.uri.fsPath);
		return target === root || target.startsWith(root + '/');
	});
	// Deepest match wins for nested folders in a multi-root workspace.
	candidates.sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);
	return candidates[0];
}

function identityOf(leaf: vscode.TestItem): TestIdentity | undefined {
	const meta = metaById.get(leaf.id);
	if (!meta || meta.kind !== 'test' || !meta.className || !meta.methodName) {
		return undefined;
	}
	return { file: meta.uri.fsPath, className: meta.className, methodName: meta.methodName, displayName: meta.displayName };
}

export function deactivate(): void {
	metaById.clear();
}

async function discoverAll(controller: vscode.TestController): Promise<void> {
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const config = getConfig(folder, getStorageDir(folder));
		const pattern = new vscode.RelativePattern(folder, config.testGlob);
		const exclude = new vscode.RelativePattern(folder, config.excludeGlob);
		const files = await vscode.workspace.findFiles(pattern, exclude);
		for (const uri of files) {
			await updateFile(controller, uri);
		}
	}
}

async function updateFile(controller: vscode.TestController, uri: vscode.Uri): Promise<void> {
	let text: string;
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		text = Buffer.from(bytes).toString('utf8');
	} catch {
		return;
	}

	let classes: DiscoveredClass[];
	try {
		classes = parseTestFile(uri.fsPath, text);
	} catch (err) {
		outputChannel.appendLine(`[lunit] failed to parse ${uri.fsPath}: ${String(err)}`);
		return;
	}

	const fileId = uri.toString();
	if (classes.length === 0) {
		removeFile(controller, uri);
		return;
	}

	const explorerCfg = vscode.workspace.getConfiguration('lunit', uri);
	const humanize = explorerCfg.get<boolean>('explorer.humanizeNames', true);
	const displayNameIsLabel = explorerCfg.get<string>('explorer.displayName', 'description') === 'label';
	const pretty = (raw: string) => (humanize ? humanizeIdentifier(raw) : raw);
	// Label / dimmed-description split for a class or test: by default the
	// identifier is the label and @DisplayName (or, failing that, the JSDoc
	// summary) is the description, so a short method name can carry a longer
	// sentence beside it. With lunit.explorer.displayName = "label",
	// @DisplayName replaces the label instead, as Lunit's own report shows it.
	const labelAndSummary = (
		raw: string,
		displayName: string | undefined,
		doc: string | undefined,
	): { label: string; summary: string | undefined } => {
		if (displayName !== undefined && displayNameIsLabel) {
			return { label: displayName, summary: doc };
		}
		return { label: pretty(raw), summary: displayName ?? doc };
	};

	// Label is just the file name; the directory lives on the folder node
	// above it (see folderItemFor), so the tree reads "Lune > Input.test.ts"
	// rather than one long workspace-relative path per row.
	const fileItem = controller.createTestItem(fileId, fileLabel(uri), uri);
	metaById.set(fileId, { kind: 'file', uri });

	const classItems = classes.map((cls) => {
		const classId = `${fileId}::${cls.className}`;
		const classText = labelAndSummary(cls.className, cls.displayName, cls.doc);
		const classItem = controller.createTestItem(classId, classText.label, uri);
		classItem.range = new vscode.Range(cls.line, 0, cls.line, 0);
		classItem.description = describe(classText.summary, cls.tags, []);
		metaById.set(classId, { kind: 'class', uri, className: cls.className });

		const testItems = cls.tests.map((test) => {
			const testId = `${classId}::${test.methodName}`;
			const testText = labelAndSummary(test.methodName, test.displayName, test.doc);
			const testItem = controller.createTestItem(testId, testText.label, uri);
			testItem.range = new vscode.Range(test.line, 0, test.line, 0);
			const runTags = computeRunTags([...cls.tags, ...test.tags]);
			// Beyond the two run-profile tags, expose the test's own @Tag(...)
			// values (and skip/only) as VS Code tags so the Test Explorer's
			// "@lunitTests:<tag>" filter can select by them.
			const markers: string[] = [];
			if (test.hasSkip) {
				markers.push('skip');
			}
			if (test.isOnly) {
				markers.push('only');
			}
			if (test.eachCount !== undefined) {
				markers.push(`each x${test.eachCount}`);
			}
			testItem.tags = unionTags([
				runTags,
				[...cls.tags, ...test.tags].map((t) => new vscode.TestTag(t)),
				markers.filter((m) => !m.startsWith('each')).map((m) => new vscode.TestTag(m)),
			]);
			// Only show tags declared on the method itself; class-level tags
			// are already shown on the class row.
			testItem.description = describe(testText.summary, test.tags, markers);
			metaById.set(testId, {
				kind: 'test',
				uri,
				className: cls.className,
				methodName: test.methodName,
				displayName: test.displayName,
				tags: [...cls.tags, ...test.tags],
			});
			return testItem;
		});
		classItem.children.replace(testItems);
		classItem.tags = unionTags(testItems.map((t) => t.tags));
		return classItem;
	});
	fileItem.children.replace(classItems);
	fileItem.tags = unionTags(classItems.map((c) => c.tags));

	const folderItem = folderItemFor(controller, uri);
	folderItem.children.add(fileItem);
	folderItem.tags = unionTags(Array.from(folderItem.children, ([, child]) => child.tags));
}

/** Removes a test file's item (and its now-empty folder node, if any) from the tree. */
function removeFile(controller: vscode.TestController, uri: vscode.Uri): void {
	const fileId = uri.toString();
	metaById.delete(fileId);
	const folderId = folderIdFor(uri);
	const folderItem = controller.items.get(folderId);
	if (!folderItem) {
		return;
	}
	folderItem.children.delete(fileId);
	if (folderItem.children.size === 0) {
		controller.items.delete(folderId);
	} else {
		folderItem.tags = unionTags(Array.from(folderItem.children, ([, child]) => child.tags));
	}
}

function folderIdFor(uri: vscode.Uri): string {
	return `folder:${vscode.Uri.file(path.dirname(uri.fsPath)).toString()}`;
}

/**
 * Root nodes of the tree are one per directory that contains test files:
 * labelled by the directory's own name (e.g. "Lune", "Studio") with the
 * workspace-relative path shown dimmed alongside, so two same-named folders
 * in different packages are still told apart.
 */
function folderItemFor(controller: vscode.TestController, fileUri: vscode.Uri): vscode.TestItem {
	const folderId = folderIdFor(fileUri);
	const existing = controller.items.get(folderId);
	if (existing) {
		return existing;
	}
	const dirUri = vscode.Uri.file(path.dirname(fileUri.fsPath));
	const relative = workspaceRelativeLabel(dirUri);
	const item = controller.createTestItem(folderId, path.basename(dirUri.fsPath) || relative, dirUri);
	item.description = relative;
	controller.items.add(item);
	return item;
}

/** Dimmed per-row text: the summary sentence, then the item's own @Tag(...) values, then markers like "skip". */
function describe(
	summary: string | undefined,
	tags: readonly string[],
	markers: readonly string[],
): string | undefined {
	const parts = [...(summary ? [summary] : []), ...tags.map((t) => `@${t}`), ...markers];
	return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** "Grid.test.tsx" -> "Grid": the file name without its .test/.spec suffix and extension. */
function fileLabel(uri: vscode.Uri): string {
	const base = path.basename(uri.fsPath);
	const stripped = base.replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, '').replace(/\.[cm]?[jt]sx?$/i, '');
	return stripped.length > 0 ? stripped : base;
}

/**
 * "keepsLastValidTextWhenAnInvalidCharacterIsTyped" -> "Keeps last valid text
 * when an invalid character is typed" (sentence case); "InputNumberValidation"
 * -> "Input Number Validation" (a PascalCase name keeps its capitals). Acronyms
 * stay together ("parsesJSONInput" -> "Parses JSON input"), digits attach to
 * the preceding word, and underscores/dollars become spaces.
 */
export function humanizeIdentifier(name: string): string {
	const spaced = name
		.replace(/[_$]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.trim();
	const startsUpper = /^[A-Z]/.test(name);
	return spaced
		.split(/\s+/)
		.map((word, i) => {
			if (/^[A-Z0-9]{2,}$/.test(word)) {
				return word; // acronym
			}
			if (i === 0) {
				return word.charAt(0).toUpperCase() + word.slice(1);
			}
			return startsUpper ? word : word.charAt(0).toLowerCase() + word.slice(1);
		})
		.join(' ');
}

function workspaceRelativeLabel(uri: vscode.Uri): string {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	return folder ? vscode.workspace.asRelativePath(uri, vscode.workspace.workspaceFolders!.length > 1) : uri.fsPath;
}

function collectLeaves(item: vscode.TestItem, into: vscode.TestItem[]): void {
	if (item.children.size === 0) {
		into.push(item);
		return;
	}
	item.children.forEach((child) => collectLeaves(child, into));
}

/**
 * The one and only run path, shared by both Test Explorer profiles and the
 * command-line route (runFromCli). `onOutput`, when given, receives the
 * same displayed output the Lunit output channel and Test Results panel
 * get, and the returned summary carries the same verdict (and message) that
 * was applied to each TestItem -- via resolveVerdict in runReport.ts, so
 * neither route can drift from the other.
 */
interface ExecuteRunOptions {
	/** "Run with Lune (Full)": slow tests run even when not selected explicitly. */
	includeSlow: boolean;
	onOutput?: (text: string) => void;
	/**
	 * Whether a test item named directly in `request.include` counts as
	 * explicitly selected, so it runs even if slow (default true). The CLI
	 * route passes false: its include list is whatever its filters matched.
	 */
	explicitTests?: boolean;
	/** Lune only: overrides `lunit.lune.parallel.workers` for this run (the command line's `--workers`). */
	workers?: number;
}

async function executeRun(
	controller: vscode.TestController,
	request: vscode.TestRunRequest,
	token: CancelSignal,
	via: RunVia,
	options: ExecuteRunOptions,
): Promise<RunSummary> {
	const { onOutput } = options;
	const run = controller.createTestRun(request);
	const excluded = new Set((request.exclude ?? []).map((i) => i.id));

	const roots: vscode.TestItem[] = [];
	if (request.include) {
		roots.push(...request.include);
	} else {
		controller.items.forEach((item) => roots.push(item));
	}
	// Running a folder, file or class is not selecting its slow tests; running
	// the test itself is.
	const explicitIds = new Set(
		options.explicitTests === false
			? []
			: (request.include ?? []).filter((item) => metaById.get(item.id)?.kind === 'test').map((item) => item.id),
	);

	// request.include is undefined for a whole-tree run ("run all tests" --
	// see TestRunRequest's doc comment), which VS Code does NOT pre-filter by
	// profile tag -- that's on the extension. So even for an explicit
	// selection (where VS Code's own UI already limits what's offered),
	// re-checking the tag here is what actually keeps a @Tag("Studio") test
	// out of a Lune run rather than just out of its dropdown.
	const requiredTag = via === 'lune' ? LUNE_TAG : STUDIO_TAG;
	const eligible: vscode.TestItem[] = [];
	const leftOut: vscode.TestItem[] = [];
	for (const root of roots) {
		const candidates: vscode.TestItem[] = [];
		collectLeaves(root, candidates);
		for (const candidate of candidates) {
			if (excluded.has(candidate.id)) {
				continue;
			}
			(candidate.tags.some((t) => t.id === requiredTag.id) ? eligible : leftOut).push(candidate);
		}
	}

	// Tests this profile's tag rule leaves out (e.g. @Tag("Lune") under Studio)
	// are reported as skipped, never as failed or errored. The runners leave
	// them out on their side too (luauTestFilterTemplate.ts).
	const leftOutResults = applyVerdicts(run, leftOut, () => ({ status: 'skipped' }));

	if (eligible.length === 0) {
		run.end();
		return buildSummary(via, leftOutResults, false, 'no tests to run.');
	}

	const folder =
		vscode.workspace.getWorkspaceFolder(eligible[0].uri!) ?? vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		const message = 'Lunit: no workspace folder available to run tests in.';
		vscode.window.showErrorMessage(message);
		run.end();
		return buildSummary(via, [], false, message);
	}
	const config = getConfig(folder, getStorageDir(folder));

	// Slow tests the run did not ask for by name are left out without a
	// verdict (not skipped, not failed) and only counted in the report.
	const slow = partitionSlowTests(eligible, config.lune.slowTags, options.includeSlow, (leaf) => ({
		tags: metaById.get(leaf.id)?.tags ?? [],
		explicit: explicitIds.has(leaf.id),
	}));
	const leaves = slow.run;
	const slowFilter = slowTestFilterFor(
		config.lune.slowTags,
		options.includeSlow,
		slow.explicitSlow.map(identityOf).filter((identity): identity is TestIdentity => identity !== undefined),
	);
	const endRun = () => {
		if (slow.leftOut.length > 0) {
			const note = `[lunit] ${slowLeftOutMessage(slow.leftOut.length)}\n`;
			outputChannel.append(note);
			run.appendOutput(note.replace(/\n/g, '\r\n'));
			onOutput?.(note);
		}
		run.end();
	};
	const withSlowCount = (summary: RunSummary): RunSummary =>
		slow.leftOut.length > 0 ? { ...summary, slowLeftOut: slow.leftOut.length } : summary;

	if (leaves.length === 0) {
		// Everything eligible was slow: say so rather than "no tests".
		endRun();
		return withSlowCount(buildSummary(via, leftOutResults, false));
	}

	for (const leaf of leaves) {
		run.enqueued(leaf);
	}

	const displayFilter = createResultLineFilter((text) => {
		outputChannel.append(text);
		run.appendOutput(text.replace(/\r?\n/g, '\r\n'));
		onOutput?.(text);
	});
	const chunkSink = (chunk: string) => displayFilter.feed(chunk);
	const failRun = (err: unknown): string => {
		displayFilter.flush();
		const message = `[lunit] test run failed: ${String(err)}`;
		outputChannel.appendLine(message);
		run.appendOutput(message.replace(/\n/g, '\r\n'));
		onOutput?.(message + '\n');
		return message;
	};

	const identities = leaves.map(identityOf).filter((identity): identity is TestIdentity => identity !== undefined);

	if (via === 'lune') {
		// Lune runs as a pool of worker processes (luneRunner.ts). Items move
		// from queued to running to their verdict as each block starts and
		// finishes, including tests a dependency group pulls in as
		// prerequisites; whatever is left unresolved at the end (a cancelled
		// block, a test no block ever mentioned) is settled by the report.
		const progress = new LuneProgress(run, indexLeaves(controller), leaves);
		// A whole-tree run lets the planner run everything the profile allows;
		// any narrower request (a selection, or exclusions) names its tests.
		const selection = request.include || excluded.size > 0 ? identities : undefined;
		let outcome: LuneRunOutcome;
		try {
			outcome = await runViaLune(config, token, chunkSink, {
				slow: slowFilter,
				selection,
				workers: options.workers,
				hooks: {
					onPlan: (report) => progress.onPlan(report),
					onBlockStart: (block) => progress.onBlockStart(block),
					onBlockDone: (block, report) => progress.onBlockDone(block, report),
				},
			});
		} catch (err) {
			const message = failRun(err);
			const results = progress.finish(undefined, () => ({ status: 'errored', message }));
			endRun();
			return withSlowCount(buildSummary(via, [...results, ...leftOutResults], false));
		}
		displayFilter.flush();
		const report = outcome.report;
		const records = report ? [] : parseResultLines(outcome.output);
		const results = progress.finish(report, (identity) =>
			outcome.cancelled ? { status: 'skipped' } : resolveVerdict(identity, records, outcome),
		);
		endRun();
		const summary = withSlowCount(buildSummary(via, [...results, ...leftOutResults], outcome.cancelled));
		return report && report.blocks.length > 0 ? { ...summary, lune: summarizeReport(report) } : summary;
	}

	for (const leaf of leaves) {
		run.started(leaf);
	}

	// A whole-tree run lets the Studio side run everything its tag rule allows;
	// an explicit selection is narrowed to exactly the requested tests there.
	const selection = request.include ? buildTestSelection(identities) : undefined;

	let outcome: RunOutcome;
	try {
		outcome = await runViaStudio(config, token, chunkSink, liveSyncBridge, selection, slowFilter);
	} catch (err) {
		const message = failRun(err);
		const results = applyVerdicts(run, leaves, () => ({ status: 'errored', message }));
		endRun();
		return withSlowCount(buildSummary(via, [...results, ...leftOutResults], false));
	}
	displayFilter.flush();

	if (outcome.cancelled) {
		const results = applyVerdicts(run, leaves, () => ({ status: 'skipped' }));
		endRun();
		return withSlowCount(buildSummary(via, [...results, ...leftOutResults], true));
	}

	const records = parseResultLines(outcome.output);
	const results = applyVerdicts(run, leaves, (identity) => resolveVerdict(identity, records, outcome));
	endRun();
	return withSlowCount(buildSummary(via, [...results, ...leftOutResults], false));
}

function testKey(test: TestRef): string {
	return `${test.className}\u0000${test.methodName}`;
}

/** Every discovered test item, by class and method name, so a run can report on tests it pulled in beyond its request. */
function indexLeaves(controller: vscode.TestController): Map<string, vscode.TestItem[]> {
	const index = new Map<string, vscode.TestItem[]>();
	controller.items.forEach((root) => {
		const leaves: vscode.TestItem[] = [];
		collectLeaves(root, leaves);
		for (const leaf of leaves) {
			const identity = identityOf(leaf);
			if (!identity) {
				continue;
			}
			const key = testKey(identity);
			const list = index.get(key);
			if (list) {
				list.push(leaf);
			} else {
				index.set(key, [leaf]);
			}
		}
	});
	return index;
}

/**
 * Mirrors a parallel Lune run onto the TestRun as it happens. The primary
 * leaves are what the request asked for; a dependency group's prerequisite
 * modules add further leaves, which are queued and reported the same way.
 * Each leaf gets exactly one verdict: from the first block that settles it,
 * or from `finish` for anything still open when the run ends.
 */
class LuneProgress {
	private readonly queued = new Set<string>();
	private readonly started = new Set<string>();
	private readonly resolved = new Set<string>();
	private readonly extras: vscode.TestItem[] = [];
	private readonly results: TestResultEntry[] = [];

	constructor(
		private readonly run: vscode.TestRun,
		private readonly leafIndex: Map<string, vscode.TestItem[]>,
		private readonly primary: vscode.TestItem[],
	) {
		for (const leaf of primary) {
			this.queued.add(leaf.id);
		}
	}

	private leavesFor(test: TestRef): vscode.TestItem[] {
		return this.leafIndex.get(testKey(test)) ?? [];
	}

	onPlan(report: LuneRunReport): void {
		for (const block of report.blocks) {
			for (const test of block.tests) {
				for (const leaf of this.leavesFor(test)) {
					if (!this.queued.has(leaf.id)) {
						this.queued.add(leaf.id);
						this.extras.push(leaf);
						this.run.enqueued(leaf);
					}
				}
			}
		}
		for (const entry of report.unscheduled) {
			this.settle(entry.test, report);
		}
	}

	onBlockStart(block: BlockReport): void {
		for (const test of block.tests) {
			for (const leaf of this.leavesFor(test)) {
				if (this.queued.has(leaf.id) && !this.started.has(leaf.id) && !this.resolved.has(leaf.id)) {
					this.started.add(leaf.id);
					this.run.started(leaf);
				}
			}
		}
	}

	onBlockDone(block: BlockReport, report: LuneRunReport): void {
		for (const test of testsResolvedBy(report, block)) {
			this.settle(test, report);
		}
	}

	/** Settles every leaf still open and returns every verdict applied during the run. */
	finish(report: LuneRunReport | undefined, fallback: (identity: TestIdentity) => Verdict): TestResultEntry[] {
		for (const leaf of [...this.primary, ...this.extras]) {
			if (this.resolved.has(leaf.id)) {
				continue;
			}
			const known = identityOf(leaf);
			this.apply(leaf, known, known ? (report ? resolveBlockVerdict(known, report) : fallback(known)) : undefined);
		}
		return this.results;
	}

	private settle(test: TestRef, report: LuneRunReport): void {
		for (const leaf of this.leavesFor(test)) {
			if (!this.queued.has(leaf.id) || this.resolved.has(leaf.id)) {
				continue;
			}
			const known = identityOf(leaf);
			this.apply(leaf, known, known ? resolveBlockVerdict(known, report) : undefined);
		}
	}

	private apply(leaf: vscode.TestItem, known: TestIdentity | undefined, verdict: Verdict | undefined): void {
		this.resolved.add(leaf.id);
		this.results.push(applyVerdict(this.run, leaf, known, verdict));
	}
}

/**
 * Applies one verdict per leaf onto the VS Code TestRun and returns the same
 * verdicts as plain data for the run summary. A leaf whose metadata is
 * somehow missing (shouldn't happen -- every leaf comes from updateFile) is
 * reported as errored rather than silently dropped.
 */
function applyVerdicts(
	run: vscode.TestRun,
	leaves: vscode.TestItem[],
	verdictFor: (identity: TestIdentity) => Verdict,
): TestResultEntry[] {
	return leaves.map((leaf) => {
		const known = identityOf(leaf);
		return applyVerdict(run, leaf, known, known ? verdictFor(known) : undefined);
	});
}

/** Applies one leaf's verdict to the TestRun; no verdict means the leaf has no discovery metadata. */
function applyVerdict(
	run: vscode.TestRun,
	leaf: vscode.TestItem,
	known: TestIdentity | undefined,
	verdict: Verdict | undefined,
): TestResultEntry {
	const identity: TestIdentity = known ?? { file: leaf.uri?.fsPath ?? '', className: '', methodName: leaf.label };
	const applied: Verdict = verdict ?? { status: 'errored', message: 'Test item has no discovery metadata.' };
	switch (applied.status) {
		case 'passed':
			run.passed(leaf, applied.elapsedMs);
			break;
		case 'failed':
			run.failed(leaf, new vscode.TestMessage(applied.message ?? 'Test failed'), applied.elapsedMs);
			break;
		case 'skipped':
			run.skipped(leaf);
			break;
		case 'errored':
			run.errored(leaf, new vscode.TestMessage(applied.message ?? 'Test errored'));
			break;
	}
	return { ...identity, ...applied };
}
