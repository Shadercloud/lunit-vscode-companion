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
and polls quietly in the background from then on -- no per-project setup, nothing to reinstall later.

**Without it**, "Run in Roblox Studio" still works, but it builds a fresh place and launches a brand-new
Studio process on *every single run* -- slow, and useless if you already have Studio open with your project
live-synced via `rojo serve`. **With it installed** (and Studio open with your project synced), tests run
directly in that already-open instance instead: faster, and it doesn't even require Play mode.

Check whether it's connected any time via the **Lunit: Studio connected / not connected** status bar item
(bottom right) -- click it for details, including a one-click install if it's missing. See
[Roblox Studio profile](#roblox-studio-profile) below for exactly how the two modes differ.

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
**Run in Roblox Studio** -- and results show up right there in the tree. No project-side configuration,
Rojo project file, or test-runner script needed; see [What it does](#what-it-does) below for how each
profile actually runs things.

## What it does

- Scans `**/*.{test,spec}.{ts,tsx}` (configurable) with the TypeScript compiler API and builds a
  file → class → test tree from `@Test`-decorated methods, honoring `@DisplayName`, `@Tag`, `@Skip`, `@Only`
  and `@Each` where statically determinable.
- **Run with Lune**: compiles the project (`npx rbxtsc` by default), regenerates a small generated Lune
  entry script, and runs it, reflecting pass/fail/skip back onto the tree with inline failure messages.
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

Works out of the box if `npx rbxtsc` and Lune resolve in your project. Defaults to `testsRoot = ${workspaceFolder}`
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
project file of its own (see above); the common case for a package developed and tested on its own, e.g. a
single library repo with no dev workspace around it. Zero-config by
design here too: no `default.project.json`, no hand-edited bootstrap script, nothing to add to the project
being tested. Builds its own throwaway place and launches a real Studio process via Studio's own documented
CLI automation flags (`--task RunScript --localPlaceFile ... --runScriptFile ... --outputFile ...
--quitAfterExecution`), no companion plugin needed for this mode. Slower (a fresh Studio has to launch and
load), which is exactly why live-sync mode is preferred whenever it's available. On every run in this mode,
the extension:

1. Compiles the project (unless `lunit.skipCompile`).
2. Generates its own small, self-contained Rojo project (in this extension's storage directory, always
   regenerated) mapping just what's needed to run tests: `node_modules/roblox-ts/include` (the TS runtime),
   every `@scope` folder under `node_modules` that actually contains Luau content (not just `@rbxts` --
   e.g. `@rbxts/react` itself depends on `react-lua`'s internals published under a *different* scope,
   `@rbxts-js`), and the compiled package itself -- mounted *as if* it were just another dependency under its
   own scope, alongside its real siblings, which is what lets any test file's
   `import { X } from "@rbxts/whatever"` resolve correctly regardless of the consuming project's own Rojo
   setup (or lack of one -- library packages like `@rbxts/react-clean-ui` usually don't have their own
   `default.project.json`, since they're never built into a real place on their own).
3. Builds that into a place file with `rojo build` (override `lunit.studio.buildPlaceCommand` if you'd
   rather run tests against your project's *real* place -- see the note below).
4. Generates the bootstrap script (also in this extension's storage directory, always regenerated) that
   walks the synced tree for `*.test`/`*.spec` ModuleScripts and runs each one, and launches Studio against it.

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
- If you override `lunit.studio.buildPlaceCommand` to point at your own Rojo project instead (e.g. because a
  test needs your real game's services/config), the auto-generated bootstrap script's tree-shape assumptions
  won't match it -- point `lunit.studio.bootstrapScript` at your own script too in that case.
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
case of a test that should only run headlessly. No tag means it runs under both. This is enforced through two
VS Code `TestTag`s the extension assigns based on Lunit's own `@Tag` decorator (parsed statically, not at
runtime), one per profile.

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

## Using a coding agent to write tests

Run **Lunit: Add/Update Agent Instructions (AGENTS.md)** from the Command Palette to generate (or update) an
`AGENTS.md` section at your workspace root explaining, to any coding agent that reads it (Claude Code and
others that follow the `AGENTS.md` convention), how `@rbxts/lunit` tests are structured, the
`@Tag("Studio")`/`@Tag("Lune")` convention above, and why it shouldn't try to invoke the test runner itself
(see [Lune profile](#lune-profile) for why a hand-rolled invocation doesn't work). This is the one thing the
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
