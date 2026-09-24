# Changelog

## 0.7.1

### Fixed

- **"Run in Roblox Studio" without a connected Rojo-synced Studio now works for roblox-ts game
  projects.** The standalone fallback used to mount the compiled output under an invented
  `ReplicatedStorage.rbxts_include.node_modules.@rbxts.<package>` tree, as if every project were an rbxts
  package. A `--type game` project is compiled *for* the Rojo tree its `rbxtsc --rojo <file>` names (a test
  under `tests/` importing from `src/` becomes `TS.import(script, script.Parent.Parent.Parent, "Common", ...)`),
  so in the relocated tree every such import hung on `WaitForChild("Common")` ("Infinite yield possible").
  The place is now built from the project's own Rojo file: **`lunit.studio.rojoProject`** if set, else the
  `--rojo` flag in the compile command (followed through `npm run` scripts), else `lunit.lune.projectFile` or
  the one `*.project.json` at the workspace root. The generated bootstrap script still runs via
  `--runScriptFile`, so nothing is injected into the place. If no project file can be found, or `rojo build`
  fails, the run stops with exit code 2 and a message saying to connect Rojo or set `lunit.studio.rojoProject`,
  instead of building a place that cannot resolve requires. Only a real rbxts package (`package.json`
  `main`/`types` under the output directory, or `script`-relative compiled output) keeps the self-contained
  package layout. `${projectFile}` in `lunit.studio.buildPlaceCommand` now names whichever project was chosen.
- The command line exits with code 2 (not 1) when a Studio run could not start at all, and the Test Explorer
  shows that reason on each requested test.

## 0.7.0

### Added

- **Parallel Lune runs.** **Run with Lune** and **Run with Lune (Full)** now run tests in a bounded pool
  of independent Lune processes instead of one. The project is compiled once, one discovery process
  lists every test module's compiled Lunit metadata, and the run is split into *blocks*: one test module
  per block by default, which keeps each class's method ordering, lifecycle hooks and shared state
  exactly as before. A freed worker takes the next pending block at once. Default worker count:
  min(32, logical CPUs), capped by the number of blocks; `lunit.lune.parallel.workers` sets it
  (`64` is allowed) and the command line takes `--workers N` for one run. `--workers 1` runs the blocks
  one after another, still isolated.
  - A class-level **`@Tag("Parallel")`** opts a class into one block per test method and per `@Each`
    row, each in a fresh Lune VM and class instance with its own `@BeforeEach`/`@AfterEach`. A class
    with `@BeforeAll`/`@AfterAll`, `@Order`, or a method that is both a test and a hook is rejected:
    its tests are reported as errored with the reason, and the run output says so.
  - **`lunit.lune.parallel.dependencyGroups`** names modules that must share one Lune process in
    prerequisite-first order; a group takes precedence over `@Tag("Parallel")`. Selecting a test in a
    group runs the modules before its module in full, and the output explains the extra execution.
    Unknown, ambiguous or repeated names stop the run with an error before anything is scheduled.
  - The Test Explorer reports queued, running, passed, failed, skipped and errored states as blocks
    finish. A parameterized method's rows are folded onto its item: any failing row fails it and the
    message names the row. Selecting the method runs every one of its rows.
  - Worker output streams to the Lunit output channel prefixed with its block id (`[#12]`), with a
    `started` and `PASS`/`FAIL`/`ERROR` line per block, then a closing summary: block and worker
    counts, wall time (compile and discovery separately), the longest block, and the blocks over
    10 s (an optimization target, never a timeout).
  - A worker that crashes, is killed, reports no block summary, or reports a summary that disagrees
    with its result lines errors every test of that block. A test no block reported is errored, never
    passed by omission. Cancelling stops the running workers (whole process trees), starts nothing
    else, and reports the rest as not run.
  - Generated scripts and job files live in a per-run directory, so concurrent runs never overwrite
    each other's files.
  - **`lunit.lune.parallel.enabled: false`** restores the previous behaviour: every module in one Lune
    process with one shared module cache.
- The command line gets `--workers <n>` (Lune only) and reports the block, worker and wall-time
  figures in its summary (`lune` in `--json`).

### Changed

- The Lune profile runs only the selected tests (and their dependency prerequisites) rather than the
  whole suite, and a test whose compiled module failed to load is errored with the load error. Slow
  tests and Studio-tagged tests are left out by the planner, from the compiled metadata, rather than
  inside the Lune script. "Run in Roblox Studio" is unchanged.

## 0.6.0

### Added

- **Slow tests and a "Run with Lune (Full)" profile.** List tags in the new `lunit.lune.slowTags` setting
  (default `[]`), e.g. `["Slow"]`. A test carrying one of them, on its class or the method (matched
  case-insensitively), is left out of **Run with Lune** and **Run in Roblox Studio**. **Run with Lune (Full)**
  runs everything that runs under Lune, slow tests included. The Full profile is only registered while the
  setting names a tag, so projects that don't use it see no change.
  - Running a folder, file or class leaves its slow tests out without reporting them as skipped or failed.
    The run output says how many: "Left out 12 slow test(s): run with Lune (Full)." A class whose only tests
    are slow is reported the same way, not as "no tests found".
  - Running a single slow test directly runs it, under either Lune profile.
  - The command line gets `--full` (implies `--lune`). `--lune` and `--studio` leave slow tests out, and
    the summary (`slowLeftOut` in `--json`) says how many.

### Changed

- **Game projects run much faster under Lune.** The virtual DataModel used to load each module with a
  custom environment table, and Luau switches off its fast builtin calls (`math`, `bit32`, `buffer`, ...)
  for code running in a custom environment. `script`, `game`, `require`, the Roblox datatypes and the other
  globals now reach each module as locals instead. On one project's 552-test suite a full Lune run went from
  423 s to 211 s (its own hand-written Lune runner takes 200 s), and single compute-heavy modules take about
  half the time (44.5 s → 24.5 s, 6.1 s → 3.1 s). Two edge cases change: a module
  with more than roughly 170 top-level locals hits Luau's 200-locals limit under Lune only, and a module
  assigning an undeclared global now writes to Lune's globals rather than a per-module table.
- The package-project Lune runner applies the slow-test rule too. It still applies no other tag rule.

## 0.5.1

### Fixed

- **"Run in Roblox Studio" no longer runs tests tagged `@Tag("Lune")`.** The Studio profile already
  hid them in VS Code, but the Studio side (live-sync job and standalone bootstrap) still ran every test
  class it found. In a project with long Lune-only suites, Studio stopped responding, the live-sync run
  timed out after 30 s, and no results came back. Both Studio modes now skip class-level and
  method-level `@Tag("Lune")` tests, the same way the Lune profile skips `@Tag("Studio")`. A
  class-level tag is recognised in the compiled source, so that module is not loaded at all. Tags
  match case-insensitively, as discovery does. All three runners share one tag filter.
- Tests a profile leaves out are reported as **skipped** when a run covers them, never as failed or
  errored.

### Changed

- When a run covers a selection rather than every test, Studio runs just the selected classes and
  methods.
- Studio yields a frame between test classes at least every 50 ms. A live-sync run stops starting new
  classes once `lunit.studio.liveSync.timeoutSeconds` has passed, instead of carrying on after VS Code
  has given up.
- The Lune game runner now matches `@Tag("Studio")` case-insensitively, and a class-level tag with
  several values (`@Tag("Studio", "Slow")`) is recognised in the compiled source.

No plugin reinstall is needed: the live-sync job is sent fresh with every run.
