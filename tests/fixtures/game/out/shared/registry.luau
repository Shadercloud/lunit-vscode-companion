-- Shared mutable state between the two modules of the dependency group.
local entries = {}
return {
	register = function(name)
		table.insert(entries, name)
	end,
	names = function()
		return entries
	end,
}
