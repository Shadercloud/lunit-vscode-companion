-- Compiled with roblox-ts v3.0.0
local function hasMetadata(ctor, key)
	local ctorCast = ctor
	return ctorCast[key] ~= nil
end
local function addMethodMetadata(ctor, name, transform)
	local ctorCast = ctor
	local methods = ctorCast["lunit:method:test"]
	if not methods then
		methods = {}
		ctorCast["lunit:method:test"] = methods
	end
	local _methods = methods
	local _name = name
	local method = _methods[_name]
	if method then
		transform(method.options)
	else
		local newMethod = {
			name = name,
			options = {
				lifecycles = {},
			},
		}
		transform(newMethod.options)
		local _methods_1 = methods
		local _name_1 = name
		_methods_1[_name_1] = newMethod
	end
end
local function getMethodMetadata(ctor, name)
	local ctorCast = ctor
	local methods = ctorCast["lunit:method:test"]
	if methods then
		local _name = name
		local _result = methods[_name]
		if _result ~= nil then
			_result = _result.options
		end
		return _result
	end
	return nil
end
local function addClassMetadata(ctor, transform)
	local ctorCast = ctor
	if not ctorCast["lunit:class"] then
		ctorCast["lunit:class"] = {}
	end
	transform(ctorCast["lunit:class"])
end
local function getClassMetadata(ctor)
	local ctorCast = ctor
	return ctorCast["lunit:class"]
end
local function getLifecycleMethods(ctor, lifecycle)
	local ctorCast = ctor
	local methods = ctorCast["lunit:method:test"]
	local lifecycles = {}
	for name, val in methods do
		local _lifecycles = val.options.lifecycles
		local _lifecycle = lifecycle
		if table.find(_lifecycles, _lifecycle) ~= nil then
			local _arg0 = ctor[name]
			table.insert(lifecycles, _arg0)
		end
	end
	return lifecycles
end
return {
	hasMetadata = hasMetadata,
	addMethodMetadata = addMethodMetadata,
	getMethodMetadata = getMethodMetadata,
	addClassMetadata = addClassMetadata,
	getClassMetadata = getClassMetadata,
	getLifecycleMethods = getLifecycleMethods,
}
