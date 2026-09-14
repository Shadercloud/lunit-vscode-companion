-- One method-level @Tag("Lune") (spelled "LUNE": tags match case-insensitively)
-- beside an untagged test and a lifecycle hook. The Studio profile must run
-- runsInStudio, keep the hook, and leave runsOnlyUnderLune out. That test
-- throws, so running it anyway shows up as a failure.
--
-- Left out of game.project.json's Lune run (globIgnorePaths): under Lune a
-- Lune-tagged test is supposed to run, and this one would fail on purpose.
local MixedTagTests = setmetatable({}, {
	__tostring = function()
		return "MixedTagTests"
	end,
})

MixedTagTests["lunit:method:test"] = {
	runsInStudio = { options = { isTest = true } },
	runsOnlyUnderLune = { options = { isTest = true, tags = { "LUNE" } } },
	setUp = { options = { isTest = false } },
}

function MixedTagTests.runsInStudio()
	assert(MixedTagTests["lunit:method:test"].setUp ~= nil, "the lifecycle hook was removed along with the tagged test")
end

function MixedTagTests.runsOnlyUnderLune()
	error("a method-level @Tag(\"Lune\") test must never run in Roblox Studio")
end

function MixedTagTests.setUp() end

return MixedTagTests
