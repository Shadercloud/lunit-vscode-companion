# Package-project fixture

A roblox-ts `--type package` layout the Lune regression tests (`tests/luneParallel.cjs`,
driven from `tests/runLuau.cjs`) run the generated package runner against, with the
**real** `@rbxts/lunit` 4.0.2 vendored under `node_modules/@rbxts/lunit` (its compiled
`out/*.luau` and `scripts/promise.luau`, MIT licensed) rather than a stand-in, so the
parallel profile's case splitting, `@Each` rows, lifecycle hooks and rejections are
checked against the framework's own runner.

`src/tests/` holds the TypeScript sources the extension's discovery reads (they are never
compiled here), and `out/` the matching test modules written by hand in the shape roblox-ts
emits for a package project (`local TS = _G[script]`, decorators applied as
`Test(Cls, "name", descriptor)`, `Cls = Tag("Parallel")(Cls) or Cls`). The command-line
check (`tests/luneCli.cjs`) copies the whole fixture to a temporary workspace and adds a
`.vscode/settings.json` there.

| Module | What it covers |
|---|---|
| `out/tests/ordered.test.luau` | An ordinary class: `@BeforeAll`/`@AfterAll`, `@Order`, shared state between methods. One block. |
| `out/tests/rows.test.luau` | `@Tag("Parallel")`: `@Each` rows, a plain method, `@BeforeEach`/`@AfterEach`, a `@Tag("Slow")` method, one row that fails on purpose. |
| `out/tests/badParallel.test.luau` | `@Tag("Parallel")` with `@BeforeAll` and `@Order`: rejected with a diagnostic. |
| `out/tests/hookTest.test.luau` | `@Tag("Parallel")` where a method is both `@Test` and `@AfterEach`: rejected. |
| `out/tests/group/setup.test.luau`, `consumer.test.luau` | A dependency group: `consumer` passes only after `setup` ran in the same VM (`shared/registry.luau`). |
| `out/tests/focused.test.luau` | `@Only` inside a Parallel class. |
| `out/tests/broken.test.luau` | Errors at load. |
