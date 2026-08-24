import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LunitConfig } from './config';
import { buildLuneRunnerScript } from './luneScriptTemplate';
import { runCommand } from './processRunner';
import { describeToolFailure } from './toolDiagnostics';

export interface RunOutcome {
	code: number | null;
	output: string;
	timedOut: boolean;
	cancelled: boolean;
}

const GENERATED_SCRIPT_NAME = 'lune-runner.luau';
const LUNIT_PROMISE_RELATIVE = path.join('node_modules', '@rbxts', 'lunit', 'scripts', 'promise.luau');

/**
 * Lune's `require()` only accepts `./`, `../`, or `@`-prefixed paths -- never
 * absolute ones -- so the generated script's require of Lunit's `promise.luau`
 * has to stay relative. Returns undefined if no relative path exists at all
 * (Node's `path.relative` falls back to returning `to` unchanged when the two
 * paths are on different Windows drives), so the caller can fall back to
 * putting the generated script somewhere that *can* reach it relatively.
 */
function toLuneRequirePath(fromDir: string, toFileNoExt: string): string | undefined {
	const rel = path.relative(fromDir, toFileNoExt).split(path.sep).join('/');
	if (path.isAbsolute(rel)) {
		return undefined;
	}
	return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Compiles the project (unless skipped), regenerates our structured-output
 * Lune entry script, and runs it, streaming combined output via `onOutput`.
 */
export async function runViaLune(
	config: LunitConfig,
	token: vscode.CancellationToken,
	onOutput: (chunk: string) => void,
): Promise<RunOutcome> {
	const cwd = config.workspaceFolder.uri.fsPath;

	if (!config.skipCompile) {
		onOutput(`> ${config.compileCommand}\n`);
		const compileResult = await runCommand(config.compileCommand, { cwd, env: config.env, token, onOutput });
		if (compileResult.cancelled || compileResult.timedOut) {
			return compileResult;
		}
		if (compileResult.code !== 0) {
			const diagnosis = describeToolFailure(compileResult.output);
			onOutput(
				diagnosis
					? `\n${diagnosis}\n`
					: `\n[lunit] compile command exited with code ${compileResult.code}, aborting test run.\n`,
			);
			return compileResult;
		}
	}

	const promisePath = path.join(cwd, LUNIT_PROMISE_RELATIVE);
	if (!fs.existsSync(promisePath)) {
		const message = `[lunit] could not find ${LUNIT_PROMISE_RELATIVE} -- is @rbxts/lunit installed in this project?\n`;
		onOutput(message);
		return { code: null, output: message, timedOut: false, cancelled: false };
	}

	const promiseNoExt = promisePath.replace(/\.luau$/, '');
	let scriptDir = config.storageDir;
	let promiseRequirePath = toLuneRequirePath(scriptDir, promiseNoExt);
	if (promiseRequirePath === undefined) {
		// storageDir and the project are on different drives, so no relative
		// path between them exists -- fall back to generating inside the
		// workspace (the one case where that's unavoidable) rather than
		// producing a script that can never load Lunit.
		scriptDir = path.join(cwd, '.vscode', 'lunit');
		promiseRequirePath = toLuneRequirePath(scriptDir, promiseNoExt);
		onOutput(
			`[lunit] ${config.storageDir} is on a different drive than this project; generating the Lune script into ${scriptDir} instead.\n`,
		);
	}
	const scriptPath = path.join(scriptDir, GENERATED_SCRIPT_NAME);
	await fs.promises.mkdir(scriptDir, { recursive: true });
	await fs.promises.writeFile(scriptPath, buildLuneRunnerScript(promiseRequirePath!), 'utf8');

	// The generated script's own path-manipulation (Parent lookups, child
	// concatenation -- see luneScriptTemplate.ts / luauShimTemplate.ts) is all
	// forward-slash string logic, since that's what Lune's require() needs.
	// testsRoot/lunitRoot flow into that same logic via process.args, so they
	// need the same normalization -- `path.join`-built values contain
	// backslashes on Windows, which silently breaks any relative import
	// inside a test file (confirmed: a file with no relative imports of its
	// own loaded fine, one that imported a sibling module failed with
	// "attempt to index nil with 'Parent'").
	const testsRootArg = config.lune.testsRoot.split(path.sep).join('/');
	const lunitRootArg = config.lune.lunitRoot.split(path.sep).join('/');
	const command = `${config.lune.executable} run "${scriptPath}" "${testsRootArg}" "${lunitRootArg}"`;
	onOutput(`> ${command}\n`);
	const result = await runCommand(command, { cwd, env: config.env, token, onOutput });
	if (!result.cancelled && !result.timedOut && result.code !== 0) {
		const diagnosis = describeToolFailure(result.output);
		if (diagnosis) {
			onOutput(`\n${diagnosis}\n`);
		}
	}
	return result;
}
