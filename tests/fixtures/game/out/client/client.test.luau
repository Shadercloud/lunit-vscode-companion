local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local _helper = TS.import(script, game:GetService("ReplicatedStorage"), "Shared", "helper")

local ClientTests = setmetatable({}, {
	__tostring = function()
		return "ClientTests"
	end,
})

ClientTests["lunit:method:test"] = {
	runsFromStarterPlayerScripts = { options = { isTest = true } },
	unmappedServicesAreStubs = { options = { isTest = true } },
}

function ClientTests.runsFromStarterPlayerScripts()
	assert(script.Parent.Name == "Client")
	assert(script.Parent.Parent.Name == "StarterPlayerScripts")
	assert(script.Parent.Parent.Parent.Name == "StarterPlayer")
end

function ClientTests.unmappedServicesAreStubs()
	-- A service the project never mapped resolves to an empty stub, so a
	-- module that merely references one at load time still loads.
	local players = game:GetService("Players")
	assert(players ~= nil and players.Name == "Players")
	assert(#players:GetChildren() == 0)
end

return ClientTests
