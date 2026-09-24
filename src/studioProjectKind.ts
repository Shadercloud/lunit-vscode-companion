import * as fs from 'fs';
import * as path from 'path';
import { detectOutputKind, findRojoProjectFiles, pickRojoProjectFile } from './luneProjectKind';

/**
 * Decides which Rojo project the "Run in Roblox Studio" profile's standalone
 * mode builds its throwaway place from.
 *
 * roblox-ts emits two kinds of output, and only one of them can be relocated.
 * A `--type package` project is `script`-relative throughout, so its compiled
 * output can be mounted anywhere -- which is what the self-contained project
 * in studioProjectTemplate.ts relies on (the package goes under
 * `rbxts_include.node_modules[scope][name]`, as if it were a dependency). A
 * `--type game` project is compiled *for* the Rojo tree named by `rbxtsc
 * --rojo <file>`: an import from `tests/common/client` into
 * `src/common/client` becomes `TS.import(script, script.Parent.Parent.Parent,
 * "Common", ...)`, which only resolves when the compiled test sits beside the
 * source folder exactly where that project file puts it. Moving it under an
 * invented package layout leaves every such import waiting forever on a
 * sibling that isn't there ("Infinite yield possible on ...:WaitForChild(
 * "Common")"). So a game project's place has to be built from the project's
 * own Rojo file, and the only thing the extension adds is the bootstrap
 * script it passes to Studio separately (`--runScriptFile`).
 *
 * Resolution order:
 *   1. `lunit.studio.rojoProject`, when set.
 *   2. The file named by the compile command's `--rojo` flag, following
 *      `npm run <script>` (and friends) into package.json scripts.
 *   3. A package.json whose `main`/`types` point into the output directory
 *      (and no `--rojo` flag): a real rbxts package, package layout.
 *   4. What the compiled output says (luneProjectKind.ts): `_G[script]` means
 *      package; DataModel-resolved imports mean game, using
 *      `lunit.lune.projectFile` or the one Rojo project at the root.
 *   5. Nothing compiled to judge by: `default.project.json` if there is one,
 *      else the package layout, which is what earlier versions always used.
 */

export type StudioProjectKind = 'package' | 'game';

export interface StudioProjectDetection {
	kind: StudioProjectKind;
	/** Absolute path of the Rojo project to build the place from; game only. */
	projectFile?: string;
	/** One line, shown in the run output, saying what was decided and why. */
	reason: string;
	/**
	 * Set when the project looks like a game but no Rojo project could be
	 * picked: the run cannot work, and the message says what to do instead.
	 */
	blocked?: string;
}

const MAX_SCRIPT_DEPTH = 4;

/** Splits a shell command line into words, honouring single and double quotes. */
function tokenize(command: string): string[] {
	const words: string[] = [];
	let current = '';
	let quote: string | undefined;
	let inWord = false;
	for (const ch of command) {
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				current += ch;
			}
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			inWord = true;
		} else if (/\s/.test(ch)) {
			if (inWord) {
				words.push(current);
				current = '';
				inWord = false;
			}
		} else {
			current += ch;
			inWord = true;
		}
	}
	if (inWord) {
		words.push(current);
	}
	return words;
}

function readPackageScripts(workspaceRoot: string): Record<string, string> {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8')) as {
			scripts?: Record<string, unknown>;
		};
		const scripts: Record<string, string> = {};
		for (const [name, value] of Object.entries(pkg.scripts ?? {})) {
			if (typeof value === 'string') {
				scripts[name] = value;
			}
		}
		return scripts;
	} catch {
		return {};
	}
}

/**
 * Every distinct `--rojo <file>` value the compile command reaches, as
 * written. A command like `npm run build:dev` is followed into package.json's
 * scripts (as are `npm run-script`, `yarn [run]`, `pnpm run`, and
 * concurrently's `npm:name` shorthand, each up to a few levels deep), since
 * that's where the flag usually lives in a real project.
 */
export function findRojoFlags(command: string, workspaceRoot: string): string[] {
	const found: string[] = [];
	const visitedScripts = new Set<string>();
	let scripts: Record<string, string> | undefined;

	const visit = (text: string, depth: number): void => {
		const words = tokenize(text);
		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			if (word === '--rojo' && i + 1 < words.length) {
				found.push(words[i + 1]);
				i += 1;
				continue;
			}
			if (word.startsWith('--rojo=')) {
				found.push(word.slice('--rojo='.length));
				continue;
			}
			let scriptName: string | undefined;
			if (word.startsWith('npm:')) {
				scriptName = word.slice('npm:'.length);
			} else if ((word === 'npm' || word === 'pnpm' || word === 'yarn') && i + 1 < words.length) {
				const next = words[i + 1];
				if (next === 'run' || next === 'run-script') {
					scriptName = words[i + 2];
				} else if (word === 'yarn' && !next.startsWith('-')) {
					scriptName = next;
				}
			}
			if (scriptName && depth < MAX_SCRIPT_DEPTH && !visitedScripts.has(scriptName)) {
				scripts ??= readPackageScripts(workspaceRoot);
				const script = scripts[scriptName];
				if (script !== undefined) {
					visitedScripts.add(scriptName);
					visit(script, depth + 1);
				}
			}
		}
	};

	visit(command, 0);
	return [...new Set(found)];
}

/**
 * Whether package.json presents this project as a published roblox-ts
 * package: its `main` or `types` entry points into the compiled output
 * directory (`"main": "out/init.lua"`, `"types": "out/index.d.ts"`).
 */
export function packageJsonPointsIntoOutDir(workspaceRoot: string, outDirName: string): boolean {
	let pkg: { main?: unknown; types?: unknown; typings?: unknown };
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
	} catch {
		return false;
	}
	const prefix = outDirName.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
	return [pkg.main, pkg.types, pkg.typings].some((entry) => {
		if (typeof entry !== 'string') {
			return false;
		}
		const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
		return normalized.startsWith(prefix);
	});
}

function resolveProject(workspaceRoot: string, file: string): string {
	return path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
}

/** How to get a game project's tests running when the place cannot be built here. */
export function describeStudioProjectRemedy(): string {
	return (
		'Either connect Rojo -- open the project in Roblox Studio with "rojo serve" running and the Lunit Studio ' +
		'plugin installed, and the tests run there directly -- or set "lunit.studio.rojoProject" to the *.project.json ' +
		'(the one your rbxtsc --rojo flag names) to build the test place from.'
	);
}

export function detectStudioProject(options: {
	workspaceRoot: string;
	outDir: string;
	compileCommand: string;
	/** `lunit.studio.rojoProject`, possibly empty. */
	configuredProjectFile: string;
	/** `lunit.lune.projectFile`, possibly empty; a reasonable second opinion for the same tree. */
	luneProjectFile?: string;
}): StudioProjectDetection {
	const { workspaceRoot, outDir, compileCommand, configuredProjectFile } = options;
	const outDirName = path.basename(outDir);

	const game = (projectFile: string, reason: string, setting: string): StudioProjectDetection => {
		if (!fs.existsSync(projectFile)) {
			return {
				kind: 'game',
				reason,
				blocked: `[lunit] ${setting} points at ${projectFile}, which does not exist. ${describeStudioProjectRemedy()}`,
			};
		}
		return { kind: 'game', projectFile, reason };
	};

	if (configuredProjectFile.trim().length > 0) {
		return game(
			resolveProject(workspaceRoot, configuredProjectFile.trim()),
			'building the Studio place from the Rojo project set in lunit.studio.rojoProject',
			'lunit.studio.rojoProject',
		);
	}

	const rojoFlags = findRojoFlags(compileCommand, workspaceRoot);
	if (rojoFlags.length === 1) {
		return game(
			resolveProject(workspaceRoot, rojoFlags[0]),
			`roblox-ts game project (the compile command passes --rojo ${rojoFlags[0]}); building the Studio place from that Rojo project`,
			`the compile command's --rojo flag`,
		);
	}
	if (rojoFlags.length > 1) {
		return {
			kind: 'game',
			reason: 'roblox-ts game project (the compile command passes --rojo more than once)',
			blocked:
				`[lunit] the compile command reaches several rbxtsc --rojo flags (${rojoFlags.join(', ')}), so it is not clear ` +
				`which Rojo project describes your tests. ${describeStudioProjectRemedy()}`,
		};
	}

	if (packageJsonPointsIntoOutDir(workspaceRoot, outDirName)) {
		return {
			kind: 'package',
			reason: `roblox-ts package (package.json's entry point is under ${outDirName}/); building the self-contained test place`,
		};
	}

	const outputKind = detectOutputKind(outDir);
	if (outputKind === 'package') {
		return {
			kind: 'package',
			reason: 'roblox-ts package (compiled output is script-relative); building the self-contained test place',
		};
	}

	if (outputKind === 'game') {
		const luneProjectFile = options.luneProjectFile?.trim();
		if (luneProjectFile) {
			return game(
				resolveProject(workspaceRoot, luneProjectFile),
				'roblox-ts game project; building the Studio place from the Rojo project set in lunit.lune.projectFile',
				'lunit.lune.projectFile',
			);
		}
		const picked = pickRojoProjectFile(workspaceRoot, outDirName);
		if (picked) {
			return {
				kind: 'game',
				projectFile: picked,
				reason: `roblox-ts game project (compiled output resolves imports through the DataModel); building the Studio place from ${path.basename(picked)}`,
			};
		}
		const candidates = findRojoProjectFiles(workspaceRoot);
		const problem =
			candidates.length === 0
				? 'no Rojo project file was found at the workspace root'
				: `several Rojo project files could describe it (${candidates.map((file) => path.basename(file)).join(', ')})`;
		return {
			kind: 'game',
			reason: 'roblox-ts game project (compiled output resolves imports through the DataModel)',
			blocked:
				`[lunit] this is a roblox-ts game project, whose compiled tests only resolve their imports in the Rojo tree ` +
				`they were compiled for, but ${problem}, so there is nothing to build the test place from. ${describeStudioProjectRemedy()}`,
		};
	}

	const defaultProject = path.join(workspaceRoot, 'default.project.json');
	if (fs.existsSync(defaultProject)) {
		return {
			kind: 'game',
			projectFile: defaultProject,
			reason: 'no compiled output to judge the project type by; building the Studio place from default.project.json',
		};
	}
	return {
		kind: 'package',
		reason: 'no compiled output or Rojo project to judge the project type by; building the self-contained test place',
	};
}
