-- Compiled with roblox-ts v3.0.0 (written by hand in that shape)
-- Module-level mutable state: one Lune VM has exactly one copy of it.
local TS = _G[script]
local count = 0
local function bump()
	count += 1
	return count
end
local function value()
	return count
end
return {
	bump = bump,
	value = value,
}
