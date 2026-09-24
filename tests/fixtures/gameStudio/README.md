# Game-project fixture for the standalone Studio run

A small roblox-ts `--type game` project with two source roots, `src/` and
`tests/`, compiled with `rbxtsc --type game --rojo dev.project.json` (see
package.json's `build` script). `dev.project.json` puts each root beside the
other in the Rojo tree:

    ReplicatedStorage.Common                          <- out/src/shared
    ReplicatedStorage.Tests.Common                    <- out/tests/shared
    StarterPlayer.StarterPlayerScripts.Common         <- out/src/client
    StarterPlayer.StarterPlayerScripts.Tests.Common   <- out/tests/client

`out/` is the compiled output as roblox-ts emits it for that tree: a test
imports its source with `TS.import(script, script.Parent.Parent.Parent,
"Common", ...)`, which only resolves when the compiled test sits exactly
where dev.project.json puts it. That is what tests/studioGame.cjs checks: the
"Run in Roblox Studio" fallback must build the place from dev.project.json
rather than relocate the output into a package-style tree.

`include/` and `node_modules/` hold the same RuntimeLib stand-in and Lunit
stub as tests/fixtures/game; `node_modules/roblox-ts/include` exists only so
the old package-style layout can still be built here, as the negative control.
