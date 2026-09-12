-- Stands in for roblox-ts's include/RuntimeLib.lua in this fixture, with the
-- two entry points a game project's compiled output actually calls. Shaped
-- like the real one on purpose: TS.import walks the DataModel by name and
-- registers _G[module] for packages that read it, and TS.getModule walks
-- ancestors looking for a node_modules child. The real RuntimeLib is what
-- runs in a real project -- this only has to be enough to prove the virtual
-- DataModel underneath it resolves the same way.
local TS = {}

local registered = {}

function TS.import(caller, module, ...)
	for i = 1, select("#", ...) do
		module = module:WaitForChild((select(i, ...)))
	end
	if not registered[module] then
		_G[module] = TS
		registered[module] = true
	end
	return require(module)
end

function TS.getModule(caller, scope, name)
	local object = caller.Parent
	while object do
		local modules = object:FindFirstChild("node_modules")
		if modules then
			local scoped = modules:FindFirstChild(scope)
			local found = scoped and scoped:FindFirstChild(name)
			if found then
				return found
			end
		end
		object = object.Parent
	end
	error("could not find module " .. tostring(name), 2)
end

return TS
