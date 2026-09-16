-- Compiled with roblox-ts v3.0.0
local TS = _G[script]
local _utils = TS.import(script, script.Parent.Parent, "metadata", "utils")
local addMethodMetadata = _utils.addMethodMetadata
local addClassMetadata = _utils.addClassMetadata
local function createSharedDecorator(callback)
	return function(ctor, propertyKey)
		if ctor == nil then
			error("target cannot be undefined")
		elseif propertyKey ~= nil then
			addMethodMetadata(ctor, propertyKey, callback)
		else
			addClassMetadata(ctor, callback)
		end
	end
end
local function createMethodDecorator(callback)
	return function(ctor, propertyKey)
		if ctor == nil then
			error("target cannot be undefined")
		elseif propertyKey ~= nil then
			addMethodMetadata(ctor, propertyKey, callback)
		end
	end
end
return {
	createSharedDecorator = createSharedDecorator,
	createMethodDecorator = createMethodDecorator,
}
