-- Compiled with roblox-ts v3.0.0
local TS = _G[script]
local getDescendantsOfType = TS.import(script, script.Parent.Parent.Parent, "utils", "instance").getDescendantsOfType
local getTestSummary = TS.import(script, script.Parent.Parent, "reporter", "printer").getTestSummary
local TestClassRunner = TS.import(script, script.Parent, "class").TestClassRunner
local DEFAULT_ORDER = TS.import(script, script.Parent.Parent, "shared", "constants").DEFAULT_ORDER
local DEFAULT_GLOB_PATTERNS = { ".+%.test$", ".+%.spec$" }
local function normalizePatterns(input)
	local _input = input
	return if type(_input) == "string" then { input } else input
end
local TestRunner
do
	TestRunner = setmetatable({}, {
		__tostring = function()
			return "TestRunner"
		end,
	})
	TestRunner.__index = TestRunner
	function TestRunner.new(...)
		local self = setmetatable({}, TestRunner)
		return self:constructor(...) or self
	end
	function TestRunner:constructor(roots, globPattern)
		if roots == nil then
			roots = {}
		end
		if globPattern == nil then
			globPattern = DEFAULT_GLOB_PATTERNS
		end
		self.testClasses = {}
		for _, root in roots do
			if root ~= nil then
				self:addRoot(root, globPattern)
			end
		end
	end
	function TestRunner:fromClasses(classes)
		local runner = TestRunner.new()
		for _, ctor in classes do
			runner:addClass(ctor)
		end
		return runner
	end
	function TestRunner:addRoot(root, globPattern)
		if globPattern == nil then
			globPattern = DEFAULT_GLOB_PATTERNS
		end
		local patterns = normalizePatterns(globPattern)
		local modules = getDescendantsOfType(root, "ModuleScript")
		-- ▼ ReadonlyArray.forEach ▼
		local _callback = function(module)
			-- ▼ ReadonlyArray.some ▼
			local _result = false
			local _callback_1 = function(p)
				local _name = module.Name
				local _p = p
				return (string.match(_name, _p)) ~= nil
			end
			for _k, _v in patterns do
				if _callback_1(_v, _k - 1, patterns) then
					_result = true
					break
				end
			end
			-- ▲ ReadonlyArray.some ▲
			if _result then
				TS.try(function()
					local testClass = require(module)
					self:tryAddClass(testClass, module.Name)
				end, function(e)
					local _name = module.Name
					local _arg1 = tostring(e)
					warn(string.format('failed to load module "%s": %s', _name, _arg1))
				end)
			end
		end
		for _k, _v in modules do
			_callback(_v, _k - 1, modules)
		end
		-- ▲ ReadonlyArray.forEach ▲
		return self
	end
	function TestRunner:addClass(ctor)
		self:tryAddClass(ctor, tostring(ctor))
		return self
	end
	function TestRunner:tryAddClass(ctor, sourceName)
		if ctor == nil then
			local _sourceName = sourceName
			warn(string.format('test class "%s" did not return a value', _sourceName))
			return nil
		end
		if ctor.new == nil then
			local _sourceName = sourceName
			warn(string.format('test class "%s" is not a class', _sourceName))
			return nil
		end
		local _testClasses = self.testClasses
		local _testClassRunner = TestClassRunner.new(ctor)
		table.insert(_testClasses, _testClassRunner)
	end
	TestRunner.run = TS.async(function(self, options)
		if options == nil then
			options = {}
		end
		local _binding = options
		local reporter = _binding.reporter
		if reporter == nil then
			reporter = {}
		end
		local getReport = reporter.getReport or getTestSummary
		local results = {
			elapsedTimeMs = 0,
			numTests = 0,
			numTestsPassed = 0,
			numTestsSkipped = 0,
			numTestsFailed = 0,
			tests = {},
			tags = options.tags,
		}
		-- REPORTER:onRunStart
		local _self = reporter
		local _result = _self.onRunStart
		if _result ~= nil then
			_result(_self)
		end
		local _exp = self.testClasses
		-- ▼ ReadonlyArray.filter ▼
		local _newValue = {}
		local _callback = function(c)
			return c:getMetadata().only
		end
		local _length = 0
		for _k, _v in _exp do
			if _callback(_v, _k - 1, _exp) == true then
				_length += 1
				_newValue[_length] = _v
			end
		end
		-- ▲ ReadonlyArray.filter ▲
		local focused = _newValue
		local _exp_1 = (if #focused > 0 then focused else self.testClasses)
		table.sort(_exp_1, function(a, b)
			local _condition = a:getMetadata().order
			if _condition == nil then
				_condition = DEFAULT_ORDER
			end
			local _condition_1 = b:getMetadata().order
			if _condition_1 == nil then
				_condition_1 = DEFAULT_ORDER
			end
			return _condition < _condition_1
		end)
		local classesToRun = _exp_1
		for _, testClass in classesToRun do
			local classResults = TS.await(testClass:runTests(options))
			self:addResults(results, classResults)
			local _tests = results.tests
			local _arg0 = testClass:getConstructor()
			_tests[_arg0] = classResults
		end
		-- REPORTER:onRunEnd
		local _self_1 = reporter
		local _result_1 = _self_1.onRunEnd
		if _result_1 ~= nil then
			_result_1(_self_1)
		end
		local report = getReport(results)
		if reporter.output ~= nil then
			reporter.output(report)
		else
			print(report)
		end
		return results
	end)
	function TestRunner:addResults(destination, source)
		destination.elapsedTimeMs += source.elapsedTimeMs
		destination.numTests += source.numTests
		destination.numTestsPassed += source.numTestsPassed
		destination.numTestsSkipped += source.numTestsSkipped
		destination.numTestsFailed += source.numTestsFailed
	end
end
return {
	TestRunner = TestRunner,
}
