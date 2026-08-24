import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { installAgentInstructions } from './agentInstructions';
import { getConfig, LunitConfig } from './config';
import { DiscoveredClass, parseTestFile } from './discovery';
import { LiveSyncBridge } from './liveSyncBridge';
import { RunOutcome, runViaLune } from './luneRunner';
import { aggregateForLabel, createResultLineFilter, parseResultLines, ResultRecord } from './resultProtocol';
import { isRojoServeRunning } from './rojoDetect';
import {
	installStudioPlugin,
	isStudioPluginInstalled,
	regenerateStudioFiles,
	runViaStudio,
} from './studioRunner';

interface TestMeta {
	kind: 'file' | 'class' | 'test';
	uri: vscode.Uri;
	className?: string;
	methodName?: string;
	displayName?: string;
}

let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext;
let liveSyncBridge: LiveSyncBridge | undefined;
const metaById = new Map<string, TestMeta>();

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
 */
const LUNE_TAG = new vscode.TestTag('lunit.lune');
const STUDIO_TAG = new vscode.TestTag('lunit.studio');

function computeRunTags(effectiveTags: readonly string[]): vscode.TestTag[] {
	const lower = effectiveTags.map((t) => t.toLowerCase());
	const tags: vscode.TestTag[] = [];
	if (!lower.includes('studio')) {
		tags.push(LUNE_TAG);
	}
	if (!lower.includes('lune')) {
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
		`Lunit: installed the Roblox Studio live-sync plugin to ${result.installedPath}. Restart Studio (or reopen it) to load it -- once loaded, it polls automatically, no further setup needed.`,
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
	// studioRunner.ts's runViaStudio for why that matters. The port is a
	// per-workspace-folder setting in principle, but the bridge itself is one
	// process-wide server; the first folder's value (or the default) is used
	// for the whole session, matching the fact that the companion Studio
	// plugin's URL is baked in at install time regardless.
	const liveSyncPort =
		vscode.workspace.workspaceFolders?.[0] &&
		getConfig(vscode.workspace.workspaceFolders[0], getStorageDir(vscode.workspace.workspaceFolders[0])).studio
			.liveSync.port;
	liveSyncBridge = new LiveSyncBridge(liveSyncPort ?? 34873, (err) =>
		outputChannel.appendLine(`[lunit] live-sync bridge error: ${err.message}`),
	);
	liveSyncBridge.start();
	context.subscriptions.push({ dispose: () => liveSyncBridge?.stop() });

	const statusBarItem = vscode.window.createStatusBarItem('lunit.liveSyncStatus', vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'lunit.showLiveSyncStatus';
	context.subscriptions.push(statusBarItem);
	// Refreshed on the same tick this depends on: pluginConnected, rojoDetected.
	// Three real states, not two -- a connected plugin with no rojo serve
	// running is its own warning (see showLiveSyncStatus), not the same as
	// "fully working".
	const refreshStatusBar = async () => {
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
				'No Roblox Studio instance is currently connected for live-sync. "Run in Roblox Studio" will build a place and launch a new Studio process instead. Click for details.';
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

	// Only one of these two profiles should ever be "default" at a time --
	// VS Code's own "Select Default Profile" picker lets you check both
	// simultaneously (it's built for kinds where running several defaults
	// together makes sense), so each profile's onDidChangeDefault listener
	// below un-defaults the other one to force a single-select choice
	// instead. Explicitly running a profile from the Run dropdown also marks
	// it default (and the other not) -- harmless if it already was.
	let studioProfile: vscode.TestRunProfile | undefined;

	const luneProfile = controller.createRunProfile(
		'Run with Lune',
		vscode.TestRunProfileKind.Run,
		(request, token) => {
			luneProfile.isDefault = true;
			if (studioProfile) {
				studioProfile.isDefault = false;
			}
			return executeRun(controller, request, token, 'lune');
		},
		true,
		LUNE_TAG,
	);
	context.subscriptions.push(luneProfile);
	context.subscriptions.push(
		luneProfile.onDidChangeDefault((isDefault) => {
			if (isDefault && studioProfile) {
				studioProfile.isDefault = false;
			}
		}),
	);

	let studioDefaultListener: vscode.Disposable | undefined;
	const registerStudioProfile = () => {
		const folder = vscode.workspace.workspaceFolders?.[0];
		const enabled = folder ? getConfig(folder, getStorageDir(folder)).studio.enabled : true;
		if (enabled && !studioProfile) {
			const profile = controller.createRunProfile(
				'Run in Roblox Studio',
				vscode.TestRunProfileKind.Run,
				(request, token) => {
					profile.isDefault = true;
					luneProfile.isDefault = false;
					return executeRun(controller, request, token, 'studio');
				},
				false,
				STUDIO_TAG,
			);
			studioProfile = profile;
			context.subscriptions.push(profile);
			studioDefaultListener = profile.onDidChangeDefault((isDefault) => {
				if (isDefault) {
					luneProfile.isDefault = false;
				}
			});
			context.subscriptions.push(studioDefaultListener);
		} else if (!enabled && studioProfile) {
			studioDefaultListener?.dispose();
			studioDefaultListener = undefined;
			studioProfile.dispose();
			studioProfile = undefined;
		}
	};
	registerStudioProfile();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('lunit.studio.enabled')) {
				registerStudioProfile();
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
		vscode.commands.registerCommand('lunit.installAgentInstructions', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				vscode.window.showErrorMessage('Lunit: open a workspace folder first.');
				return;
			}
			const config = getConfig(folder, getStorageDir(folder));
			const { filePath, updated } = installAgentInstructions(config);
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
			vscode.window.showInformationMessage(
				`Lunit: ${updated ? 'updated the Lunit section in' : 'created'} ${path.basename(filePath)} with instructions for coding agents on writing @rbxts/lunit tests for this project.`,
			);
		}),
		vscode.commands.registerCommand('lunit.showLiveSyncStatus', async () => {
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
				? 'Lunit: the live-sync plugin is installed but no Roblox Studio instance is currently polling (Studio may not be open, or the plugin\'s toggle may be paused). "Run in Roblox Studio" will build a place and launch a new Studio process instead.'
				: 'Lunit: the Roblox Studio live-sync plugin isn\'t installed yet. Without it, "Run in Roblox Studio" builds a place and launches a new Studio process every run instead of using one you already have open.';
			const action = installed ? undefined : 'Install Plugin';
			const choice = await vscode.window.showWarningMessage(message, ...(action ? [action] : []));
			if (choice === action) {
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
		watcher.onDidDelete((uri) => {
			metaById.delete(uri.toString());
			controller.items.delete(uri.toString());
		});
		context.subscriptions.push(watcher);
	}

	discoverAll(controller).then(() => {
		// Gated on having actually found Lunit tests -- this extension
		// activates on every VS Code window (onStartupFinished), so without
		// this check the prompt would show up in unrelated, non-Roblox
		// projects too.
		if (controller.items.size > 0) {
			void maybePromptPluginInstall(context);
		}
	});
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
		controller.items.delete(fileId);
		metaById.delete(fileId);
		return;
	}

	const fileItem = controller.createTestItem(fileId, workspaceRelativeLabel(uri), uri);
	metaById.set(fileId, { kind: 'file', uri });

	const classItems = classes.map((cls) => {
		const classId = `${fileId}::${cls.className}`;
		const classItem = controller.createTestItem(classId, cls.displayName ?? cls.className, uri);
		classItem.range = new vscode.Range(cls.line, 0, cls.line, 0);
		metaById.set(classId, { kind: 'class', uri, className: cls.className });

		const testItems = cls.tests.map((test) => {
			const testId = `${classId}::${test.methodName}`;
			const label = test.displayName ?? test.methodName;
			const testItem = controller.createTestItem(testId, label, uri);
			testItem.range = new vscode.Range(test.line, 0, test.line, 0);
			const runTags = computeRunTags([...cls.tags, ...test.tags]);
			testItem.tags = test.hasSkip ? [...runTags, new vscode.TestTag('skip')] : runTags;
			metaById.set(testId, {
				kind: 'test',
				uri,
				className: cls.className,
				methodName: test.methodName,
				displayName: test.displayName,
			});
			return testItem;
		});
		classItem.children.replace(testItems);
		classItem.tags = unionTags(testItems.map((t) => t.tags));
		return classItem;
	});
	fileItem.children.replace(classItems);
	fileItem.tags = unionTags(classItems.map((c) => c.tags));

	controller.items.add(fileItem);
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

async function executeRun(
	controller: vscode.TestController,
	request: vscode.TestRunRequest,
	token: vscode.CancellationToken,
	via: 'lune' | 'studio',
): Promise<void> {
	const run = controller.createTestRun(request);
	const excluded = new Set((request.exclude ?? []).map((i) => i.id));

	const roots: vscode.TestItem[] = [];
	if (request.include) {
		roots.push(...request.include);
	} else {
		controller.items.forEach((item) => roots.push(item));
	}

	// request.include is undefined for a whole-tree run ("run all tests" --
	// see TestRunRequest's doc comment), which VS Code does NOT pre-filter by
	// profile tag -- that's on the extension. So even for an explicit
	// selection (where VS Code's own UI already limits what's offered),
	// re-checking the tag here is what actually keeps a @Tag("Studio") test
	// out of a Lune run rather than just out of its dropdown.
	const requiredTag = via === 'lune' ? LUNE_TAG : STUDIO_TAG;
	const leaves: vscode.TestItem[] = [];
	for (const root of roots) {
		const candidates: vscode.TestItem[] = [];
		collectLeaves(root, candidates);
		for (const candidate of candidates) {
			if (!excluded.has(candidate.id) && candidate.tags.some((t) => t.id === requiredTag.id)) {
				leaves.push(candidate);
			}
		}
	}

	if (leaves.length === 0) {
		run.end();
		return;
	}

	const folder =
		vscode.workspace.getWorkspaceFolder(leaves[0].uri!) ?? vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showErrorMessage('Lunit: no workspace folder available to run tests in.');
		run.end();
		return;
	}
	const config = getConfig(folder, getStorageDir(folder));

	for (const leaf of leaves) {
		run.enqueued(leaf);
	}
	for (const leaf of leaves) {
		run.started(leaf);
	}

	const displayFilter = createResultLineFilter((text) => {
		outputChannel.append(text);
		run.appendOutput(text.replace(/\r?\n/g, '\r\n'));
	});
	const onOutput = (chunk: string) => displayFilter.feed(chunk);

	let outcome: RunOutcome;
	try {
		outcome =
			via === 'lune'
				? await runViaLune(config, token, onOutput)
				: await runViaStudio(config, token, onOutput, liveSyncBridge);
	} catch (err) {
		displayFilter.flush();
		const message = `[lunit] test run failed: ${String(err)}`;
		outputChannel.appendLine(message);
		run.appendOutput(message.replace(/\n/g, '\r\n'));
		for (const leaf of leaves) {
			run.errored(leaf, new vscode.TestMessage(message));
		}
		run.end();
		return;
	}
	displayFilter.flush();

	if (outcome.cancelled) {
		for (const leaf of leaves) {
			run.skipped(leaf);
		}
		run.end();
		return;
	}

	const records = parseResultLines(outcome.output);
	applyResults(run, leaves, records, outcome);
	run.end();
}

function applyResults(
	run: vscode.TestRun,
	leaves: vscode.TestItem[],
	records: ResultRecord[],
	outcome: RunOutcome,
): void {
	for (const leaf of leaves) {
		const meta = metaById.get(leaf.id);
		const baseLabel = meta?.displayName ?? meta?.methodName;
		const match = meta?.className && baseLabel ? aggregateForLabel(records, meta.className, baseLabel) : undefined;

		if (match) {
			if (match.status === 'passed') {
				run.passed(leaf, match.elapsedMs);
			} else if (match.status === 'failed') {
				run.failed(leaf, new vscode.TestMessage(match.message ?? 'Test failed'), match.elapsedMs);
			} else {
				run.skipped(leaf);
			}
			continue;
		}

		if (outcome.timedOut) {
			run.errored(leaf, new vscode.TestMessage('Run timed out before this test reported a result.'));
		} else if (outcome.code !== 0 && records.length === 0) {
			run.errored(
				leaf,
				new vscode.TestMessage(
					'No structured results were found in the run output. Check the Lunit output channel for compile/runtime errors.',
				),
			);
		} else {
			run.errored(
				leaf,
				new vscode.TestMessage(
					'No matching result found in test output for this item. It may not have run (check that its container/tags are discovered by your bootstrap script), or its class name at runtime does not match what was expected.',
				),
			);
		}
	}
}
