# Studio live-sync isolation

Each job takes one detached snapshot of the place's ModuleScripts and their
container ancestry, then maps original test candidates into it. Nothing is
parented to the DataModel, and no Script or LocalScript is copied or activated --
one standing in a module's ancestry becomes a plain same-named Folder. Discovery
still scans original place descendants for `.test`/`.spec`, excluding immediate
children of `forks`. Plugin and PluginDebugService descendants are excluded. This preserves existing discovery scope, including nested
packages; it does not establish which VS Code workspace owns the open place.

The loader compiles snapshotted Source with `loadstring`, supplies the cloned
`script`, and caches one result (or load error) per module for the run. Relative
imports traverse the snapshot. Absolute imports may navigate real services;
`require` maps their original ModuleScript target into the same snapshot. Unknown
module targets and numeric asset requires fail rather than using native cached
exports. Services remain real Roblox services. Roblox string paths (`./`, `../`,
`@self/`, `@game/`) resolve against the calling module's snapshot, without falling
back to native require. A single `nil` export is cached normally, including
UI Labs type-only modules. Load errors name the dependency chain.
See [Roblox require semantics](https://create.roblox.com/docs/reference/engine/globals/LuaGlobals#require).

RuntimeLib itself and its Promise dependency use this loader. RuntimeLib's
`getModule` walks ancestor `node_modules` folders, while `import` registers
modules in `_G` and maintains its own loading/registration tables. The job gives
all modules one fresh `_G` and `shared`; its RuntimeLib import wrapper normalizes
original contexts and targets before registration. Lunit decorators and package
exports, including React wrappers and renderer dependencies, consequently use one
cache and one identity within the run. The implementation was traced against
[upstream RuntimeLib](https://github.com/roblox-ts/roblox-ts/blob/master/include/RuntimeLib.lua).
No consumer RuntimeLib or test files are rewritten.

## Boundaries

- Exactly one discovered RuntimeLib and one `@rbxts/lunit` are supported. Multiple
  independent runtimes/framework copies fail with an explicit diagnostic.
- Module ancestors must be Folders, ModuleScripts, Scripts/LocalScripts, direct
  DataModel children representing service roots, or the nested engine containers
  `StarterPlayerScripts` and `StarterCharacterScripts` (where roblox-ts game
  projects keep client code). Every one of these except a ModuleScript is
  snapshotted as a same-named Folder -- a Script holding helper modules is
  ordinary Roblox, and a Folder stand-in preserves the hierarchy require-by-path
  needs without copying or activating the Script itself. Require-by-path and
  absolute `game:GetService(...)` paths both resolve into the snapshot.
- A module under any other ancestor (a Model, a Tool, an arbitrary instance
  class) is left out of the snapshot rather than failing the run: the scan covers
  every module in the place, so an unrelated tree must not be able to abort a run
  that never needed it. Those modules are reported once as a capped warning
  (`N module(s) skipped (unsupported ancestor): ...`). Being skipped is only ever
  a warning while nothing needs the module -- a test that sits under such an
  ancestor is reported as that test failing to load, an import of a skipped module
  fails with the explicit diagnostic and the dependency chain that reached it, and
  a skipped RuntimeLib or `@rbxts/lunit` still fails the whole run. Skipping never
  turns into a silently missing test.
- The snapshot contains module source, names, attributes and Folder structure;
  it is not a cloned world. Tests reading assets through `script` ancestry,
  relying on service class identity in that ancestry, or expecting the cloned
  script to be a descendant of the real game are outside this supported layout.
  Real service paths remain available. Missing asset children can cause a wait;
  the timeout/draining limitation below applies.
- This is an import environment, not a sandbox. Modules must use the supplied
  require/global environment. Code deliberately retrieving another environment,
  external cached callbacks/exports, dynamically created modules, and native
  asset requires and unrecognized string-path prefixes are unsupported. Missing snapshot imports fail clearly.
- Real service mutations, event connections, Instances created by tests, and
  external resources still require normal test teardown. The loader cannot
  enumerate/disconnect arbitrary service callbacks. The job reports this boundary
  in its output. Scheduled tasks and coroutines created through the supplied
  task/coroutine APIs are tracked and cancelled at cleanup.

## Ownership, cancellation and timeout

The bridge delivers a job only once. Until its result acknowledges completion,
other runs are refused and a busy Studio continues to count as connected, avoiding
a fallback launch just because the plugin is busy rather than polling.

Cancellation or timeout before delivery drops the job. After delivery, it ends
the VS Code wait but **does not interrupt the Studio tests**: the acknowledgement
lock remains until execution finishes and cleanup runs. This drain policy avoids
racing module destruction against executing tests. The plugin retries result
submission after transient HTTP errors. The job uses protected cleanup on load
and execution failures; plugin unload cancels the job thread before invoking
cleanup. On normal completion (including caught load/test errors), the job first
yields once through the host scheduler so Promise resolvers that synchronously
resumed an awaiter can finish their finally callbacks before the environment is
closed. Cleanup timing includes this scheduler turn. Cleanup cancels owned tasks,
destroys the detached tree, and clears
loader maps, caches and globals.

A permanently hung test, lost Studio process, plugin unload before acknowledgement,
or lost response to the initial poll can leave the bridge locked. There is no
forced-reset action: resetting while execution might still be active would violate
the isolation guarantee. Resolve the hung work before reloading the extension.
Do not use non-yielding infinite loops to test cancellation. This change provides
safe draining, not preemptive cancellation of arbitrary Roblox work.

Compile and the existing `syncDelaySeconds` delay are unchanged. Fresh snapshots
contain the source present in Studio at snapshot time; they do not prove Rojo has
finished syncing. Adjust the existing delay when needed.

## Bridge update

Run **Lunit: Install Roblox Studio Live-Sync Plugin** after updating the extension.
The generated job requires the new plugin's ownership argument and reports an
error if the old plugin is still loaded. Reinstalling writes the plugin file;
it does not guarantee Studio hot-reloads an already-loaded local plugin. Reload
that plugin through Studio's plugin debugging tools with the same Studio open.
Enable **Plugin Debugging Enabled** in Studio settings. Replace the bridge script
in PluginDebugService with the newly generated source, then right-click its plugin
and select **Save and Reload Plugin**. Ensure only one Lunit bridge is polling.
Roblox documents this workflow in
[Studio plugins](https://create.roblox.com/docs/studio/plugins).
Do this while no run is executing; Studio and the place stay open, and no Play
mode is needed. This upgrade workflow still needs manual validation here.

## Automated validation

The repository previously had a TypeScript compile script and no test suite.

- `npm test`: compile plus three Node HTTP tests covering pre-cancellation,
  cancellation/timeout before and after delivery, duplicate polls, unrelated
  results, busy detection and subsequent runs after acknowledgement.
- `npm run test:luau`: compile plus the generated job in Lune with its Roblox
  Instance model and a synthetic RuntimeLib/Lunit fixture. Requires Lune 0.10.5;
  set `LUNE_EXE` to the executable path when the project has no Rokit manifest.
  The fixture runs 100 tests repeatedly in one VM, edits test/helper/transitive
  sources, checks absolute/relative dependency identity and fresh global/module
  state, tests load and runner failures, rejects unsupported imports/layouts,
  verifies background-task cancellation, unchanged original descendants, detached
  tree release and no discovery accumulation. It also compiles the plugin Luau.

Both commands passed on 2026-09-11. The harness uses a small simulated framework;
it does not validate native Studio loadstring permissions, actual Lunit or React,
plugin unload/network behavior, or Roblox's native require cache.

Successful 100-test Lune harness runs with the string-path and nil-export
regressions measured setup 2.27-2.70 ms, loading 9.40-9.76 ms, execution
1.58-1.71 ms and cleanup 0.09-0.10 ms. These are synthetic
local measurements, not Studio estimates. No actual Studio before/after benchmark
was performed. Logs use `[lunit] live-sync` and report the four phases separately.
Loading is the time spent in initial framework/test imports; imports initiated
inside test methods are included in execution time. All timings are wall elapsed
`os.clock()` measurements and include waits within their phase.

## Studio import verification (2026-09-11)

Read-only project-source diagnostics in the existing Edit-mode Studio reproduced
two loader incompatibilities: Ripple imports `@self/config`, and UI Labs' Types
module returns a single nil. A detached native ModuleScript probe confirmed Roblox
accepts that nil export. After fixing these cases, all 42 test modules in the
synced React Clean UI project imported successfully on two consecutive jobs,
including actual RuntimeLib, Lunit, Ripple, UI Labs, React and renderer dependencies.
Test method execution was deliberately disabled for these import diagnostics;
this is not a claim that the full test suite passed. The second run measured
setup 23.19 ms, loading 89.73 ms and cleanup 0.55 ms.

The Lune regression fixture also covers all four string prefixes, repeated parent
traversal, alias/Instance identity, per-run nil caching, missing paths, module
names in errors, and rejection of zero/multiple return values.

## Pending manual Studio checks

1. Before upgrading, keep an approximately 100-test project synced into an open
   Studio in Edit mode. Record five repeated Test Explorer runs and total elapsed
   time. Record Studio, roblox-ts, Lunit, React/renderer versions and module count.
   Save the baseline output; old code has no phase timing instrumentation.
2. Install/activate the new bridge once. Leave Studio open and out of Play mode.
   Run the same suite five times. Record the four `[lunit] live-sync` phase timings
   and total VS Code elapsed time, reporting cold and warm runs separately.
3. Edit a test assertion, compile/sync, then rerun and verify the changed outcome.
   Repeat independently for its imported helper and a helper's dependency or
   component. Inspect Source in Studio before each run to separate sync latency.
4. Have two tests import the same helper by relative and absolute paths. Have it
   return a table and increment a module counter. Assert both see the same table
   and counter progression, then assert the next run starts the counter fresh.
   Repeat using roblox-ts package imports through `TS.getModule`.
5. Run a real React hook component through the project's normal renderer, update
   the component, rerun, and verify changed output with no duplicate-React/hook
   errors. Unmount in teardown. Verify Lunit decorators register each test once.
6. Introduce a syntax/load error, then an assertion failure and a runner exception.
   Check the output reports errors, correct the source, and verify the next run
   succeeds. Confirm selected tests, tags and reporting retain existing behavior.
7. Use a finite yielding test (e.g. five seconds). Cancel after delivery, then try
   another run immediately: it must report pending cleanup. After the first test
   finishes, rerun successfully. Repeat with a shorter live-sync timeout. Cancel
   during compile/sync delay and confirm no Studio job is submitted.
8. Exercise plugin unload during a yielding job and transient HTTP result failure.
   Confirm unload stops owned tasks before destroying the tree and result retries
   do not execute tests twice. Observe the documented lock on missing acknowledgement.
9. Across successes and failures verify original instance identity/Source is
   unchanged, test counts stay constant, and Studio memory does not grow from
   retained detached trees. Detached trees never appear in Explorer; inspect
   owner cleanup in a plugin debugger and use Studio memory tools for retention.
   Explicitly disconnect service callbacks/clean external resources in teardown.

### Promise finalization regression (2026-09-11)

A user's full Studio suite reached cleanup, then emitted `isolation: run has
ended` from RuntimeLib Promise `_finalize`. The awaiter had resumed the job
synchronously, allowing it to close its own environment before the resolver
returned. A scheduler yield before cleanup fixes that ordering without removing
the closed-run guards. The asynchronous Lune fixture resumes the job from an
owned coroutine and attempts coroutine/task finalization after that resume; it
reproduced the error before the fix and passes afterward. It also continues to
verify that pending background tasks are cancelled. Full Studio revalidation of
this finalization fix is pending because no Studio was connected to the inspection
tools during this check. The per-run script changes do not require another bridge
plugin reinstall; reload the extension debug session to use the rebuilt script.
