-- A class-level @Tag("Parallel") class, exactly as roblox-ts compiles it:
-- one block per method and per @Each row, each in a fresh VM and instance,
-- with the BeforeEach/AfterEach fixture inside every case. The third row of
-- `rows` fails on purpose. `sweep` is slow.
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local counter = TS.import(script, game:GetService("ReplicatedStorage"), "Shared", "counter")

local function Tag(...)
	local tags = { ... }
	return function(cls)
		cls["lunit:class"] = { tags = tags }
		return cls
	end
end

local ParallelRowTests = setmetatable({}, {
	__tostring = function()
		return "ParallelRowTests"
	end,
})
ParallelRowTests.__index = ParallelRowTests

function ParallelRowTests.new()
	return setmetatable({ ready = false }, ParallelRowTests)
end

ParallelRowTests["lunit:method:test"] = {
	plain = { options = { isTest = true, lifecycles = {} } },
	rows = { options = { isTest = true, lifecycles = {}, cases = { { 1, 2, 3 }, { 2, 2, 4 }, { 2, 2, 5 } } } },
	sweep = { options = { isTest = true, lifecycles = {}, tags = { "Slow" } } },
	setUp = { options = { isTest = false, lifecycles = { "BeforeEach" } } },
	tearDown = { options = { isTest = false, lifecycles = { "AfterEach" } } },
}

function ParallelRowTests:setUp()
	self.ready = true
	counter.bump()
end

function ParallelRowTests:tearDown()
	self.ready = false
end

function ParallelRowTests:plain()
	assert(self.ready, "BeforeEach must have run for this case")
	assert(counter.value() == 1, "each case must start from a fresh module cache, saw " .. counter.value())
end

function ParallelRowTests:rows(a, b, expected)
	assert(self.ready, "BeforeEach must have run for this row")
	assert(counter.value() == 1, "each row must start from a fresh module cache, saw " .. counter.value())
	assert(a + b == expected, a .. " + " .. b .. " should be " .. expected)
end

function ParallelRowTests:sweep()
	assert(self.ready)
end

ParallelRowTests = Tag("Parallel")(ParallelRowTests) or ParallelRowTests

return ParallelRowTests
