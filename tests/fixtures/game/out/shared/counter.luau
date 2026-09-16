-- Module-level mutable state: one Lune VM (one worker) has exactly one copy.
local count = 0
return {
	bump = function()
		count += 1
		return count
	end,
	value = function()
		return count
	end,
}
