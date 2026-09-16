-- Compiled with roblox-ts v3.0.0
local TS = _G[script]
local StringBuilder = TS.import(script, script.Parent.Parent.Parent, "utils", "string-builder").default
local getClassMetadata = TS.import(script, script.Parent.Parent, "metadata", "utils").getClassMetadata
local function getSymbol(passed, skipped)
	return if skipped then "↓" elseif passed then "✓" else "✗"
end
local function formatTestResult(_param, isLast)
	local passed = _param.passed
	local skipped = _param.skipped
	local elapsedTimeMs = _param.elapsedTimeMs
	local label = _param.label
	local _binding = _param.method
	local options = _binding.options
	if isLast == nil then
		isLast = false
	end
	local stringBuilder = StringBuilder.new()
	local failed = not (passed or skipped)
	local _result = options.disabled
	if _result ~= nil then
		_result = _result.value
	end
	local _condition = _result
	if not _condition then
		_condition = false
	end
	local isDisabled = _condition
	local _result_1 = options.disabled
	if _result_1 ~= nil then
		_result_1 = _result_1.message
	end
	local _condition_1 = _result_1
	if _condition_1 == nil then
		_condition_1 = ""
	end
	local disabledMessage = _condition_1
	stringBuilder:append(" │")
	stringBuilder:appendLine(`\t{if isLast then "└" else "├"}── [{getSymbol(passed, skipped)}] {label} ({math.round(elapsedTimeMs)}ms) {if passed then "PASSED" elseif failed then "FAILED" elseif isDisabled then `SKIPPED{if #disabledMessage > 0 then ` ({disabledMessage})` else ""}` else ""}`)
	return stringBuilder
end
local function formatTestRunSummary(results)
	local stringBuilder = StringBuilder.new()
	stringBuilder:appendLine(`\tRan {results.numTests} tests in {math.round(results.elapsedTimeMs)}ms`)
	stringBuilder:appendLine(`\t\tPassed: {results.numTestsPassed}`)
	stringBuilder:appendLine(`\t\tFailed: {results.numTestsFailed}`)
	stringBuilder:appendLine(`\t\tSkipped: {results.numTestsSkipped}`)
	return stringBuilder
end
local function formatTestFailures(results)
	local stringBuilder = StringBuilder.new()
	local failureIndex = 0
	stringBuilder:appendLine("Failures:")
	for className, testResults in results.tests do
		for _, _binding in testResults.tests do
			local label = _binding.label
			local errorMessage = _binding.errorMessage
			local passed = _binding.passed
			if passed == true or errorMessage == nil then
				continue
			end
			failureIndex += 1
			stringBuilder:appendLine(`{failureIndex}. {tostring(className)}.{label}`)
			local _exp = string.split(tostring(errorMessage), "\n")
			-- ▼ ReadonlyArray.map ▼
			local _newValue = table.create(#_exp)
			local _callback = function(line)
				return "   " .. line
			end
			for _k, _v in _exp do
				_newValue[_k] = _callback(_v, _k - 1, _exp)
			end
			-- ▲ ReadonlyArray.map ▲
			local errorDisplay = table.concat(_newValue, "\n\t")
			stringBuilder:appendLine(errorDisplay)
			stringBuilder:appendLine()
		end
	end
	return stringBuilder
end
local function formatTests(results)
	local stringBuilder = StringBuilder.new()
	local _exp = results.tests
	-- ▼ ReadonlyMap.forEach ▼
	local _callback = function(testResultsRecord, testClassMetadata)
		local metadata = getClassMetadata(testClassMetadata) or {}
		local _result = metadata
		if _result ~= nil then
			_result = _result.displayName
		end
		local _condition = _result
		if _condition == nil then
			_condition = tostring(testClassMetadata)
		end
		local className = _condition
		local _exp_1 = testResultsRecord.tests
		-- ▼ ReadonlyArray.some ▼
		local _result_1 = false
		local _callback_1 = function(test)
			return not test.passed and not test.skipped
		end
		for _k, _v in _exp_1 do
			if _callback_1(_v, _k - 1, _exp_1) then
				_result_1 = true
				break
			end
		end
		-- ▲ ReadonlyArray.some ▲
		local someTestsFailed = _result_1
		stringBuilder:appendLine(`[{getSymbol(not someTestsFailed)}] {className} ({math.round(testResultsRecord.elapsedTimeMs)}ms)`)
		local _exp_2 = testResultsRecord.tests
		-- ▼ ReadonlyArray.forEach ▼
		local _callback_2 = function(testResult, index)
			stringBuilder:append(formatTestResult(testResult, index == #testResultsRecord.tests - 1):toString())
		end
		for _k, _v in _exp_2 do
			_callback_2(_v, _k - 1, _exp_2)
		end
		-- ▲ ReadonlyArray.forEach ▲
		stringBuilder:appendLine()
	end
	for _k, _v in _exp do
		_callback(_v, _k, _exp)
	end
	-- ▲ ReadonlyMap.forEach ▲
	return stringBuilder
end
local function getTestSummary(results)
	local stringBuilder = StringBuilder.new("\n")
	if results.tags ~= nil then
		stringBuilder:appendLine(`Ran filtered tests on the following tags: {table.concat(results.tags, ", ")}`)
		stringBuilder:appendLine()
	end
	if results.numTests == 0 then
		stringBuilder:appendLine("No tests ran.")
		return stringBuilder:toString()
	end
	stringBuilder:append(formatTests(results):toString())
	if results.numTestsFailed > 0 then
		stringBuilder:append(formatTestFailures(results):toString())
	end
	stringBuilder:append(formatTestRunSummary(results):toString())
	return stringBuilder:toString()
end
return {
	getTestSummary = getTestSummary,
}
