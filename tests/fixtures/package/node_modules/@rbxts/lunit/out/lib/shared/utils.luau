-- Compiled with roblox-ts v3.0.0
local function addTagsToMetadata(metadata, ...)
	local tags = { ... }
	if not metadata.tags then
		metadata.tags = table.clone(tags)
	else
		-- ▼ ReadonlyArray.forEach ▼
		local _callback = function(tag)
			local _result = metadata.tags
			if _result ~= nil then
				local _tag = tag
				table.insert(_result, _tag)
				_result = #_result
			end
			return _result
		end
		for _k, _v in tags do
			_callback(_v, _k - 1, tags)
		end
		-- ▲ ReadonlyArray.forEach ▲
	end
end
return {
	addTagsToMetadata = addTagsToMetadata,
}
