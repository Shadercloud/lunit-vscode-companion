/**
 * Command-line entry point -- the route coding agents (or anyone in a
 * terminal) use to run this project's Lunit tests, since nothing outside VS
 * Code can press the Test Explorer's own Run button.
 *
 *   node <launcher> [--studio | --lune [--full]] [--json] [--port N] [--workspace DIR]
 *                   [--standalone] [filter ...]
 *
 * Two ways it can execute, tried in order:
 *
 * 1. Through the running VS Code extension. Discovery finds the window whose
 *    workspace contains the current directory. The run is posted to that
 *    window (`POST /run`, see liveSyncBridge.ts)
 *    and executed by extension.ts's `executeRun` -- the exact same function a
 *    Test Explorer click invokes -- with output streamed back live. The run
 *    also appears in the Testing view. This is the normal case for an agent
 *    working inside VS Code's integrated terminal. Each window owns a
 *    different port in the configured discovery range.
 *
 * 2. Standalone, when nothing is listening: reads `.vscode/settings.json`
 *    for the same `lunit.*` settings, discovers tests with the same parser,
 *    briefly offers its own live-sync bridge for Studio selection, then
 *    falls back to build-and-launch if unselected, and calls the very same
 *    runViaStudio/runViaLune the extension does, resolving verdicts with the
 *    same resolveVerdict. Same code, same results, just no Testing view.
 *
 * Exit code: 0 all passed/skipped, 1 any failed/errored, 2 the run could
 * not be performed at all, 130 cancelled (Ctrl+C).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { CancelSource } from './cancelSignal';
import { buildConfig, DEFAULT_LIVE_SYNC_PORT, LunitConfig, SettingReader } from './config';
import { discoverBridges, matchingBridges } from './bridgeDiscovery';
import { parseTestFile } from './discovery';
import { CliRunRequest, LiveSyncBridge } from './liveSyncBridge';
import { buildTestSelection } from './luauTestFilterTemplate';
import { RunOutcome, runViaLune } from './luneRunner';
import { createResultLineFilter, parseResultLines } from './resultProtocol';
import { partitionSlowTests, slowTestFilterFor } from './runProfiles';
import {
	buildSummary,
	formatSummary,
	matchesFilters,
	resolveVerdict,
	RunSummary,
	runsUnder,
	RunVia,
	SUMMARY_MARKER,
	summaryFailed,
	TestIdentity,
	TestResultEntry,
} from './runReport';
import { runViaStudio } from './studioRunner';

interface CliArgs {
	via: RunVia;
	/** "Run with Lune (Full)": slow-tagged tests run too. Implies --lune. */
	full: boolean;
	json: boolean;
	port?: number;
	workspace?: string;
	standalone: boolean;
	help: boolean;
	filters: string[];
}

const USAGE = `Usage: node lunit-cli.js [options] [filter ...]

Runs this project's @rbxts/lunit tests exactly as the Lunit Test Companion
VS Code extension's Test Explorer does, and prints the same per-test results.

Options:
  --studio          Run in Roblox Studio (default) -- same as "Run in Roblox Studio".
  --lune            Run headlessly with Lune -- same as "Run with Lune". Leaves out tests
                    tagged with one of lunit.lune.slowTags.
  --full            Run with Lune including slow-tagged tests -- same as "Run with Lune (Full)".
                    Implies --lune.
  --json            Print the run summary as JSON on stdout (live output goes to stderr).
  --port <n>        Select an exact window port (otherwise discover from lunit.studio.liveSync.port or ${DEFAULT_LIVE_SYNC_PORT}).
  --workspace <dir> Workspace folder to use when running standalone (default: nearest
                    ancestor of the current directory containing package.json).
  --standalone      Don't route through a running VS Code window even if one is listening.
  -h, --help        Show this help.

Filters (optional, any number): case-insensitive substrings matched against each test's
workspace-relative file path, class name, method name and display name. A test runs if
ANY filter matches it. No filters runs every test eligible for the chosen profile.

Exit code: 0 all passed/skipped, 1 any failed/errored, 2 could not run, 130 cancelled.`;

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { via: 'studio', full: false, json: false, standalone: false, help: false, filters: [] };
	let studioRequested = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const [flag, inlineValue] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined];
		const takeValue = (): string => {
			if (inlineValue !== undefined) {
				return inlineValue;
			}
			const next = argv[++i];
			if (next === undefined) {
				throw new Error(`${flag} requires a value`);
			}
			return next;
		};
		switch (flag) {
			case '--studio':
				args.via = 'studio';
				studioRequested = true;
				break;
			case '--lune':
				args.via = 'lune';
				break;
			case '--full':
				args.full = true;
				break;
			case '--json':
				args.json = true;
				break;
			case '--standalone':
				args.standalone = true;
				break;
			case '--port': {
				const port = Number(takeValue());
				if (!Number.isInteger(port) || port <= 0) {
					throw new Error('--port must be a positive integer');
				}
				args.port = port;
				break;
			}
			case '--workspace':
				args.workspace = path.resolve(takeValue());
				break;
			case '-h':
			case '--help':
				args.help = true;
				break;
			default:
				if (arg.startsWith('-')) {
					throw new Error(`unknown option ${arg}`);
				}
				args.filters.push(arg);
		}
	}
	if (args.full) {
		if (studioRequested) {
			throw new Error('--full runs the Lune profile; it cannot be combined with --studio');
		}
		args.via = 'lune';
	}
	return args;
}

// ---------------------------------------------------------------------------
// Settings (standalone mode): the workspace's .vscode/settings.json
// ---------------------------------------------------------------------------

/** Strips line and block comments (outside strings) and trailing commas, then JSON.parses. */
function parseJsonc(text: string): unknown {
	let out = '';
	let i = 0;
	let inString = false;
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			out += ch;
			if (ch === '\\') {
				out += next ?? '';
				i += 2;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i++;
			continue;
		}
		if (ch === '/' && next === '/') {
			while (i < text.length && text[i] !== '\n') {
				i++;
			}
			continue;
		}
		if (ch === '/' && next === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
				i++;
			}
			i += 2;
			continue;
		}
		out += ch;
		i++;
	}
	out = out.replace(/,(\s*[}\]])/g, '$1');
	return JSON.parse(out);
}

function readWorkspaceSettings(workspaceRoot: string, warn: (message: string) => void): Record<string, unknown> {
	const settingsPath = path.join(workspaceRoot, '.vscode', 'settings.json');
	if (!fs.existsSync(settingsPath)) {
		return {};
	}
	try {
		const parsed = parseJsonc(fs.readFileSync(settingsPath, 'utf8'));
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch (err) {
		warn(`[lunit] could not parse ${settingsPath} (${String(err)}); using default settings.`);
		return {};
	}
}

/**
 * Looks a `lunit.<key>` setting up the way VS Code would: the flat dotted
 * form (`"lunit.studio.liveSync.port": 1234`) first, then progressively
 * nested objects (`"lunit": { "studio": { "liveSync": { "port": 1234 } } }`
 * or `"lunit.studio": { "liveSync.port": 1234 }`), which VS Code also accepts.
 */
function createSettingReader(settings: Record<string, unknown>): SettingReader {
	const lookup = (obj: Record<string, unknown>, segments: string[]): unknown => {
		for (let split = segments.length; split >= 1; split--) {
			const head = segments.slice(0, split).join('.');
			if (head in obj) {
				const value = obj[head];
				if (split === segments.length) {
					return value;
				}
				if (value && typeof value === 'object') {
					const rest = lookup(value as Record<string, unknown>, segments.slice(split));
					if (rest !== undefined) {
						return rest;
					}
				}
			}
		}
		return undefined;
	};
	return <T>(key: string, fallback: T): T => {
		const value = lookup(settings, ['lunit', ...key.split('.')]);
		return value === undefined || value === null ? fallback : (value as T);
	};
}

/** Nearest ancestor (or the directory itself) containing package.json; the directory itself otherwise. */
function findWorkspaceRoot(startDir: string): string {
	let dir = path.resolve(startDir);
	for (;;) {
		if (fs.existsSync(path.join(dir, 'package.json'))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return path.resolve(startDir);
		}
		dir = parent;
	}
}

/**
 * Standalone runs have no VS Code extension storage to write generated files
 * into, so a per-project directory under the OS temp dir stands in -- still
 * outside the project, like the extension's own storage.
 */
function standaloneStorageDir(workspaceRoot: string): string {
	const hash = crypto.createHash('sha1').update(workspaceRoot.toLowerCase()).digest('hex').slice(0, 12);
	const dir = path.join(os.tmpdir(), 'lunit-cli', hash);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// ---------------------------------------------------------------------------
// Discovery (standalone mode): same parser as the extension, own file walk
// ---------------------------------------------------------------------------

/** Converts a VS Code-style glob (`**`, `*`, `?`, `{a,b}`) to a RegExp over forward-slash relative paths. */
function globToRegExp(glob: string): RegExp {
	let re = '^';
	let i = 0;
	while (i < glob.length) {
		const ch = glob[i];
		if (ch === '*' && glob[i + 1] === '*') {
			if (glob[i + 2] === '/') {
				re += '(?:.*/)?';
				i += 3;
			} else {
				re += '.*';
				i += 2;
			}
		} else if (ch === '*') {
			re += '[^/]*';
			i++;
		} else if (ch === '?') {
			re += '[^/]';
			i++;
		} else if (ch === '{') {
			const close = glob.indexOf('}', i);
			if (close === -1) {
				re += '\\{';
				i++;
			} else {
				const alternatives = glob
					.slice(i + 1, close)
					.split(',')
					.map((alt) => alt.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'));
				re += `(?:${alternatives.join('|')})`;
				i = close + 1;
			}
		} else {
			re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
			i++;
		}
	}
	return new RegExp(re + '$');
}

function findTestFiles(root: string, includeGlob: string, excludeGlob: string): string[] {
	const include = globToRegExp(includeGlob);
	const exclude = globToRegExp(excludeGlob);
	const found: string[] = [];
	const walk = (dir: string, rel: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (entry.name === '.git' || exclude.test(`${entryRel}/probe`)) {
					continue;
				}
				walk(path.join(dir, entry.name), entryRel);
			} else if (entry.isFile() && include.test(entryRel) && !exclude.test(entryRel)) {
				found.push(path.join(dir, entry.name));
			}
		}
	};
	walk(root, '');
	return found.sort();
}

interface DiscoveredLeaf extends TestIdentity {
	tags: string[];
}

function discoverTests(config: LunitConfig, warn: (message: string) => void): DiscoveredLeaf[] {
	const leaves: DiscoveredLeaf[] = [];
	for (const file of findTestFiles(config.workspaceRoot, config.testGlob, config.excludeGlob)) {
		let text: string;
		try {
			text = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		try {
			for (const cls of parseTestFile(file, text)) {
				for (const test of cls.tests) {
					leaves.push({
						file,
						className: cls.className,
						methodName: test.methodName,
						displayName: test.displayName,
						tags: [...cls.tags, ...test.tags],
					});
				}
			}
		} catch (err) {
			warn(`[lunit] failed to parse ${file}: ${String(err)}`);
		}
	}
	return leaves;
}

// ---------------------------------------------------------------------------
// Route 1: through the running VS Code extension
// ---------------------------------------------------------------------------

type ExtensionRunResult =
	| { kind: 'not-listening' }
	| { kind: 'refused'; message: string }
	| { kind: 'done'; summary: RunSummary }
	| { kind: 'cancelled' };

function runThroughExtension(
	port: number,
	request: CliRunRequest,
	onOutput: (text: string) => void,
	cancel: CancelSource,
	instanceId?: string,
): Promise<ExtensionRunResult> {
	return new Promise((resolve) => {
		const body = JSON.stringify(request);
		const req = http.request(
			{
				host: '127.0.0.1',
				port,
				method: 'POST',
				path: '/run' + (instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : ''),
				headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
			},
			(res) => {
				if (res.statusCode !== 200) {
					let text = '';
					res.setEncoding('utf8');
					res.on('data', (chunk: string) => (text += chunk));
					res.on('end', () =>
						resolve({
							kind: 'refused',
							message: `${text.trim() || `HTTP ${res.statusCode}`} (port ${port})`,
						}),
					);
					return;
				}
				let summary: RunSummary | undefined;
				const filter = createResultLineFilter((line) => {
					const idx = line.indexOf(SUMMARY_MARKER);
					if (idx === -1) {
						onOutput(line);
						return;
					}
					try {
						summary = JSON.parse(line.slice(idx + SUMMARY_MARKER.length)) as RunSummary;
					} catch {
						// Malformed -- handled as "no summary" below.
					}
				});
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => filter.feed(chunk));
				res.on('end', () => {
					filter.flush();
					if (cancel.token.isCancellationRequested) {
						resolve({ kind: 'cancelled' });
					} else if (summary) {
						resolve({ kind: 'done', summary });
					} else {
						resolve({
							kind: 'refused',
							message: 'the VS Code extension ended the run without reporting a summary (was the window closed mid-run?)',
						});
					}
				});
				res.on('error', () => resolve(cancel.token.isCancellationRequested ? { kind: 'cancelled' } : { kind: 'refused', message: 'connection to the VS Code extension was lost mid-run' }));
			},
		);
		req.on('error', (err: NodeJS.ErrnoException) => {
			if (cancel.token.isCancellationRequested) {
				resolve({ kind: 'cancelled' });
			} else if (err.code === 'ECONNREFUSED') {
				resolve({ kind: 'not-listening' });
			} else {
				resolve({ kind: 'refused', message: `${err.message} (port ${port})` });
			}
		});
		cancel.token.onCancellationRequested(() => req.destroy());
		req.end(body);
	});
}

// ---------------------------------------------------------------------------
// Route 2: standalone, in this process
// ---------------------------------------------------------------------------

async function runStandalone(
	args: CliArgs,
	workspaceRoot: string,
	config: LunitConfig,
	port: number,
	onOutput: (text: string) => void,
	cancel: CancelSource,
): Promise<RunSummary> {
	if (args.via === 'studio' && !config.studio.enabled) {
		return buildSummary(args.via, [], false, 'the "Run in Roblox Studio" profile is disabled (lunit.studio.enabled is false).');
	}

	const all = discoverTests(config, onOutput);
	const eligible = all.filter((leaf) => runsUnder(leaf.tags, args.via) && matchesFilters(leaf, args.filters, workspaceRoot));
	if (eligible.length === 0) {
		const why = args.filters.length > 0 ? ` matching ${args.filters.map((f) => `"${f}"`).join(', ')}` : '';
		return buildSummary(args.via, [], false, `no ${args.via === 'lune' ? 'Lune' : 'Roblox Studio'} tests were found${why} under ${workspaceRoot} (glob ${config.testGlob}).`);
	}
	// As in the extension's CLI route, a filter never counts as explicitly
	// selecting a slow test; --full is how to run those.
	const slow = partitionSlowTests(eligible, config.lune.slowTags, args.full, (leaf) => ({ tags: leaf.tags, explicit: false }));
	const leaves = slow.run;
	const slowFilter = slowTestFilterFor(config.lune.slowTags, args.full, []);
	const withSlowCount = (summary: RunSummary): RunSummary =>
		slow.leftOut.length > 0 ? { ...summary, slowLeftOut: slow.leftOut.length } : summary;
	if (leaves.length === 0) {
		return withSlowCount(buildSummary(args.via, [], false));
	}

	// Own the live-sync port for the duration of the run so an already-open
	// Studio with the companion plugin connects here, exactly as it would to
	// the extension. The plugin polls every 1.5s, so give it a couple of
	// cycles to show up before deciding it isn't there.
	let bridge: LiveSyncBridge | undefined;
	let ownedBridge: LiveSyncBridge | undefined;
	if (args.via === 'studio' && config.studio.liveSync.enabled) {
		ownedBridge = new LiveSyncBridge(port, (err) => {
			onOutput(`[lunit] could not listen on the live-sync port ${port} (${err.message}); Studio live-sync unavailable for this run.\n`);
			bridge = undefined;
		});
		bridge = ownedBridge;
		bridge.start();
		const deadline = Date.now() + 3500;
		while (bridge && !bridge.isPluginConnected && Date.now() < deadline && !cancel.token.isCancellationRequested) {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	const displayFilter = createResultLineFilter(onOutput);
	const chunkSink = (chunk: string) => displayFilter.feed(chunk);
	let outcome: RunOutcome;
	try {
		outcome =
			args.via === 'lune'
				? await runViaLune(config, cancel.token, chunkSink, slowFilter)
				: await runViaStudio(
						config,
						cancel.token,
						chunkSink,
						bridge,
						args.filters.length > 0 ? buildTestSelection(leaves) : undefined,
						slowFilter,
					);
	} catch (err) {
		displayFilter.flush();
		const message = `[lunit] test run failed: ${String(err)}`;
		onOutput(message + '\n');
		return withSlowCount(buildSummary(args.via, leaves.map((leaf) => ({ ...identityOnly(leaf), status: 'errored', message })), false));
	} finally {
		ownedBridge?.stop();
	}
	displayFilter.flush();

	if (outcome.cancelled) {
		return withSlowCount(buildSummary(args.via, leaves.map((leaf) => ({ ...identityOnly(leaf), status: 'skipped' })), true));
	}
	const records = parseResultLines(outcome.output);
	const results: TestResultEntry[] = leaves.map((leaf) => ({ ...identityOnly(leaf), ...resolveVerdict(leaf, records, outcome) }));
	return withSlowCount(buildSummary(args.via, results, false));
}

function identityOnly(leaf: DiscoveredLeaf): TestIdentity {
	return { file: leaf.file, className: leaf.className, methodName: leaf.methodName, displayName: leaf.displayName };
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	let args: CliArgs;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`${String(err instanceof Error ? err.message : err)}\n\n${USAGE}\n`);
		return 2;
	}
	if (args.help) {
		process.stdout.write(USAGE + '\n');
		return 0;
	}

	// With --json, stdout is reserved for the summary so a program can parse
	// it; the live run output still streams, on stderr.
	// Remembers the tail of the live output so the summary can always be
	// separated from it by exactly one blank line, however it ended.
	let liveTail = '\n\n';
	const live = (text: string) => {
		if (text.length === 0) {
			return;
		}
		liveTail = (liveTail + text.replace(/\r\n/g, '\n')).slice(-2);
		(args.json ? process.stderr : process.stdout).write(text);
	};

	const cwd = process.cwd();
	const workspaceRoot = args.workspace ?? findWorkspaceRoot(cwd);
	const settings = createSettingReader(readWorkspaceSettings(workspaceRoot, live));
	const config = buildConfig(workspaceRoot, standaloneStorageDir(workspaceRoot), settings);
	const port = args.port ?? config.studio.liveSync.port;

	const cancel = new CancelSource();
	const onSigint = () => {
		live('\n[lunit] cancelling...\n');
		cancel.cancel();
	};
	process.on('SIGINT', onSigint);

	let summary: RunSummary | undefined;
	let cancelledByUser = false;

	if (!args.standalone) {
		const discovered = await discoverBridges(port, args.port === undefined ? undefined : 1);
		const matches = matchingBridges(discovered, args.workspace ?? cwd);
		if (matches.length > 1) {
			live(`[lunit] Multiple VS Code windows contain this workspace. Use --port with one of: ${matches.map(b => b.port).join(', ')}.\n`);
			process.off('SIGINT', onSigint);
			return 2;
		}
		const target = matches[0];
		// Preserve legacy extensions and explicit --port. Never send a run to
		// a discovered modern window that belongs to an unrelated workspace.
		const result: ExtensionRunResult = target || args.port !== undefined || discovered.length === 0
			? await runThroughExtension(target?.port ?? port, { cwd: args.workspace ?? cwd, via: args.via, filters: args.filters, full: args.full }, live, cancel, target?.instanceId)
			: { kind: 'not-listening' };
		if (result.kind === 'done') {
			summary = result.summary;
		} else if (result.kind === 'cancelled') {
			cancelledByUser = true;
		} else if (result.kind === 'refused') {
			live(`[lunit] could not run through the VS Code extension: ${result.message}\n`);
			return 2;
		} else {
			live(`[lunit] no matching VS Code window found; running standalone from ${workspaceRoot}.\n`);
		}
	}

	if (!summary && !cancelledByUser) {
		summary = await runStandalone(args, workspaceRoot, config, port, live, cancel);
	}
	process.off('SIGINT', onSigint);

	if (cancelledByUser || (summary && summary.cancelled)) {
		live('[lunit] run cancelled.\n');
		if (args.json && summary) {
			process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
		}
		return 130;
	}
	if (!summary) {
		return 2;
	}

	if (args.json) {
		process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
	} else {
		const separator = liveTail === '\n\n' ? '' : liveTail.endsWith('\n') ? '\n' : '\n\n';
		process.stdout.write(separator + formatSummary(summary, workspaceRoot) + '\n');
	}
	if (summary.error) {
		return 2;
	}
	return summaryFailed(summary) ? 1 : 0;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(err) => {
		process.stderr.write(`[lunit] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
		process.exitCode = 2;
	},
);
