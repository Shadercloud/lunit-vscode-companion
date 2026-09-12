import * as fs from 'fs';
import * as path from 'path';

/**
 * Tells the two roblox-ts project types apart for the "Run with Lune" profile.
 *
 * They need different runners because roblox-ts emits different code for each.
 * A `--type package` project can't know where it will be installed, so every
 * import it emits is `script`-relative and its modules open with `_G[script]`;
 * the filesystem shim in luauShimTemplate.ts handles that. A `--type game`
 * project resolves imports through absolute DataModel paths instead, opening
 * with `game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include")`,
 * which needs a DataModel built from the project's Rojo file
 * (rojoDataModelTemplate.ts).
 *
 * Detection reads the compiled output rather than asking the user, since the
 * evidence is unambiguous and right there. `lunit.lune.projectFile` overrides
 * it for projects the heuristics can't place -- notably a repo with several
 * Rojo projects, where only the author knows which one describes the tests.
 */

export type LuneProjectKind = 'package' | 'game';

export interface LuneProjectDetection {
	kind: LuneProjectKind;
	/** Absolute path of the Rojo project describing the DataModel; game only. */
	projectFile?: string;
	/** One line, shown in the run output, saying what was detected and why. */
	reason: string;
	/**
	 * Set when the output looks like a game project but no Rojo project could
	 * be picked: the run cannot work, and the message says what to set.
	 */
	blocked?: string;
}

const MAX_FILES_INSPECTED = 400;
const HEAD_BYTES = 4096;

/** Rojo project files at the project root, `default.project.json` first. */
export function findRojoProjectFiles(root: string): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return [];
	}
	const found = entries.filter((name) => name.endsWith('.project.json')).sort();
	const preferred = found.filter((name) => name === 'default.project.json');
	const rest = found.filter((name) => name !== 'default.project.json');
	return [...preferred, ...rest].map((name) => path.join(root, name));
}

function readHead(file: string): string {
	let handle: number | undefined;
	try {
		handle = fs.openSync(file, 'r');
		const buffer = Buffer.alloc(HEAD_BYTES);
		const read = fs.readSync(handle, buffer, 0, HEAD_BYTES, 0);
		return buffer.subarray(0, read).toString('utf8');
	} catch {
		return '';
	} finally {
		if (handle !== undefined) {
			try {
				fs.closeSync(handle);
			} catch {
				/* nothing useful to do */
			}
		}
	}
}

/**
 * Walks compiled output looking for the tell-tale opening lines. Returns the
 * kind the output is written in, or undefined when there's no compiled Luau
 * to judge by (nothing built yet, most likely).
 *
 * Package evidence is decisive, and the whole scan finishes before deciding:
 * `_G[script]` appears only in `--type package` output, whereas a package is
 * perfectly entitled to call `game:GetService` in a module of its own. Losing
 * that race would route a project that works today down the game path and
 * stop its run, so the ambiguous case has to resolve to `package`.
 */
export function detectOutputKind(outDir: string): LuneProjectKind | undefined {
	let inspected = 0;
	let sawPackage = false;
	let sawGame = false;

	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (inspected >= MAX_FILES_INSPECTED || sawPackage) {
				return;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				// node_modules holds compiled *packages* even inside a game
				// project, so judging by them would always say "package".
				if (entry.name === 'node_modules' || entry.name === 'rbxts_include' || entry.name === '.git') {
					continue;
				}
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.luau') && !entry.name.endsWith('.lua')) {
				continue;
			}
			inspected += 1;
			const head = readHead(full);
			if (head.includes('_G[script]')) {
				sawPackage = true;
				return;
			}
			if (head.includes('game:GetService(')) {
				sawGame = true;
			}
		}
	};

	walk(outDir);
	if (sawPackage) {
		return 'package';
	}
	return sawGame ? 'game' : undefined;
}

/**
 * Picks the Rojo project describing the DataModel. With several at the root
 * only the author knows which one builds the tests, so prefer the one that
 * actually references the configured output directory and otherwise decline
 * to guess.
 */
function pickProjectFile(root: string, outDirName: string): string | undefined {
	const candidates = findRojoProjectFiles(root);
	if (candidates.length <= 1) {
		return candidates[0];
	}
	if (path.basename(candidates[0]) === 'default.project.json') {
		return candidates[0];
	}
	const referencing = candidates.filter((file) => readHead(file).includes(`"${outDirName}`));
	return referencing.length === 1 ? referencing[0] : undefined;
}

export function detectLuneProject(options: {
	workspaceRoot: string;
	outDir: string;
	configuredProjectFile: string;
}): LuneProjectDetection {
	const { workspaceRoot, outDir, configuredProjectFile } = options;

	if (configuredProjectFile) {
		const resolved = path.isAbsolute(configuredProjectFile)
			? configuredProjectFile
			: path.join(workspaceRoot, configuredProjectFile);
		if (!fs.existsSync(resolved)) {
			return {
				kind: 'game',
				reason: 'lunit.lune.projectFile is set',
				blocked: `[lunit] lunit.lune.projectFile points at ${resolved}, which does not exist.`,
			};
		}
		return { kind: 'game', projectFile: resolved, reason: `using the Rojo project set in lunit.lune.projectFile` };
	}

	const outputKind = detectOutputKind(outDir);
	if (outputKind !== 'game') {
		// Unbuilt or package-shaped output both keep the long-standing
		// filesystem path, which is the common case and already correct.
		return {
			kind: 'package',
			reason:
				outputKind === 'package'
					? 'compiled output is script-relative (roblox-ts package project)'
					: 'no compiled game-project output found',
		};
	}

	const outDirName = path.basename(outDir);
	const projectFile = pickProjectFile(workspaceRoot, outDirName);
	if (projectFile === undefined) {
		const candidates = findRojoProjectFiles(workspaceRoot);
		return {
			kind: 'game',
			reason: 'compiled output resolves imports through the DataModel (roblox-ts game project)',
			blocked:
				candidates.length === 0
					? '[lunit] this looks like a roblox-ts game project, but no Rojo project file was found at the workspace root. Set "lunit.lune.projectFile" to the project that describes your tests.'
					: `[lunit] this looks like a roblox-ts game project, but several Rojo project files could describe it (${candidates
							.map((file) => path.basename(file))
							.join(', ')}). Set "lunit.lune.projectFile" to the one that describes your tests.`,
		};
	}

	return {
		kind: 'game',
		projectFile,
		reason: `compiled output resolves imports through the DataModel; using ${path.basename(projectFile)}`,
	};
}
