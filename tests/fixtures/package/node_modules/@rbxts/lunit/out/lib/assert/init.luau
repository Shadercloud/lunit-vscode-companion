-- Compiled with roblox-ts v3.0.0
local TS = _G[script]
local function resolveMessage(message)
	local _message = message
	return if type(_message) == "string" then message else message()
end
local function fail(fallbackMessage, message)
	error(if message ~= nil then resolveMessage(message) else fallbackMessage)
end
local MISSING = "<missing>"
local function appendPath(parent, key)
	local _key = key
	if type(_key) == "number" then
		return `{parent}[{key}]`
	end
	local _key_1 = key
	if type(_key_1) == "string" then
		return if parent == "" then key else `{parent}.{key}`
	end
	return `{parent}[{tostring(key)}]`
end
local function collectDiffs(actual, expected, path, out)
	if actual == expected then
		return nil
	end
	local _actual = actual
	local _condition = not (type(_actual) == "table")
	if not _condition then
		local _expected = expected
		_condition = not (type(_expected) == "table")
	end
	if _condition then
		local _out = out
		local _arg0 = {
			path = if path == "" then "<root>" else path,
			actual = actual,
			expected = expected,
		}
		table.insert(_out, _arg0)
		return nil
	end
	local actualMap = actual
	local expectedMap = expected
	for key, actualVal in actualMap do
		local childPath = appendPath(path, key)
		if not (expectedMap[key] ~= nil) then
			local _out = out
			local _arg0 = {
				path = childPath,
				actual = actualVal,
				expected = MISSING,
			}
			table.insert(_out, _arg0)
		else
			collectDiffs(actualVal, expectedMap[key], childPath, out)
		end
	end
	for key, expectedVal in expectedMap do
		if not (actualMap[key] ~= nil) then
			local _out = out
			local _arg0 = {
				path = appendPath(path, key),
				actual = MISSING,
				expected = expectedVal,
			}
			table.insert(_out, _arg0)
		end
	end
end
local MAX_DIFFS_SHOWN = 5
local function formatDiffs(diffs)
	local shown = math.min(#diffs, MAX_DIFFS_SHOWN)
	local lines = { "deepEqual mismatch:" }
	do
		local i = 0
		local _shouldIncrement = false
		while true do
			if _shouldIncrement then
				i += 1
			else
				_shouldIncrement = true
			end
			if not (i < shown) then
				break
			end
			local d = diffs[i + 1]
			local _arg0 = `  at {d.path}: actual = {tostring(d.actual)}, expected = {tostring(d.expected)}`
			table.insert(lines, _arg0)
		end
	end
	if #diffs > MAX_DIFFS_SHOWN then
		local _arg0 = `  ...and {#diffs - MAX_DIFFS_SHOWN} more`
		table.insert(lines, _arg0)
	end
	return table.concat(lines, "\n")
end
local function isDeepEqual(a, b)
	local diffs = {}
	collectDiffs(a, b, "", diffs)
	return #diffs == 0
end
local Assert = {
	equal = function(self, actual, expected, message)
		if actual ~= expected then
			fail(`Expected {tostring(actual)} to equal {tostring(expected)}`, message)
		end
	end,
	notEqual = function(self, actual, expected, message)
		if actual == expected then
			fail(`Expected {tostring(actual)} to not equal {tostring(expected)}`, message)
		end
	end,
	deepEqual = function(self, actual, expected, message)
		local diffs = {}
		collectDiffs(actual, expected, "", diffs)
		if #diffs > 0 then
			fail(formatDiffs(diffs), message)
		end
	end,
	notDeepEqual = function(self, actual, expected, message)
		if isDeepEqual(actual, expected) then
			fail(`Expected {tostring(actual)} to not deeply equal {tostring(expected)}`, message)
		end
	end,
	["true"] = function(self, actual, message)
		if actual ~= true then
			fail(`Expected {tostring(actual)} to be true`, message)
		end
	end,
	["false"] = function(self, actual, message)
		if actual ~= false then
			fail(`Expected {tostring(actual)} to be false`, message)
		end
	end,
	undefined = function(self, actual, message)
		if actual ~= nil then
			fail(`Expected {tostring(actual)} to be undefined`, message)
		end
	end,
	notUndefined = function(self, actual, message)
		if actual == nil then
			fail("Expected value to be defined", message)
		end
	end,
	greaterThan = function(self, actual, threshold, message)
		if actual <= threshold then
			fail(`Expected {actual} to be greater than {threshold}`, message)
		end
	end,
	greaterThanOrEqual = function(self, actual, threshold, message)
		if actual < threshold then
			fail(`Expected {actual} to be greater than or equal to {threshold}`, message)
		end
	end,
	lessThan = function(self, actual, threshold, message)
		if actual >= threshold then
			fail(`Expected {actual} to be less than {threshold}`, message)
		end
	end,
	lessThanOrEqual = function(self, actual, threshold, message)
		if actual > threshold then
			fail(`Expected {actual} to be less than or equal to {threshold}`, message)
		end
	end,
	between = function(self, actual, min, max, message)
		if actual < min or actual > max then
			fail(`Expected {actual} to be between {min} and {max}`, message)
		end
	end,
	approximately = function(self, actual, expected, epsilon, message)
		if epsilon == nil then
			epsilon = 1e-6
		end
		if math.abs(actual - expected) > epsilon then
			fail(`Expected {actual} to be approximately {expected} (±{epsilon})`, message)
		end
	end,
	empty = function(self, array, message)
		if #array ~= 0 then
			fail(`Expected array to be empty, got size {#array}`, message)
		end
	end,
	notEmpty = function(self, array, message)
		if #array == 0 then
			fail("Expected array to not be empty", message)
		end
	end,
	contains = function(self, array, elementOrPredicate, message)
		local _elementOrPredicate = elementOrPredicate
		local _result
		if type(_elementOrPredicate) == "function" then
			local _array = array
			local _elementOrPredicate_1 = elementOrPredicate
			-- ▼ ReadonlyArray.some ▼
			local _result_1 = false
			for _k, _v in _array do
				if _elementOrPredicate_1(_v, _k - 1, _array) then
					_result_1 = true
					break
				end
			end
			-- ▲ ReadonlyArray.some ▲
			_result = _result_1
		else
			local _array = array
			local _elementOrPredicate_1 = elementOrPredicate
			_result = table.find(_array, _elementOrPredicate_1) ~= nil
		end
		local found = _result
		if not found then
			fail("Expected array to contain element", message)
		end
	end,
	doesNotContain = function(self, array, elementOrPredicate, message)
		local _elementOrPredicate = elementOrPredicate
		local _result
		if type(_elementOrPredicate) == "function" then
			local _array = array
			local _elementOrPredicate_1 = elementOrPredicate
			-- ▼ ReadonlyArray.some ▼
			local _result_1 = false
			for _k, _v in _array do
				if _elementOrPredicate_1(_v, _k - 1, _array) then
					_result_1 = true
					break
				end
			end
			-- ▲ ReadonlyArray.some ▲
			_result = _result_1
		else
			local _array = array
			local _elementOrPredicate_1 = elementOrPredicate
			_result = table.find(_array, _elementOrPredicate_1) ~= nil
		end
		local found = _result
		if found then
			fail("Expected array to not contain element", message)
		end
	end,
	match = function(self, actual, pattern, message)
		local _actual = actual
		local _pattern = pattern
		if (string.match(_actual, _pattern)) == nil then
			fail(`Expected "{actual}" to match pattern "{pattern}"`, message)
		end
	end,
	startsWith = function(self, actual, prefix, message)
		local _actual = actual
		local _arg1 = #prefix
		if string.sub(_actual, 1, _arg1) ~= prefix then
			fail(`Expected "{actual}" to start with "{prefix}"`, message)
		end
	end,
	endsWith = function(self, actual, suffix, message)
		local _actual = actual
		local _arg0 = #actual - #suffix + 1
		if string.sub(_actual, _arg0) ~= suffix then
			fail(`Expected "{actual}" to end with "{suffix}"`, message)
		end
	end,
	throws = function(self, callback, expectedMessage, message)
		local _exitType, _returns = TS.try(function()
			callback()
		end, function(e)
			if expectedMessage == nil then
				return TS.TRY_RETURN, {}
			end
			local errorString = tostring(e)
			local _expectedMessage = expectedMessage
			if (string.find(errorString, _expectedMessage, 1, true)) ~= nil then
				return TS.TRY_RETURN, {}
			end
			fail(`Expected error to contain "{expectedMessage}", got "{errorString}"`, message)
		end)
		if _exitType then
			return unpack(_returns)
		end
		fail("Expected callback to throw, but it did not", message)
	end,
	doesNotThrow = function(self, callback, message)
		TS.try(function()
			callback()
		end, function(e)
			fail(`Expected callback to not throw, threw: {tostring(e)}`, message)
		end)
	end,
	fail = function(self, message)
		error(if message ~= nil then resolveMessage(message) else "Assertion failed")
	end,
	resolves = function(self, promise, message)
		local status = promise:awaitStatus()
		if status ~= TS.Promise.Status.Resolved then
			fail(`Expected promise to resolve, instead it {status}`, message)
		end
	end,
	rejects = function(self, promise, message)
		local status = promise:awaitStatus()
		if status ~= TS.Promise.Status.Rejected then
			fail(`Expected promise to reject, instead it {status}`, message)
		end
	end,
	timeout = function(self, promise, durationInMilliseconds, message)
		local status = promise:timeout(durationInMilliseconds / 1000):awaitStatus()
		if status ~= TS.Promise.Status.Resolved then
			fail(`Expected promise to resolve within {durationInMilliseconds}ms`, message)
		end
	end,
}
local default = Assert
return {
	default = default,
}
