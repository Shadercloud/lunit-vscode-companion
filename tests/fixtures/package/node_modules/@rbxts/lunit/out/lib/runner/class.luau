-- Compiled with roblox-ts v3.0.0
local TS = _G[script]
local _array = TS.import(script, script.Parent.Parent.Parent, "utils", "array")
local getValuesFromMap = _array.getValuesFromMap
local sharesOneElement = _array.sharesOneElement
local _utils = TS.import(script, script.Parent.Parent, "metadata", "utils")
local getClassMetadata = _utils.getClassMetadata
local getLifecycleMethods = _utils.getLifecycleMethods
local hasMetadata = _utils.hasMetadata
local DEFAULT_ORDER = TS.import(script, script.Parent.Parent, "shared", "constants").DEFAULT_ORDER
local Lifecycle = TS.import(script, script.Parent.Parent, "shared", "enums").Lifecycle
local function resolveTestLabel(method, caseArgs)
	local _condition = method.options.displayName
	if _condition == nil then
		_condition = method.name
	end
	local baseName = _condition
	if caseArgs == nil then
		return baseName
	end
	local parts = {}
	for _, arg in caseArgs do
		local _arg0 = tostring(arg)
		table.insert(parts, _arg0)
	end
	return `{baseName} ({table.concat(parts, ", ")})`
end
local TestClassRunner
do
	TestClassRunner = setmetatable({}, {
		__tostring = function()
			return "TestClassRunner"
		end,
	})
	TestClassRunner.__index = TestClassRunner
	function TestClassRunner.new(...)
		local self = setmetatable({}, TestClassRunner)
		return self:constructor(...) or self
	end
	function TestClassRunner:constructor(testClassConstructor)
		self.testClassConstructor = testClassConstructor
		self.metadata = getClassMetadata(self.testClassConstructor) or {}
		self.instance = self.testClassConstructor.new()
	end
	function TestClassRunner:getConstructor()
		return self.testClassConstructor
	end
	function TestClassRunner:getMetadata()
		return self.metadata
	end
	TestClassRunner.runTests = TS.async(function(self, options)
		local testList = self:getTestsFromTestClass(options.tags or {})
		local results = {
			elapsedTimeMs = 0,
			numTests = 0,
			numTestsPassed = 0,
			numTestsSkipped = 0,
			numTestsFailed = 0,
			tests = {},
		}
		-- Class-level @Disabled / @Skip — surface every test as skipped without
		-- running lifecycle hooks. Honors the optional message on the class.
		local _result = self.metadata.disabled
		if _result ~= nil then
			_result = _result.value
		end
		if _result then
			for _, test in testList do
				local cases = test.options.cases
				local count = if cases ~= nil and #cases > 0 then #cases else 1
				do
					local i = 0
					local _shouldIncrement = false
					while true do
						if _shouldIncrement then
							i += 1
						else
							_shouldIncrement = true
						end
						if not (i < count) then
							break
						end
						local args = if cases ~= nil and #cases > 0 then cases[i + 1] else nil
						local idx = if cases ~= nil and #cases > 0 then i else nil
						local _tests = results.tests
						local _arg0 = {
							method = test,
							label = resolveTestLabel(test, args),
							passed = false,
							skipped = true,
							elapsedTimeMs = 0,
							errorMessage = self.metadata.disabled.message,
							caseIndex = idx,
							caseArgs = args,
						}
						table.insert(_tests, _arg0)
						results.numTests += 1
						results.numTestsSkipped += 1
					end
				end
			end
			return results
		end
		-- LIFECYCLE:beforeAll
		TS.await(self:runLifecycleMethod(Lifecycle.RunBeforeAllTests))
		for _, test in testList do
			local cases = test.options.cases
			-- Sentinel is `[{}]` not `[undefined]`: Luau collapses `{ nil }` to an empty table,
			-- so a non-parameterized test would never run.
			local _result_1
			if cases ~= nil and #cases > 0 then
				-- ▼ ReadonlyArray.map ▼
				local _newValue = table.create(#cases)
				local _callback = function(args, index)
					return {
						args = args,
						index = index,
					}
				end
				for _k, _v in cases do
					_newValue[_k] = _callback(_v, _k - 1, cases)
				end
				-- ▲ ReadonlyArray.map ▲
				_result_1 = _newValue
			else
				_result_1 = { {} }
			end
			local invocations = _result_1
			for _1, invocation in invocations do
				local result = TS.await(self:runWithRepeatAndRetry(test, options, invocation.args, invocation.index))
				results.elapsedTimeMs += result.elapsedTimeMs
				results.numTests += 1
				if result.passed then
					results.numTestsPassed += 1
				elseif result.skipped then
					results.numTestsSkipped += 1
				else
					results.numTestsFailed += 1
				end
				local _exp = results.tests
				table.insert(_exp, result)
			end
		end
		-- LIFECYCLE:afterAll
		TS.await(self:runLifecycleMethod(Lifecycle.RunAfterAllTests))
		return results
	end)
	TestClassRunner.runLifecycleMethod = TS.async(function(self, lifecycle)
		return TS.Promise.try(TS.async(function()
			local methods = getLifecycleMethods(self.testClassConstructor, lifecycle)
			for _, callback in methods do
				TS.await(TS.Promise.try(function()
					callback(self.instance)
				end):catch(function(e)
					-- @rbxts/promise wraps thrown values in a Promise.Error whose
					-- __tostring dumps the full execution trace. Pull the original
					-- value off `.error` when present so the warn line is readable.
					local _e = e
					local _result
					if type(_e) == "table" then
						local _condition = e.error
						if _condition == nil then
							_condition = e
						end
						_result = _condition
					else
						_result = e
					end
					local original = _result
					warn(tostring(original))
				end))
			end
		end))
	end)
	function TestClassRunner:getTestsFromTestClass(tags)
		if hasMetadata(self.testClassConstructor, "lunit:method:test") == false then
			return {}
		end
		local methods = (self.testClassConstructor)["lunit:method:test"]
		local _exp = getValuesFromMap(methods)
		-- ▼ ReadonlyArray.filter ▼
		local _newValue = {}
		local _callback = function(val)
			return val.options.isTest
		end
		local _length = 0
		for _k, _v in _exp do
			if _callback(_v, _k - 1, _exp) == true then
				_length += 1
				_newValue[_length] = _v
			end
		end
		-- ▲ ReadonlyArray.filter ▲
		-- ▼ ReadonlyArray.filter ▼
		local _newValue_1 = {}
		local _callback_1 = function(val)
			if #tags > 0 then
				local methodTags = val.options.tags or {}
				local _result = self.metadata
				if _result ~= nil then
					_result = _result.tags
				end
				local _condition = _result
				if _condition == nil then
					_condition = {}
				end
				local classTags = _condition
				return sharesOneElement(tags, classTags) or sharesOneElement(tags, methodTags)
			end
			return true
		end
		local _length_1 = 0
		for _k, _v in _newValue do
			if _callback_1(_v, _k - 1, _newValue) == true then
				_length_1 += 1
				_newValue_1[_length_1] = _v
			end
		end
		-- ▲ ReadonlyArray.filter ▲
		local filtered = _newValue_1
		-- ▼ ReadonlyArray.filter ▼
		local _newValue_2 = {}
		local _callback_2 = function(val)
			return val.options.only
		end
		local _length_2 = 0
		for _k, _v in filtered do
			if _callback_2(_v, _k - 1, filtered) == true then
				_length_2 += 1
				_newValue_2[_length_2] = _v
			end
		end
		-- ▲ ReadonlyArray.filter ▲
		local focused = _newValue_2
		local candidates = if #focused > 0 then focused else filtered
		table.sort(candidates, function(a, b)
			local _condition = a.options.order
			if _condition == nil then
				_condition = DEFAULT_ORDER
			end
			local _condition_1 = b.options.order
			if _condition_1 == nil then
				_condition_1 = DEFAULT_ORDER
			end
			return _condition < _condition_1
		end)
		return candidates
	end
	function TestClassRunner:createFinalTestCaseResult(result)
		local isNegated = result.method.options.negated
		result.passed = if isNegated and not result.skipped then not result.passed else result.passed
		result.errorMessage = if isNegated then if not (result.passed or result.skipped) then "" else "Test was marked as a negative test and unexpectedly did not error" else result.errorMessage
		return result
	end
	TestClassRunner.runWithRepeatAndRetry = TS.async(function(self, method, options, caseArgs, caseIndex)
		local _condition = method.options.retries
		if _condition == nil then
			_condition = 0
		end
		local maxRetries = _condition
		local _condition_1 = method.options.repeats
		if _condition_1 == nil then
			_condition_1 = 1
		end
		local repeats = math.max(1, _condition_1)
		local aggregate = TS.await(self:runWithRetry(method, options, caseArgs, caseIndex, maxRetries))
		local totalTime = aggregate.elapsedTimeMs
		do
			local i = 1
			local _shouldIncrement = false
			while true do
				if _shouldIncrement then
					i += 1
				else
					_shouldIncrement = true
				end
				if not (i < repeats) then
					break
				end
				local nextTry = TS.await(self:runWithRetry(method, options, caseArgs, caseIndex, maxRetries))
				totalTime += nextTry.elapsedTimeMs
				-- Surface the first failure across iterations; once failed, keep that result.
				if aggregate.passed and not nextTry.passed then
					aggregate = nextTry
				end
			end
		end
		aggregate.elapsedTimeMs = totalTime
		return aggregate
	end)
	TestClassRunner.runWithRetry = TS.async(function(self, method, options, caseArgs, caseIndex, maxRetries)
		local result = TS.await(self:runOnce(method, options, caseArgs, caseIndex))
		local retries = 0
		while retries < maxRetries and not result.passed and not result.skipped do
			retries += 1
			result = TS.await(self:runOnce(method, options, caseArgs, caseIndex))
		end
		return result
	end)
	TestClassRunner.runOnce = TS.async(function(self, method, options, caseArgs, caseIndex)
		-- LIFECYCLE:beforeEach
		TS.await(self:runLifecycleMethod(Lifecycle.RunBeforeEachTest))
		local result = TS.await(self:runTestMethod(method, options, caseArgs, caseIndex))
		-- LIFECYCLE:afterEach
		TS.await(self:runLifecycleMethod(Lifecycle.RunAfterEachTest))
		return result
	end)
	TestClassRunner.runTestMethod = TS.async(function(self, method, options, caseArgs, caseIndex)
		local callback = (self.testClassConstructor)[method.name]
		if not callback then
			local _name = method.name
			local _arg1 = self:getClassDisplayName()
			error(string.format("method %s does not exist on class %s", _name, _arg1))
		end
		local label = resolveTestLabel(method, caseArgs)
		local result = {
			method = method,
			label = label,
			passed = false,
			elapsedTimeMs = 0,
			skipped = false,
			caseIndex = caseIndex,
			caseArgs = caseArgs,
		}
		local _self = options.reporter
		local _result = _self
		if _result ~= nil then
			_result = _result.onTestStart
			if _result ~= nil then
				_result(_self, label)
			end
		end
		local start = os.clock()
		TS.try(function()
			local _result_1 = method.options.disabled
			if _result_1 ~= nil then
				_result_1 = _result_1.value
			end
			if _result_1 then
				result.skipped = true
				result.errorMessage = method.options.disabled.message
			else
				local invoke = if caseArgs ~= nil then function()
					return callback(self.instance, unpack(caseArgs))
				end else function()
					return callback(self.instance)
				end
				local timeout = method.options.timeout
				if timeout ~= nil then
					local status = TS.Promise.try(invoke):timeout(timeout / 1000):awaitStatus()
					if status == TS.Promise.Status.Resolved then
						result.passed = true
					else
						result.errorMessage = string.format("Test exceeded timeout of %dms", timeout)
					end
				else
					TS.await(invoke())
					result.passed = true
				end
			end
		end, function(e)
			result.errorMessage = tostring(e)
		end, function()
			result.elapsedTimeMs = (os.clock() - start) * 1000
		end)
		local finalResult = self:createFinalTestCaseResult(result)
		self:onTestMethodRan(finalResult, options)
		return finalResult
	end)
	function TestClassRunner:onTestMethodRan(result, _param)
		local reporter = _param.reporter
		if result.passed then
			-- REPORTER:onTestPassed
			local _self = reporter
			local _result = _self
			if _result ~= nil then
				_result = _result.onTestPassed
				if _result ~= nil then
					_result(_self, result.label)
				end
			end
		elseif result.skipped then
			-- REPORTER:onTestSkipped
			local _self = reporter
			local _result = _self
			if _result ~= nil then
				_result = _result.onTestSkipped
				if _result ~= nil then
					_result(_self, result.label, result.errorMessage)
				end
			end
		else
			-- REPORTER:onTestFailed
			local _self = reporter
			local _result = _self
			if _result ~= nil then
				_result = _result.onTestFailed
				if _result ~= nil then
					_result(_self, result.label, result.errorMessage)
				end
			end
		end
		-- REPORTER:onTestEnd
		local _self = reporter
		local _result = _self
		if _result ~= nil then
			_result = _result.onTestEnd
			if _result ~= nil then
				_result(_self, result.label, result)
			end
		end
	end
	function TestClassRunner:getClassDisplayName()
		local _result = self.metadata
		if _result ~= nil then
			_result = _result.displayName
		end
		local _condition = _result
		if _condition == nil then
			_condition = tostring(self.testClassConstructor)
		end
		return _condition
	end
end
return {
	resolveTestLabel = resolveTestLabel,
	TestClassRunner = TestClassRunner,
}
