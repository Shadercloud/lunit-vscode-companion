-- Compiled with roblox-ts v3.0.0 (written by hand in that shape)
-- An ordinary test class: suite-level hooks, ordered methods and shared
-- state. It runs as one block, so everything here stays in one VM.
local TS = _G[script]
local _lunit = TS.import(script, TS.getModule(script, "@rbxts", "lunit").out)
local Assert = _lunit.Assert
local AfterAll = _lunit.AfterAll
local BeforeAll = _lunit.BeforeAll
local Order = _lunit.Order
local Test = _lunit.Test
local OrderedTests
do
	OrderedTests = setmetatable({}, {
		__tostring = function()
			return "OrderedTests"
		end,
	})
	OrderedTests.__index = OrderedTests
	function OrderedTests.new(...)
		local self = setmetatable({}, OrderedTests)
		return self:constructor(...) or self
	end
	function OrderedTests:constructor()
		self.log = {}
	end
	function OrderedTests:setUpAll()
		table.insert(self.log, "beforeAll")
	end
	function OrderedTests:tearDownAll()
		table.insert(self.log, "afterAll")
	end
	function OrderedTests:first()
		Assert:equal(#self.log, 1, "BeforeAll must have run once before the first test")
		table.insert(self.log, "first")
	end
	function OrderedTests:second()
		Assert:equal(self.log[2], "first", "second must run after first (@Order) in the same instance")
		table.insert(self.log, "second")
	end
	local _descriptor = BeforeAll(OrderedTests, "setUpAll", {
		value = OrderedTests.setUpAll,
	})
	if _descriptor then
		OrderedTests.setUpAll = _descriptor.value
	end
	local _descriptor_1 = AfterAll(OrderedTests, "tearDownAll", {
		value = OrderedTests.tearDownAll,
	})
	if _descriptor_1 then
		OrderedTests.tearDownAll = _descriptor_1.value
	end
	local _decorator = Order(1)
	local _descriptor_2 = Test(OrderedTests, "first", {
		value = OrderedTests.first,
	})
	if _descriptor_2 then
		OrderedTests.first = _descriptor_2.value
	end
	local _descriptor_3 = _decorator(OrderedTests, "first", {
		value = OrderedTests.first,
	})
	if _descriptor_3 then
		OrderedTests.first = _descriptor_3.value
	end
	local _decorator_1 = Order(2)
	local _descriptor_4 = Test(OrderedTests, "second", {
		value = OrderedTests.second,
	})
	if _descriptor_4 then
		OrderedTests.second = _descriptor_4.value
	end
	local _descriptor_5 = _decorator_1(OrderedTests, "second", {
		value = OrderedTests.second,
	})
	if _descriptor_5 then
		OrderedTests.second = _descriptor_5.value
	end
end
return OrderedTests
