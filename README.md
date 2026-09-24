# Lunit Test Explorer

A VS Code extension that discovers [`@rbxts/lunit`](https://www.npmjs.com/package/@rbxts/lunit) tests in a
roblox-ts project and runs them from VS Code's native **Test Explorer**, either headlessly via
[Lune](https://github.com/lune-org/lune) or inside Roblox Studio. Both ways to run are registered as
separate **run profiles**, so you pick between them from the dropdown arrow next to the Run button in
Test Explorer (or set one as the default via the profile picker's gear icon).

## ⚠️ One-time setup: install the Roblox Studio plugin

If you ever run tests in Roblox Studio, do this now: run **Lunit: Install Roblox Studio Live-Sync Plugin**
from the Command Palette (you'll also be prompted for this automatically the first time the extension finds
Lunit tests in a workspace). It's a small 🧪 toolbar button that installs once into Studio's Plugins folder
and runs in Edit mode. After installation or an update, reload the plugin in Studio, then click
**Lunit** and select the workspace you want to run tests from.

**Without it**, "Run in Roblox Studio" still works, but it builds a fresh place and launches a brand-new
Studio process on *every single run* -- slow, and useless if you already have Studio open with your project
live-synced via `rojo serve`. **With it installed** (and Studio open with your project synced), tests run
directly in that already-open instance instead: faster, and it doesn't even require Play mode.

Check whether it's connected any time via the **Lunit: Studio connected / not connected** status bar item
(bottom right) -- click it for details, including a one-click install if it's missing. See
[Roblox Studio profile](#roblox-studio-profile) below for exactly how the two modes differ.

On plugin startup, Lunit automatically reconnects to your last selected workspace, identified by its
folder paths rather than its port or process ID. If unavailable, it connects to the first available
VS Code window (the lowest port in its discovery range), keeping the saved preference for next time.
Your selection is saved in Studio's local plugin settings. The panel stays closed. If no window is available during
that startup scan, open Lunit and click **Refresh**, then **Connect** when your project is ready.

**Multiple VS Code windows:** Studio's **Lunit** button opens a dockable **Lunit — Connect to VS Code**
panel immediately. It shows discovery progress, then workspace names, full paths, and process IDs.
Click **Connect** beside your workspace. Use **Stop** to pause polling while keeping your selected workspace, **Start** to reconnect, and **Refresh** to scan again.
You can leave the panel open; closing it does not disconnect. Switch windows when no request or test
run is in progress. The selected entry is marked **Selected** and logged in Studio Output. Re-select after
the selected VS Code window reloads; a reused port never silently selects a different window. Reloading
the Studio plugin starts a fresh automatic selection. Manual selection or Start/Stop overrides an
automatic selection that is still in progress.
The previous window's status can take up to five seconds to expire after switching or stopping.

Each window automatically takes a free port in `34873`–`34892`. To use another discovery range, set
`lunit.studio.liveSync.port`, reload VS Code, then reinstall and reload the plugin to match.
All windows you want to discover should use the same range. The CLI discovers the window containing
its working directory; if multiple windows contain the same project, use `--port` to choose one.
Upgrade both the extension and Studio plugin for the picker: older plugins still poll only the base
port, and older extensions do not appear in the picker. Rojo syncing uses a separate connection.
For connection errors, click the VS Code Lunit status bar item and check Studio's Output panel.

## Quick Start

New to a project, or setting one up from scratch? Three steps:

**1. Install Lune** (only needed for the Lune profile -- skip this if you only plan to run tests in Roblox
Studio). [Rokit](https://github.com/rojo-rbx/rokit) is the easiest path:

```bash
rokit add lune-org/lune
```

Or grab a binary release directly from [lune-org/lune](https://github.com/lune-org/lune/releases).

**2. Install `@rbxts/lunit`** in your roblox-ts project:

```bash
npm install @rbxts/lunit
# or
pnpm add @rbxts/lunit
```

**3. Write a test.** A test is a class; methods marked `@Test` become test cases. The filename must end in
`.test.ts`/`.test.tsx` or `.spec.ts`/`.spec.tsx` (configurable via `lunit.testGlob`) to be picked up:

```ts
// src/sum.test.ts
import { Test, Assert } from "@rbxts/lunit";

class TestSum {
	@Test
	public addsTwoNumbers() {
		Assert.equal(1 + 1, 2);
	}
}

export = TestSum;
```

Save the file, open the **Testing** view in the sidebar (flask icon), and the test appears automatically.
Click the play button next to it -- or use the dropdown next to Run to choose **Run with Lune** or
**Run in Roblox Studio** (plus **Run with Lune (Full)** if you've set up
[slow tests](#slow-tests-and-the-full-profile)) -- and results show up right there in the tree. No project-side configuration,
Rojo project file, or test-runner script needed; see [What it does](#what-it-does) below for how each
profile actually runs things.

## What it does

- Scans `**/*.{test,spec}.{ts,tsx}` (configurable) with the TypeScript compiler API and builds a
  folder → file → class → test tree from `@Test`-decorated methods, honoring `@DisplayName`, `@Tag`, `@Skip`,
  `@Only` and `@Each` where statically determinable. The tree is laid out for reading, not for paths: test
  files are grouped under their directory (shown by name, with the workspace-relative path dimmed beside it)
  and labelled without their `.test.tsx` suffix, and camelCase names become sentences
  (`clampsUpToMinWhenTextIsUnderRange` → "Clamps up to min when text is under range"; turn off with
  `lunit.explorer.humanizeNames`). Keep method names short and put the full sentence in `@DisplayName("...")`
  (or the method's JSDoc comment): it is shown dimmed beside the name, as in
  "Active breakpoint  *Cols defaults to one when no breakpoint value resolves*". Set
  `lunit.explorer.displayName` to `label` if you'd rather `@DisplayName` replace the name, as Lunit's own
  report does. Each row also shows its own `@Tag` values and `skip` / `only` / `each xN` markers (a
  conditional `@Skip(condition, ...)` is decided at run time, so it isn't marked), and tags are exposed to the
  Test Explorer's filter box: type `@lunitTests:Studio` (or `@lunitTests:skip`) to narrow the tree.
- **Run with Lune**: compiles the project (`npx rbxtsc` by default), regenerates a small Lune worker
  script, and runs the test modules through a pool of independent Lune processes (see
  [Parallel Lune runs](#parallel-lune-runs)), reflecting pass/fail/skip back onto the tree with inline
  failure messages as each block finishes.
- **Run in Roblox Studio**: if an already-open Studio instance has this project live-synced via your own
  `rojo serve` and the companion Studio plugin is installed, runs tests there directly (no new Studio process,
  no Play mode). Otherwise compiles the project, bakes the compiled output into a standalone place file
  (`rojo build` by default), then launches Studio's documented `--task RunScript` command-line mode against
  a bootstrap script that invokes Lunit's `TestRunner`, reporting results the same way.
- Everything either profile generates (Lune runner scripts, the Studio test Rojo project + bootstrap script,
  the built place file, Studio's output log) is written to this extension's own per-workspace storage
  (VS Code's `ExtensionContext.storageUri`) rather than into your project -- nothing shows up in your file
  tree or needs a `.gitignore` entry.

Both profiles get per-test results through Lunit's `reporter.onTestEnd` hook rather than by parsing its
human-readable console report, encoding each result as a small tagged, base64-safe line alongside the
normal pretty output (see [Result reporting](#result-reporting) below) — this was built and verified against
Lunit's own upstream source and its real compiled self-test suite, not guessed from the README alone.

## Setup

1. `npm install` in this extension's folder, then `npm run compile` (or press F5 to launch an Extension
   Development Host, which runs the compile task first).
2. Open your roblox-ts project (the one containing `@rbxts/lunit` and your `*.spec.ts`/`*.test.ts` files)
   as a workspace folder — either in the Extension Development Host, or after packaging/installing this
   extension with `vsce package` + "Install from VSIX".
3. Open the **Testing** view. Tests appear automatically; use the refresh icon or **Lunit: Refresh Tests**
   if you add files while the extension is already running.

### Lune profile

The profile handles both roblox-ts project types, and works out which one you have by reading your compiled
output -- there's normally nothing to configure.

**Package projects** (`--type package`) compile to entirely `script`-relative code (each module opens with
`_G[script]`), so the runner discovers `*.test.luau` / `*.spec.luau` on disk and requires them by path. This
is the long-standing behaviour, described in the rest of this section.

**Game projects** (`--type game`) can't be run that way: because a Rojo project file decides that (say)
`src/game/shared` becomes `ReplicatedStorage.Game`, roblox-ts emits *absolute DataModel paths*, and every
import in every module resolves by walking the DataModel:

```lua
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local _lunit = TS.import(script, game:GetService("ReplicatedStorage"), "rbxts_include", "node_modules", "@rbxts", "lunit", "out")
```

For these, the extension builds a virtual, read-only DataModel from the same Rojo project file Studio syncs,
loads your project's own `RuntimeLib` on top of it, and discovers tests by walking that tree. Roblox
datatypes (`Vector3`, `CFrame`, `Color3`, `UDim2`, `Enum`, ...) come from Lune's own implementations, so they
behave as the engine's do -- float32 `Vector3` components, `typeof(CFrame.new()) == "CFrame"`, working
operators. `require`-by-string (`./`, `../`, `@self/`) resolves against the calling module's position in the
tree.

There is deliberately **no engine**: no `Instance.new`, no real services, no scheduler or clocks. A service
your project never mapped resolves to an empty stub so that a module merely referencing one at load time
still loads, but a test that actually needs the engine belongs in the Studio profile behind `@Tag("Studio")`
-- a class-level `@Tag("Studio")` module is never even loaded, so it's free to touch the engine at load time.
A module that fails to load fails the run and names the dependency chain that reached the failure.

The Rojo project is picked automatically when there's only one candidate at the workspace root (or a
`default.project.json`). If several could describe your tests the run stops and asks, because only you know
which one builds them: set **`lunit.lune.projectFile`** to it. Setting it also forces the game path
explicitly. Package projects ignore this setting entirely and need no new configuration.

The rest of this section applies to package projects. Defaults are `testsRoot = ${workspaceFolder}`
(the whole workspace, walked recursively for `*.test.luau` / `*.spec.luau` and skipping `node_modules` -- so
nested packages with their own independent `tsconfig.json`/`outDir` are found too, not just a single
top-level `out/`) and `lunitRoot = node_modules/@rbxts/lunit/out` — a published `@rbxts` package normally
ships pre-built Luau directly in `node_modules`, it isn't recompiled by `rbxtsc` into your own `out/`,
confirmed against a real project's own working npm test script.

Tests that can't (or shouldn't) run headlessly should be tagged `@Tag("Studio")` -- see
[Choosing Lune vs. Studio per test](#choosing-lune-vs-studio-per-test) below -- so they're excluded from this
profile entirely rather than attempted and shown as a failure. A test file that still fails to load under
Lune despite that (e.g. an untagged file that happens to import something Lune can't run) is skipped with a
warning instead of a hard failure, but tagging it correctly is the better fix. Adjust
`lunit.compileCommand`, `lunit.lune.executable`, `lunit.testsRoot`, `lunit.lunitRoot` and `lunit.outDir` in
settings if your project's layout differs; if a run reports "No tests found" or fails to load Lunit, these
are the settings to check first.

This extension generates its own Lune entry script rather than reusing `@rbxts/lunit`'s bundled
`scripts/lunit.luau` -- that script's shim only implements relative-import resolution (`TS.import`), not
`TS.getModule`, so it crashes on the very first line of any test file with an ordinary
`import { Test } from "@rbxts/lunit"` (which is the only realistic way to import it). The generated script
fixes this; see `src/luauShimTemplate.ts` for the detail.

### Roblox Studio profile

Two modes, chosen automatically, no setting to flip yourself:

**Live-sync mode** -- when a Roblox Studio instance is already open with this project live-synced via your
own `rojo serve` (a common "dev workspace" setup, e.g. a monorepo where several packages are already synced
into one shared dev place), and the companion **Lunit Studio plugin** is installed and polling. Tests run
directly inside that already-open instance -- no new Studio process, and no Play mode required (plugins run
continuously in Edit mode too, unlike ordinary Scripts). Install the plugin once via **Lunit: Install Roblox
Studio Live-Sync Plugin** (copies a small script into Studio's Plugins folder; reopen Studio to load it —
after that it polls automatically forever, nothing further to do). The plugin polls a local, 127.0.0.1-only
HTTP server this extension starts (`lunit.studio.liveSync.port`, default 34873) — the same trust model
`rojo serve` itself uses, no auth beyond "only this machine can reach it." Since discovery here can't assume
any particular Rojo tree shape (it's *your* `default.project.json`, not one this extension controls), it
searches the whole place once for a `RuntimeLib` module, an `"@rbxts"` scope folder's `lunit` child, and every
`*.test`/`*.spec` ModuleScript, rather than navigating an expected path.

Live-sync mode also requires this workspace folder to actually have a Rojo project file of its own (a
`default.project.json`, or any other `*.project.json` in its root) -- a connected plugin only means *some*
project is currently synced into that Studio instance, not necessarily this one (e.g. a library normally
embedded in a larger dev workspace's own Rojo tree, opened here on its own with Studio left over from a
previous session). Without one, live-sync falls back to standalone mode below even with the plugin connected
-- the status bar will still show **Studio connected, rojo serve not detected** in that case, which is worth
checking if a run unexpectedly launches a new Studio process instead of using one you already have open.

**Standalone mode** -- the fallback whenever no plugin is currently connected, or this project has no Rojo
project file of its own (see above). Builds a throwaway place and launches a real Studio process via
Studio's own documented CLI automation flags (`--task RunScript --localPlaceFile ... --runScriptFile ...
--outputFile ... --quitAfterExecution`), no companion plugin needed for this mode. Slower (a fresh Studio
has to launch and load), which is exactly why live-sync mode is preferred whenever it's available. On every
run in this mode, the extension:

1. Compiles the project (unless `lunit.skipCompile`).
2. Decides which Rojo project to build the place from, and says so in the output:
   - **A roblox-ts game project** (`rbxtsc --type game`, the usual shape for an actual game) is compiled
     *for* the tree its `--rojo` project file describes: a test under `tests/common/client` importing from
     `src/common/client` compiles to `TS.import(script, script.Parent.Parent.Parent, "Common", ...)`, which
     only resolves when the compiled test sits beside the source folder exactly where that project puts it.
     So the place is built from the project's **own** Rojo file: `lunit.studio.rojoProject` if set, else the
     file named by the compile command's `--rojo` flag (followed through `npm run ...` scripts), else
     `lunit.lune.projectFile` or the one `*.project.json` at the workspace root. If none can be found, or
     `rojo build` fails, the run stops with exit code 2 and a message saying to connect Rojo (live-sync
     mode) or set `lunit.studio.rojoProject` -- rather than building a place in which no import resolves.
   - **A roblox-ts package** (a `package.json` whose `main`/`types` point into the output directory, or
     compiled output that is `script`-relative) needs no Rojo project of its own: the extension generates a
     small, self-contained one (in its storage directory, always regenerated) mapping just what's needed:
     `node_modules/roblox-ts/include` (the TS runtime), every `@scope` folder under `node_modules` that
     actually contains Luau content (not just `@rbxts` -- e.g. `@rbxts/react` depends on `react-lua`'s
     internals published under `@rbxts-js`), and the compiled package itself, mounted *as if* it were just
     another dependency under its own scope. A package's output is relocatable precisely because roblox-ts
     emits it `script`-relative, so this is what lets `import { X } from "@rbxts/whatever"` resolve with no
     `default.project.json` at all (library packages like `@rbxts/react-clean-ui` usually don't have one).
3. Builds that project into a place file with `rojo build` (`lunit.studio.buildPlaceCommand`, where
   `${projectFile}` is whichever project step 2 chose).
4. Generates the bootstrap script (also in this extension's storage directory, always regenerated) that
   walks the built place for `*.test`/`*.spec` ModuleScripts and runs each one (leaving out `@Tag("Lune")`
   tests -- see [Choosing Lune vs. Studio per test](#choosing-lune-vs-studio-per-test)), and launches Studio
   against it. Nothing is injected into the place itself: Studio runs the script via `--runScriptFile`.

Notes:
- On Windows, `RobloxStudioBeta.exe` is auto-detected under `%LOCALAPPDATA%\Roblox\Versions`. On other
  platforms, or if auto-detection fails, set `lunit.studio.executablePath` explicitly.
- Disable this profile entirely with `lunit.studio.enabled: false` if you only want the Lune workflow.
  Disable just the live-sync fast path (always use standalone mode) with `lunit.studio.liveSync.enabled: false`.
- The extension itself never talks to any AI-assistant tooling (MCP servers, etc.) to make any of this work --
  the plugin bridge above is the only mechanism, and it's plain HTTP against a server this extension owns.
- Live-sync mode adds a short delay after compiling (`lunit.studio.liveSync.syncDelaySeconds`, default 1s) to
  give your own `rojo serve` a moment to push the freshly compiled changes into Studio before running tests --
  increase it if results seem to lag one run behind your latest edit.
- **Rojo required, roblox-ts required**: `rojo build` and `node_modules/roblox-ts/include` must both be
  available; this is virtually always already true for a roblox-ts project.
- To run a *package's* tests against your real game's place instead (e.g. because a test needs its
  services/config), set `lunit.studio.rojoProject` to that project file: the bootstrap script searches the
  whole built place for tests, so no other change is needed. A game project already does this by default.
- **Bootstrapping detail worth knowing if you read `src/bootstrapTemplate.ts`**: roblox-ts compiled modules
  all start with `local TS = _G[script]`, which is only populated as a side effect of loading a module
  *through* `TS.import`/`TS.getModule` -- a bare `require()` on a roblox-ts-compiled ModuleScript leaves that
  nil and crashes on its first line. The bootstrap script only calls plain `require()` on the one
  hand-written, non-compiled module roblox-ts ships (`RuntimeLib`), then uses `RuntimeLib.import`/
  `RuntimeLib.getModule` for everything else, exactly mirroring what compiled code does internally.

### Choosing Lune vs. Studio per test

Both profiles run every discovered test by default. Tag a test with `@Tag("Studio")` (class or method level)
if it needs real Roblox Studio -- `game`, real `Instance`s, mounting a `@rbxts/react`/`@rbxts/react-roblox`
component -- and it's excluded from the **Run with Lune** profile entirely: never attempted, never shown as a
failure there, not even offered for that profile on that item. `@Tag("Lune")` does the reverse for the rarer
case of a test that should only run headlessly. No tag means it runs under both. Tags match
case-insensitively.

The rule is enforced at both ends:

- **In VS Code**, through two `TestTag`s the extension assigns based on Lunit's own `@Tag` decorator (parsed
  statically), one per profile. A test the profile leaves out is reported as **skipped** when a run covers
  it (e.g. "run all"), never as failed or errored.
- **In the generated runners**, which read the same tags from the compiled classes: the Lune runner leaves
  out `@Tag("Studio")` classes and methods, and both Studio modes (live-sync and standalone) leave out
  `@Tag("Lune")` ones. A class-level tag is recognised in the compiled source, so that module is not even
  loaded. When you run a selection rather than everything, Studio runs just the selected classes and
  methods.

Studio yields a frame between test classes at least every 50 ms, so a long run doesn't freeze it. In
live-sync mode the run also stops starting new classes once `lunit.studio.liveSync.timeoutSeconds` has
passed, because by then VS Code has stopped waiting for results.

**"A plugin is taking a long time to run. Do you want to stop it?"** -- Studio shows this popup when one
script runs without yielding for longer than its script timeout (10 seconds by default). The total run
length isn't the trigger; a run of several minutes that yields regularly never shows it. The Studio runner
only yields *between* test classes, and lunit doesn't yield between synchronous tests, so a single class of
CPU-bound tests (or one test that computes for more than 10 seconds) can trip it. Answering **No** lets the
run continue, but the popup returns on the next long stretch. To prevent it:

- In Studio, open **File > Studio Settings > Studio** and raise **Script Timeout Length**, or set it to `0`
  to disable the check. This is the only fix for a single test that runs longer than the timeout.
- Or keep the heavy tests out of Studio: tag them with one of `lunit.lune.slowTags` (see
  [Slow tests and the Full profile](#slow-tests-and-the-full-profile)) or with `@Tag("Lune")`, and run them
  with the Lune profile instead.
- Or make the long tests yield: a `task.wait()` inside a long-running test gives Studio a frame and resets
  its timer.

```ts
import { Test, Tag } from "@rbxts/lunit";

@Tag("Studio")
class MountsAComponent {
	@Test
	public rendersWithoutErrors() {
		// uses game / Instance.new / React mounting -- Studio only
	}
}

export = MountsAComponent;
```

### Slow tests and the Full profile

Long sweeps can be kept out of the everyday run. List their tags in **`lunit.lune.slowTags`** (default `[]`,
so nothing changes until you set it):

```json
"lunit.lune.slowTags": ["Slow"]
```

A test is slow when its class or the method carries one of those tags (matched case-insensitively). With the
setting in place:

| Profile | Runs |
|---|---|
| **Run with Lune** (the default) | Everything that runs under Lune, except slow tests |
| **Run with Lune (Full)** | Everything that runs under Lune, slow tests included |
| **Run in Roblox Studio** | As before, and also without slow tests |

The Full profile only appears while `lunit.lune.slowTags` names at least one tag.

- Running a folder, file or class leaves its slow tests out. They aren't reported as skipped or failed. The
  run output says how many were left out instead: "Left out 12 slow test(s): run with Lune (Full)." A class
  whose only tests are slow leaves nothing to run without that being an error.
- Running **one slow test directly** runs it under either Lune profile, since you asked for that test by
  name. Slow tests can always be run from both Lune profiles in the Test Explorer.
- On the command line, `--lune` leaves slow tests out and `--full` includes them (`--full` implies
  `--lune`). A filter that matches a slow test doesn't count as selecting it directly: use `--full`.

```ts
@Tag("Lune")
class WorldGeneration {
	@Test
	public buildsOneChunk() {}

	@Test
	@Tag("Slow")
	public sweepsAHundredSeeds() {} // only in "Run with Lune (Full)"
}
```

### Parallel Lune runs

Both Lune profiles run tests in a bounded pool of independent Lune processes, so a CPU-heavy suite uses
every core rather than one. A run compiles the project once, then one discovery process loads every test
module and lists each class's compiled Lunit metadata (tests, tags, `@Each` rows, lifecycle hooks,
`@Order`, `@Only`). From that the extension plans *blocks* and runs them through at most N workers: the
moment a worker finishes a block it takes the next pending one, and Test Explorer items move from
queued to running to their verdict as their block starts and finishes.

- **One test module per block** by default. The whole class runs in one VM exactly as before: its
  method ordering, `@BeforeAll`/`@AfterAll`/`@BeforeEach`/`@AfterEach` hooks and any state shared
  between its methods are untouched. What changes is *between* modules: every block has its own module
  cache and globals, so a module that relied on another module having run earlier in the same process no
  longer sees it (see dependency groups below).
- **Per-case blocks with `@Tag("Parallel")`.** A class-level `@Tag("Parallel")` runs each of its test
  methods, and each `@Each` row, as its own block in a fresh Lune VM with a fresh class instance;
  `@BeforeEach`/`@AfterEach` run inside every block. It is safe exactly when every method and row can
  run alone, in any order, from a fresh process: no state shared between methods, no cache one method
  fills for another, no ordering. A class that also has `@BeforeAll`/`@AfterAll`, `@Order`, or a method
  that is both a `@Test` and a lifecycle hook cannot be split safely, so its tests are reported as
  **errored** with a message saying why; remove the tag or restructure the class. Everything *inside*
  one method still runs together, so a test that compares two results computes both itself. Long,
  independent sweeps (many seeds, many rows) are the typical candidates.
- **Dependency groups.** Modules that depend on each other go in
  `lunit.lune.parallel.dependencyGroups`, prerequisite first:

  ```json
  "lunit.lune.parallel.dependencyGroups": [["tests/setup.test.ts", "tests/consumer.test.ts"]]
  ```

  The modules of a group load into one Lune process and their classes run in that order; a group takes
  precedence over `@Tag("Parallel")`. Name a module as the run output shows it (`out/tests/setup.test`
  for a package project, `ReplicatedStorage.Tests.setup.test` for a game project) or by any unique
  trailing part, the source path included. Selecting a test in a group also runs the modules listed
  before its module, in full, and the output says so ("... run in full before the selected tests in
  ..."); their results show up in the tree too. An unknown, ambiguous or repeated name stops the run with
  an error naming it, and a module can belong to one group only. Process isolation cannot isolate
  external resources (files, servers): put every user of such a resource in one group.
- **Workers.** `lunit.lune.parallel.workers` (default `0`: the smaller of 32 and the logical CPU count),
  always capped by the number of blocks; `1` runs the blocks one after another, still isolated. Values
  above 32 such as `64` are allowed. Concurrent VM start-ups and memory contend, so whether 64 beats 32
  on a 64-core machine depends on the suite (one project's own runner measured 32 as faster; the same
  suite through this extension ran faster at 64), so measure before raising it. On the command line,
  `--workers N` overrides it for one run.
- **Output.** Each worker's output streams to the Lunit output channel prefixed with its block id
  (`[#12]`), after a `[lunit] #12 started: <module>` line, and ends with `PASS`, `FAIL`, `ERROR` or
  `CANCELLED` and the block's seconds. The run closes with the number of blocks and workers, the wall
  time (compile and discovery separately), the longest block, and the blocks over 10 s. That threshold is
  an optimization target, not a timeout: nothing fails for being slow.
- **Nothing passes by omission.** A worker that crashes, is killed, prints no block summary, or prints
  one that disagrees with its result lines errors every test of that block, with the worker's last lines
  in the message. A test its block never reported is errored. Cancelling stops the running workers (their
  whole process trees), starts nothing else, and reports what did not run as skipped.
- **Selection.** Run-all, folder, file, class and single-test selection, exclusions, the runtime tags and
  the slow rule work as before; the Lune profile now runs *only* the selected tests (plus any dependency
  prerequisites) instead of the whole suite. The tree shows one item per `@Test` method, so a
  parameterized method's rows are folded onto it: any failing row fails the item and the message names
  the row; selecting the method runs every one of its eligible rows. Individual rows cannot be selected.
- **Turning it off.** `lunit.lune.parallel.enabled: false` runs every module in one Lune process with
  one shared module cache, as the profile did before 0.7.0; `@Tag("Parallel")` is ignored then.

Generated scripts and job files are written to a per-run directory under the extension's storage, so two
runs at once (say the Test Explorer and the command line) never overwrite each other's files.

## Running tests from the command line (for coding agents)

Nothing outside VS Code can press the Test Explorer's Run button, so the extension ships a command-line
entry point that runs the tests the same way and prints the same results. Run **Lunit: Show Command-Line
Test Command** from the Command Palette to get the exact command for your machine (it has a Copy button);
it looks like:

```sh
node "<VS Code user data>/globalStorage/shadercloud.vscode-lunit-companion/lunit-cli.js" --studio
```

That launcher is a one-line file the extension rewrites on every activation to point at the currently
installed version, so the path stays stable across extension updates. Options:

- `--studio` (default) is "Run in Roblox Studio"; `--lune` is "Run with Lune"; `--full` is "Run with Lune
  (Full)", which also runs tests tagged with one of `lunit.lune.slowTags` (see
  [Slow tests and the Full profile](#slow-tests-and-the-full-profile)).
- `--workers N` (Lune only) caps the number of Lune processes for this run; `--workers 1` runs the
  blocks one by one. See [Parallel Lune runs](#parallel-lune-runs).
- Any other arguments are filters: case-insensitive substrings matched against each test's
  workspace-relative file path, class name, method name and display name (a test runs if any filter
  matches). `... --studio MyFeature` or `... --studio src/foo.test.ts`, for example.
- `--json` prints the run summary as JSON on stdout (the live output moves to stderr), with one entry per
  test (`file`, `className`, `methodName`, `displayName`, `status`, `message`, `elapsedMs`) plus `counts`.
- Exit code 0 = every test passed or was skipped, 1 = at least one failed or errored, 2 = the run couldn't be
  performed at all (the reason is printed), 130 = cancelled with Ctrl+C.
- `--help` lists everything, including `--port`, `--workspace` and `--standalone`.

How it works, and why the results are identical to clicking in the Test Explorer:

1. **Through the running VS Code window (the normal case).** The CLI discovers the window whose workspace
   contains its working directory and posts the run to that window's HTTP server. The extension executes it through the
   very same function a Test Explorer click invokes -- same discovery, same compile, same live-sync-or-launch
   decision, same result parsing, same per-test verdicts and failure messages. Output streams back to the
   terminal live, and the run also shows up in the Testing view. Ctrl+C cancels it like the Stop button.
   The most specific matching workspace wins; duplicate windows require an explicit `--port`.
   Legacy extensions still use the configured base port and reject runs from unrelated workspaces.
2. **Standalone (no VS Code window open).** The CLI reads the same `lunit.*` settings from the workspace's
   `.vscode/settings.json` (user-level settings aren't visible to it), discovers tests with the same parser,
   briefly offers its own live-sync server for Studio selection, falling back to build-and-launch if unselected,
   and calls the same runner modules. Generated files go to a per-project folder under the OS temp directory
   instead of VS Code's extension storage.

Only one command-line run at a time is accepted per window.

## Using a coding agent to write tests

Run **Lunit: Add/Update Agent Instructions (AGENTS.md)** from the Command Palette to generate (or update) an
`AGENTS.md` section at your workspace root explaining, to any coding agent that reads it (Claude Code and
others that follow the `AGENTS.md` convention), how `@rbxts/lunit` tests are structured, the
`@Tag("Studio")`/`@Tag("Lune")` convention above, the exact command-line invocation above (with this
machine's launcher path filled in) for verifying its work, and why it shouldn't try to hand-roll a runner
invocation instead (see [Lune profile](#lune-profile) for why that doesn't work). This is the one thing the
extension writes into your project rather than its own storage -- unlike everything else here, it's meant to
be committed and read by tools that only look at the project, not VS Code's internals. Opt-in only; nothing
is written automatically. Re-running the command updates only the marked section it owns, leaving the rest of
an existing `AGENTS.md` untouched.

## Result reporting

Both profiles run each discovered test class through its own `TestRunner.fromClasses([cls])` call (instead
of one shared runner across every class) so a result can always be attributed back to the right class —
nothing in Lunit's per-test data otherwise names the owning class. Within a class, results are collected via
the `onTestEnd(label, result)` reporter hook (keeping only the last call per exact label) rather than
`TestRunResult.tests`: that Map's `.forEach()`/`.get()` turned out to only work at call sites the TypeScript
compiler itself rewrites — real methods, not compile-time-only macros, needed for a hand-written Luau script
to call them — confirmed by running this exact pattern against Lunit's own compiled self-tests. Also worth
knowing if you're reading `src/luneScriptTemplate.ts` / `src/bootstrapTemplate.ts`: `reporter?.onTestEnd?.(...)`
compiles to a colon call, so the callback receives the reporter table itself as an implicit first argument
ahead of `(label, result)` — easy to miss since it silently shifts every argument by one instead of erroring.

Each result is encoded as one line, tagged with an internal marker and base64-encoding the class name,
label and error message (so arbitrary text can't corrupt the line), interleaved with Lunit's normal
`print()`-based tree report -- both show up in the **Lunit** output channel (**Lunit: Show Test Output**) and
the Test Results panel for any run, which is useful for debugging even though only the tagged lines drive
the Test Explorer's pass/fail state. A known, narrow gap: `@Repeat`'s real semantics are "any iteration
failing fails the test," but "last `onTestEnd` call wins" (this project's aggregation rule, chosen because
the Map-based alternative doesn't work at all) can show a test that fails then later passes as passed. This
does not affect plain `@Test` methods, `@Each` rows, or `@Retry`, whose own semantics are exactly "last
attempt wins."

## Settings

See `lunit.*` and `lunit.studio.*` in Settings (search "Lunit") — every command and path is configurable,
including `${workspaceFolder}` / `${outDir}` / `${placeFile}` token substitution in command strings.

For live-sync module isolation, supported layouts, bridge upgrades and validation, see [Studio live-sync isolation](docs/live-sync.md).

### F5 debugging

This repository disables `debug.javascript.enableNetworkView` in
`.vscode/settings.json`. On VS Code 1.137.0, enabling that debugger feature
reproduced an extension-host startup crash (exit code 134), before Lunit
activation. With it disabled, an F5 smoke test activated v0.3.1 and opened a
`.test.tsx` file successfully. This affects the debugger's Network view only;
normal debugging and Lunit's HTTP live-sync bridge remain enabled.
