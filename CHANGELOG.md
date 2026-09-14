# Changelog

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
