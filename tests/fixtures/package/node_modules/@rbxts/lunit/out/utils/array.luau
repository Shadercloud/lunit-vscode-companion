-- Compiled with roblox-ts v3.0.0
local function getKeysFromMap(map)
	local res = {}
	-- ▼ ReadonlyMap.forEach ▼
	local _callback = function(_, key)
		local _key = key
		table.insert(res, _key)
	end
	for _k, _v in map do
		_callback(_v, _k, map)
	end
	-- ▲ ReadonlyMap.forEach ▲
	return res
end
local function getValuesFromMap(map)
	local res = {}
	-- ▼ ReadonlyMap.forEach ▼
	local _callback = function(val)
		local _val = val
		table.insert(res, _val)
	end
	for _k, _v in map do
		_callback(_v, _k, map)
	end
	-- ▲ ReadonlyMap.forEach ▲
	return res
end
local function sharesOneElement(arr1, arr2)
	if #arr1 > #arr2 then
		arr1, arr2 = arr2, arr1
	end
	local _set = {}
	for _, _v in arr1 do
		_set[_v] = true
	end
	local set = _set
	for _, element in arr2 do
		if set[element] ~= nil then
			return true
		end
	end
	return false
end
return {
	getKeysFromMap = getKeysFromMap,
	getValuesFromMap = getValuesFromMap,
	sharesOneElement = sharesOneElement,
}
