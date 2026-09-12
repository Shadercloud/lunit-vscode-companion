-- A class-level @Tag("Studio"), exactly as roblox-ts compiles it. This module
-- errors at load: the runner must recognise the tag in the source and never
-- require it, which is the whole point of matching the source rather than the
-- loaded class.
error("a class-level @Tag(\"Studio\") module must never be loaded under Lune")

local StudioOnlyTests = {}

StudioOnlyTests["lunit:method:test"] = {
	mountsReact = { options = { isTest = true } },
}

StudioOnlyTests = Tag("Studio")(StudioOnlyTests) or StudioOnlyTests

return StudioOnlyTests
