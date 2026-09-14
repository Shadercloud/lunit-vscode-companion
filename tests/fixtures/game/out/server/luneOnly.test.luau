-- A class-level @Tag("Lune"), exactly as roblox-ts compiles it. The Studio
-- profile (bootstrap and live-sync job) must leave the whole class out. Its
-- test throws, so running it anyway shows up as a failure.
--
-- Left out of game.project.json's Lune run (globIgnorePaths): under Lune a
-- Lune-tagged test is supposed to run, and this one would fail on purpose.
local function Tag(...)
	local tags = { ... }
	return function(cls)
		cls["lunit:class"] = { tags = tags }
		return cls
	end
end

local LuneOnlyTests = setmetatable({}, {
	__tostring = function()
		return "LuneOnlyTests"
	end,
})

LuneOnlyTests["lunit:method:test"] = {
	mustNotRunInStudio = { options = { isTest = true } },
}

function LuneOnlyTests.mustNotRunInStudio()
	error("a class-level @Tag(\"Lune\") test must never run in Roblox Studio")
end

LuneOnlyTests = Tag("Lune")(LuneOnlyTests) or LuneOnlyTests

return LuneOnlyTests
