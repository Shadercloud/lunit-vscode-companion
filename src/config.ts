import * as path from 'path';
import * as vscode from 'vscode';

export function getWorkspaceFolder(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
	if (uri) {
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (folder) {
			return folder;
		}
	}
	return vscode.workspace.workspaceFolders?.[0];
}

function resolveTokens(input: string, tokens: Record<string, string>): string {
	let result = input;
	for (const [key, value] of Object.entries(tokens)) {
		result = result.split(`\${${key}}`).join(value);
	}
	return result;
}

export interface LunitConfig {
	workspaceFolder: vscode.WorkspaceFolder;
	/**
	 * Absolute directory, outside the workspace, where this extension writes
	 * everything it generates (compiled Lune runner scripts, the Studio test
	 * Rojo project, the Studio bootstrap script, the built place file, Studio's
	 * output log) -- nothing should end up sitting in the user's project. Comes
	 * from VS Code's own per-workspace extension storage
	 * (`ExtensionContext.storageUri`), namespaced by workspace folder name.
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
	};
	studio: {
		enabled: boolean;
		executablePath: string;
		buildPlaceCommand: string;
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

export function getConfig(folder: vscode.WorkspaceFolder, storageDir: string): LunitConfig {
	const cfg = vscode.workspace.getConfiguration('lunit', folder.uri);
	const root = folder.uri.fsPath;
	const outDirName = cfg.get<string>('outDir', 'out');
	const outDir = path.join(root, outDirName);

	const baseTokens = {
		workspaceFolder: root,
		storageDir,
		outDir,
	};

	const projectFile = resolveTokens(
		cfg.get<string>('studio.projectFile', '${storageDir}/studio-test.project.json'),
		baseTokens,
	);
	const placeFile = resolveTokens(cfg.get<string>('studio.placeFile', '${storageDir}/test-place.rbxl'), baseTokens);

	const studioTokens = { ...baseTokens, projectFile, placeFile };

	return {
		workspaceFolder: folder,
		storageDir,
		testGlob: cfg.get<string>('testGlob', '**/*.{test,spec}.{ts,tsx}'),
		excludeGlob: cfg.get<string>('excludeGlob', '**/node_modules/**'),
		skipCompile: cfg.get<boolean>('skipCompile', false),
		compileCommand: resolveTokens(cfg.get<string>('compileCommand', 'npx rbxtsc'), baseTokens),
		outDir,
		env: cfg.get<Record<string, string>>('env', {}),
		lune: {
			executable: cfg.get<string>('lune.executable', 'lune'),
			testsRoot: resolveTokens(cfg.get<string>('testsRoot', '${workspaceFolder}'), baseTokens),
			lunitRoot: resolveTokens(
				cfg.get<string>('lunitRoot', '${workspaceFolder}/node_modules/@rbxts/lunit/out'),
				baseTokens,
			),
		},
		studio: {
			enabled: cfg.get<boolean>('studio.enabled', true),
			executablePath: cfg.get<string>('studio.executablePath', ''),
			buildPlaceCommand: resolveTokens(
				cfg.get<string>('studio.buildPlaceCommand', 'npx rojo build "${projectFile}" --output "${placeFile}"'),
				studioTokens,
			),
			projectFile,
			placeFile,
			bootstrapScript: resolveTokens(
				cfg.get<string>('studio.bootstrapScript', '${storageDir}/studio-bootstrap.luau'),
				studioTokens,
			),
			outputFile: resolveTokens(cfg.get<string>('studio.outputFile', '${storageDir}/studio-output.log'), studioTokens),
			quitAfterExecution: cfg.get<boolean>('studio.quitAfterExecution', true),
			timeoutSeconds: cfg.get<number>('studio.timeoutSeconds', 180),
			liveSync: {
				enabled: cfg.get<boolean>('studio.liveSync.enabled', true),
				port: cfg.get<number>('studio.liveSync.port', 34873),
				timeoutSeconds: cfg.get<number>('studio.liveSync.timeoutSeconds', 30),
				syncDelaySeconds: cfg.get<number>('studio.liveSync.syncDelaySeconds', 1),
			},
		},
	};
}
