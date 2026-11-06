# Changelog

## 0.10.1

### Fixed

- **`task.defer`/`task.delay` of the running thread works in live-sync runs.** Code that defers its own thread
  with a value and then yields (`task.defer(coroutine.running(), result)` from a callback that may answer
  before the thread has yielded) failed with "cannot defer non-suspended coroutine with arguments". The test
  then waited for ever and held the run until the live-sync timeout. The bridge's task shims now only track
  threads and call the engine's own `task.*`. Where the engine refuses to defer or delay a non-suspended
  thread with arguments, the shim queues the resume until the thread has yielded. Legacy `spawn(fn)` now
  runs `fn` later, as in Roblox, rather than at once, and a `coroutine.wrap` error is passed on as raised.
- **A test that yields and is never resumed fails on its own.** Each test now runs under
  **`lunit.studio.testTimeoutSeconds`** (default 120) in live-sync runs too, not just for the heartbeat. A test
  still waiting after that fails with `timed out after N s (lunit.studio.testTimeoutSeconds): still yielded
  at <module>:<line>`. Its threads are cancelled, its `afterEach` runs, and the run goes on with the next
  test, instead of one stuck test using up the whole run's live-sync timeout.
- **A bridge error fails the test it happened for.** An error raised inside the bridge's task shims, in a
  thread a test started, now fails that test at once with the error and its stack, and the run continues.
  Before, it only reached Studio's Output while the test waited.

## 0.10.0

A long, legitimate test no longer fails a whole Studio run as "Roblox Studio stopped responding". **Reinstall
the Studio plugin** (Lunit: Install Roblox Studio Live-Sync Plugin, then restart Studio or reload the
plugin): runs through a 0.9.0 plugin stop with "the loaded Studio bridge is outdated".

### Fixed

- **A busy Studio is told apart from a dead one.** A synchronous test holds Studio's main thread, so the
  plugin's heartbeat cannot go out. In 0.9.0, any test over 15 s released the run and errored every
  test. Now:
  - The job announces each test (and `@Each` row) as it starts, and the plugin sends a heartbeat naming
    it before the test begins.
  - While a test is running, or while a Roblox Studio process is still running on the machine, the
    silence may last **`lunit.studio.testTimeoutSeconds`** (new, default 120).
  - A Studio that has actually closed (no Studio process) is still released at about 15 s, and so is a
    Studio restart or plugin reload (new session id).
  - The job also yields between tests, not just between classes, once it has held Studio for 50 ms, so
    the heartbeat gets through between the cases of a long class.
- **A released run keeps the results already in.** Heartbeats now stream the run's output. A run
  released partway reports what had passed and failed by then, and errors only the unfinished tests, with
  the reason (for example `run released after PlacePreviewOracleTests > renders ran 120s+ without a
  heartbeat`), instead of "0 passed, N errored".
- **The message names the culprit**: the last test Studio reported, and how long it had been running.
- The plugin no longer abandons a job because a blocking test delayed its heartbeats; only heartbeats
  that actually fail for 10 s count as VS Code being gone.

### Added

- **Studio results stream into the Test Explorer as each test finishes** (live-sync). A test now goes from
  queued to running when Studio starts it and gets its verdict as soon as it finishes, instead of every
  test spinning until the run ends. The plugin sends results in batches (every 250 ms or 50 lines) with
  its heartbeat, with duration and failure message. `@Each` rows map to their test, which turns failed as
  soon as one row fails, and a retried test shows its latest try. The end-of-run report is still the final
  word: a result already shown is not reported again, and when the final report disagrees (a failure in
  teardown after the test reported passed, say) the final result wins and its message says so. A run
  that is cancelled, times out or loses Studio keeps every result that streamed in; a cancelled run
  leaves the rest skipped, the others error the rest with the reason.
- **`lunit-cli --studio` prints each result line as it arrives** (the same `PASS`/`FAIL` lines as before),
  and the closing summary no longer repeats them. `--json` is unchanged; each entry gains `streamed: true`
  when it was reported live.
- **`lunit.studio.slowTestWarningSeconds`** (default 5, 0 to turn off): any live-sync test that takes this
  long gets a `WARNING: slow test <class> > <test> took N s` line, so it can be tagged `Slow` or made to
  yield before it causes trouble.

## 0.9.0

A Studio live-sync run can no longer hang for good, and one that goes wrong no longer needs a restart of
Studio or a reload of VS Code to recover. **Reinstall the Studio plugin** (Lunit: Install Roblox Studio
Live-Sync Plugin, then restart Studio or reload the plugin): runs through an older loaded plugin stop with
"the loaded Studio bridge is outdated".

### Fixed

- **A require that never returns no longer stalls every run.** Each test module now gets
  **`lunit.studio.liveSync.loadTimeoutSeconds`** (new, default 10) to load. A module still loading then is
  cancelled and reported as failing to load, for example `timed out after 10 s loading <module> (waiting
  on child "animal-poses.generated" at <module>:<line>)`. The rest
  of the run goes ahead, and other tests importing the same module fail at once instead of waiting
  again. `lunit.studio.liveSync.timeoutSeconds` is now a whole-run watchdog: no module starts after it,
  and a test class still running then is cancelled.
- **Large modules are no longer skipped.** The snapshot used to copy each module's `Source`, which Studio
  refuses above about 200,000 characters, so a large generated module was left out (and reported as an
  "unsupported ancestor"). The loader already compiles from its own copy of the source, so the clone's
  `Source` stays empty and modules of any size load.
- **A skipped module fails instead of hanging.** A module still left out of the snapshot (one under a
  Model, say) gets a stub in its place, so `WaitForChild` and `TS.import` find it and requiring it fails
  with the reason. The warning now gives that reason and the module's source length, not "unsupported
  ancestor".
- **Non-module children are there to wait for.** A LocalScript, Script, Actor, value object, RemoteEvent or
  Model next to snapshotted modules gets an empty placeholder of the same class and name, disabled, with no
  source, and value objects keep their `Value`. Packages such as smartbone, which wait for
  `Dependencies.Runtime`, now load. A `TS.import` path part that is not in the snapshot fails at once with
  `<path> has no child "<name>"`.
- **The run lock always releases.** Stop in the Testing view, Ctrl+C on the CLI and the timeout now release
  the run at once, even when Studio never reports back, and the plugin abandons the job at its next
  heartbeat (about once a second). Closing or restarting Studio, or reloading its plugin, releases a job
  that Studio was running. A run is no longer refused with "still executing or awaiting cleanup
  acknowledgement" until VS Code is reloaded.
- **A filtered Studio run loads only the test modules holding the selected tests**, so a broken module
  elsewhere in the place cannot affect it.

### Added

- **`lunit-cli --cancel`** (alias `--reset`): cancels any run in progress through this workspace's VS Code
  window and releases its live-sync run. It runs no tests.
- **Lunit: Cancel and Release the Roblox Studio Live-Sync Run** does the same from the Command Palette.

## 0.8.1

### Fixed

- **High CPU in WMI Provider Host (`WmiPrvSE.exe`) on Windows.** The status bar checked for `rojo serve` every
  2 seconds by starting PowerShell and querying WMI, with a 1.5 s timeout. When WMI was slow, the killed
  PowerShell left its query running and new ones piled up, more so with several VS Code windows open. The
  result is now cached for 15 seconds, only one check runs at a time, a cheap `tasklist` runs first and WMI
  is only asked for the command line when a `rojo.exe` exists.

## 0.8.0

### Added

- **`lunit.studio.debug`** (default `false`): the Studio plugin no longer prints its status lines
  ("Connecting automatically...", "Looking for VS Code workspaces...", "Automatically selected VS Code: ...",
  "Bridge started/stopped" and the like) to Studio's Output window unless this is on. Studio runs a copy of
  every plugin in each Play server and client, so these lines used to repeat on every Play. A startup scan
  that finds no VS Code window (a Play client, or a Studio window without the extension) no longer warns
  either; a **Refresh** that finds nothing still does, and real failures (a selected window that cannot be
  reached, a bridge error) always warn. The setting is baked into the plugin file: changing it rewrites the
  installed plugin, and Studio picks it up after a restart or a plugin reload.

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
