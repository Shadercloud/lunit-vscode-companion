-- Tagged through the loaded class rather than the compiled source: this one
-- is safe to require, and is dropped once its metadata is read.
local TaggedTests = setmetatable({}, {
	__tostring = function()
		return "TaggedTests"
	end,
})

TaggedTests["lunit:class"] = { tags = { "Studio" } }
TaggedTests["lunit:method:test"] = {
	needsEngine = { options = { isTest = true } },
}

function TaggedTests.needsEngine()
	error("a Studio-tagged class must never run under Lune")
end

return TaggedTests
