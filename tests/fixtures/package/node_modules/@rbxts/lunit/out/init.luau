-- Compiled with roblox-ts v3.0.0
local TS = _G[script]
local exports = {}
exports.TestRunner = TS.import(script, script, "lib", "runner", "runner").TestRunner
local _decorator = TS.import(script, script, "lib", "decorator")
exports.Test = _decorator.Test
exports.Timeout = _decorator.Timeout
exports.Disabled = _decorator.Disabled
exports.DisplayName = _decorator.DisplayName
exports.Order = _decorator.Order
exports.After = _decorator.After
exports.AfterAll = _decorator.AfterAll
exports.AfterEach = _decorator.AfterEach
exports.Before = _decorator.Before
exports.BeforeAll = _decorator.BeforeAll
exports.BeforeEach = _decorator.BeforeEach
exports.Tag = _decorator.Tag
exports.Negated = _decorator.Negated
exports.Decorators = TS.import(script, script, "lib", "decorator")
exports.Assert = TS.import(script, script, "lib", "assert").default
exports.Runtime = TS.import(script, script, "lib", "runtime").Runtime
return exports
