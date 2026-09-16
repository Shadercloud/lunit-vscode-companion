-- Compiled with roblox-ts v3.0.0
local StringBuilder
do
	StringBuilder = setmetatable({}, {
		__tostring = function()
			return "StringBuilder"
		end,
	})
	StringBuilder.__index = StringBuilder
	function StringBuilder.new(...)
		local self = setmetatable({}, StringBuilder)
		return self:constructor(...) or self
	end
	function StringBuilder:constructor(initialValue)
		if initialValue == nil then
			initialValue = ""
		end
		self.parts = { initialValue }
	end
	function StringBuilder:append(value)
		local _parts = self.parts
		local _value = value
		table.insert(_parts, _value)
		return self
	end
	function StringBuilder:appendLine(value)
		if value == nil then
			value = ""
		end
		local _parts = self.parts
		local _arg0 = value .. "\n"
		table.insert(_parts, _arg0)
		return self
	end
	function StringBuilder:toString()
		return table.concat(self.parts, "")
	end
	function StringBuilder:__tostring()
		return self:toString()
	end
end
local default = StringBuilder
return {
	StringBuilder = StringBuilder,
	default = default,
}
