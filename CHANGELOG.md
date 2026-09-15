# Changelog

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
