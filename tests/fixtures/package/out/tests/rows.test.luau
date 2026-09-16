-- Compiled with roblox-ts v3.0.0 (written by hand in that shape)
-- A @Tag("Parallel") class: every method and every @Each row is an
-- independent block in a fresh VM and class instance. The BeforeEach /
-- AfterEach fixture must run inside each block; the "rows" method's third
-- row fails on purpose so the Test Explorer item for the method must fail.
local TS = _G[script]
local _lunit = TS.import(script, TS.getModule(script, "@rbxts", "lunit").out)
local Assert = _lunit.Assert
local AfterEach = _lunit.AfterEach
local BeforeEach = _lunit.BeforeEach
local Tag = _lunit.Tag
local Test = _lunit.Test
local Each = _lunit.Decorators.Each
local counter = TS.import(script, script.Parent.Parent, "shared", "counter")
local RowTests
do
	RowTests = setmetatable({}, {
		__tostring = function()
			return "RowTests"
		end,
	})
	RowTests.__index = RowTests
	function RowTests.new(...)
		local self = setmetatable({}, RowTests)
		return self:constructor(...) or self
	end
	function RowTests:constructor()
		self.ready = false
		self.seen = 0
	end
	function RowTests:setUp()
		self.ready = true
		counter.bump()
	end
	function RowTests:tearDown()
		self.ready = false
	end
	function RowTests:plain()
		Assert["true"](Assert, self.ready, "BeforeEach must have run for this case")
		-- Fresh VM per case: nothing else has bumped the shared module counter.
		Assert:equal(counter.value(), 1, "each case must start from a fresh module cache")
	end
	function RowTests:rows(a, b, expected)
		Assert["true"](Assert, self.ready, "BeforeEach must have run for this row")
		Assert:equal(counter.value(), 1, "each row must start from a fresh module cache")
		Assert:equal(a + b, expected, `{a} + {b} should be {expected}`)
	end
	function RowTests:sweep()
		Assert["true"](Assert, self.ready)
	end
	local _descriptor = BeforeEach(RowTests, "setUp", {
		value = RowTests.setUp,
	})
	if _descriptor then
		RowTests.setUp = _descriptor.value
	end
	local _descriptor_1 = AfterEach(RowTests, "tearDown", {
		value = RowTests.tearDown,
	})
	if _descriptor_1 then
		RowTests.tearDown = _descriptor_1.value
	end
	local _descriptor_2 = Test(RowTests, "plain", {
		value = RowTests.plain,
	})
	if _descriptor_2 then
		RowTests.plain = _descriptor_2.value
	end
	local _decorator = Each({ { 1, 2, 3 }, { 2, 2, 4 }, { 2, 2, 5 } })
	local _descriptor_3 = Test(RowTests, "rows", {
		value = RowTests.rows,
	})
	if _descriptor_3 then
		RowTests.rows = _descriptor_3.value
	end
	local _descriptor_4 = _decorator(RowTests, "rows", {
		value = RowTests.rows,
	})
	if _descriptor_4 then
		RowTests.rows = _descriptor_4.value
	end
	local _decorator_1 = Tag("Slow")
	local _descriptor_5 = Test(RowTests, "sweep", {
		value = RowTests.sweep,
	})
	if _descriptor_5 then
		RowTests.sweep = _descriptor_5.value
	end
	local _descriptor_6 = _decorator_1(RowTests, "sweep", {
		value = RowTests.sweep,
	})
	if _descriptor_6 then
		RowTests.sweep = _descriptor_6.value
	end
	RowTests = Tag("Parallel")(RowTests) or RowTests
end
return RowTests
