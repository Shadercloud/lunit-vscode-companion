-- A class-level slow tag ("SLOW": tags match case-insensitively) on a class
-- whose only tests are therefore slow. Leaving them out must not read as "no
-- tests found"; explicitly selecting sweepAll must still run it.
local SlowOnlyTests = setmetatable({}, {
	__tostring = function()
		return "SlowOnlyTests"
	end,
})

SlowOnlyTests["lunit:class"] = { tags = { "SLOW" } }
SlowOnlyTests["lunit:method:test"] = {
	sweepAll = { options = { isTest = true } },
	sweepAgain = { options = { isTest = true } },
}

function SlowOnlyTests.sweepAll() end

function SlowOnlyTests.sweepAgain() end

return SlowOnlyTests
