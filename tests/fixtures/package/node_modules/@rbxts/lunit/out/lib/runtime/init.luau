-- Compiled with roblox-ts v3.0.0
--[[
	*
	 * Pair with `@Skip` to gate tests on the host runtime — e.g.
	 * `@Skip(!Runtime.isRoblox(), "Roblox only")`. Detection is by global
	 * `game`: present-as-Instance ⇒ Roblox; otherwise treated as non-Roblox.
	 
]]
local function isRoblox()
	return typeof(game) == "Instance"
end
local function isLune()
	return not isRoblox()
end
local Runtime = {
	isRoblox = isRoblox,
	isLune = isLune,
}
local default = Runtime
return {
	Runtime = Runtime,
	default = default,
}
