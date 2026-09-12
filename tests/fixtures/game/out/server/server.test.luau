local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local helper = TS.import(script, game:GetService("ReplicatedStorage"), "Shared", "helper")

local ServerTests = setmetatable({}, {
	__tostring = function()
		return "ServerTests"
	end,
})

ServerTests["lunit:method:test"] = {
	runsFromServerScriptService = { options = { isTest = true } },
	sharesModuleIdentity = { options = { isTest = true } },
}

function ServerTests.runsFromServerScriptService()
	assert(script.Parent.Name == "Server")
	assert(script.Parent.Parent.Name == "ServerScriptService")
end

function ServerTests.sharesModuleIdentity()
	-- One require cache across the whole run, as in Studio.
	assert(helper == TS.import(script, game:GetService("ReplicatedStorage"), "Shared", "helper"))
end

return ServerTests
