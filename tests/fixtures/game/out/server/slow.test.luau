-- Method-level slow tags beside an untagged test and a lifecycle hook. With
-- lunit.lune.slowTags = { "Slow" }, "Run with Lune" and "Run in Roblox Studio"
-- run only quickCheck (both tags match: "slow" is spelled in lower case), and
-- "Run with Lune (Full)" runs all three.
local SlowTests = setmetatable({}, {
	__tostring = function()
		return "SlowTests"
	end,
})

SlowTests["lunit:method:test"] = {
	quickCheck = { options = { isTest = true } },
	sweep = { options = { isTest = true, tags = { "Slow" } } },
	longSweep = { options = { isTest = true, tags = { "slow" } } },
	setUp = { options = { isTest = false } },
}

function SlowTests.quickCheck()
	assert(SlowTests["lunit:method:test"].setUp ~= nil, "the lifecycle hook was removed along with the slow tests")
end

function SlowTests.sweep() end

function SlowTests.longSweep() end

function SlowTests.setUp() end

return SlowTests
