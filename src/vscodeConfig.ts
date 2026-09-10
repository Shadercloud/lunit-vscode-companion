import * as vscode from 'vscode';
import { buildConfig, LunitConfig } from './config';

/** Reads this folder's effective `lunit.*` settings into the shared, vscode-free LunitConfig shape. */
export function getConfig(folder: vscode.WorkspaceFolder, storageDir: string): LunitConfig {
	const cfg = vscode.workspace.getConfiguration('lunit', folder.uri);
	return buildConfig(folder.uri.fsPath, storageDir, (key, fallback) => cfg.get(key, fallback));
}
