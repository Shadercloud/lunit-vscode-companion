/**
 * Turns a handful of common "the CLI tool this command needs isn't
 * installed/configured" failures into a short, actionable message, instead
 * of leaving the user to interpret a raw tool error (e.g. Aftman's "Tried to
 * run an Aftman-managed version of X, but no aftman.toml files list this
 * tool" dump). Returns undefined when `output` doesn't match a known
 * pattern, so the caller falls back to just showing the raw output as-is.
 */

interface ToolHint {
	install: string;
}

const KNOWN_TOOL_HINTS: Record<string, ToolHint> = {
	lune: {
		install:
			'Install it with Rokit (`rokit add lune-org/lune`) or Aftman (`aftman add lune-org/lune`), or download a release from https://github.com/lune-org/lune/releases.',
	},
	rojo: {
		install:
			'Install it with Rokit (`rokit add rojo-rbx/rojo`) or Aftman (`aftman add rojo-rbx/rojo`), or download a release from https://github.com/rojo-rbx/rojo/releases.',
	},
};

function hintFor(tool: string): string {
	const known = KNOWN_TOOL_HINTS[tool.toLowerCase()];
	if (known) {
		return known.install;
	}
	return `Add it to this project with \`aftman add <author>/${tool}\` (or Rokit's \`rokit add <author>/${tool}\`), or make sure it's on your PATH.`;
}

export function describeToolFailure(output: string): string | undefined {
	const aftmanNotListed = output.match(
		/Aftman error: Tried to run an Aftman-managed version of (\S+), but no aftman\.toml files list this tool\./,
	);
	if (aftmanNotListed) {
		const tool = aftmanNotListed[1];
		return `[lunit] "${tool}" isn't set up for this project yet (Aftman found no aftman.toml listing it). ${hintFor(tool)}`;
	}

	const windowsNotRecognized = output.match(/'([^']+)' is not recognized as an internal or external command/);
	if (windowsNotRecognized) {
		const tool = windowsNotRecognized[1].split(/[\\/]/).pop() ?? windowsNotRecognized[1];
		return `[lunit] "${tool}" isn't installed, or isn't on your PATH. ${hintFor(tool)}`;
	}

	const posixNotFound = output.match(/(\S+): command not found/);
	if (posixNotFound) {
		const tool = posixNotFound[1];
		return `[lunit] "${tool}" isn't installed, or isn't on your PATH. ${hintFor(tool)}`;
	}

	return undefined;
}
