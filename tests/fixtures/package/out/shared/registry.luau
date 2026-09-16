-- Compiled with roblox-ts v3.0.0 (written by hand in that shape)
-- Shared mutable state between the two modules of the dependency group.
local TS = _G[script]
local entries = {}
local function register(name)
	table.insert(entries, name)
end
local function names()
	return entries
end
return {
	register = register,
	names = names,
}
