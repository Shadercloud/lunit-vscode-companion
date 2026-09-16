-- Compiled with roblox-ts v3.0.0
local function getDescendantsOfType(root, className)
	local res = {}
	for _, descendant in root:GetDescendants() do
		if descendant:IsA(className) then
			table.insert(res, descendant)
		end
	end
	return res
end
return {
	getDescendantsOfType = getDescendantsOfType,
}
