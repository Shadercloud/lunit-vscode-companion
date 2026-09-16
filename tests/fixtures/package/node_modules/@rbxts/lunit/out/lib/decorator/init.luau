-- Compiled with roblox-ts v3.0.0
local TS = _G[script]
local Lifecycle = TS.import(script, script.Parent, "shared", "enums").Lifecycle
local addTagsToMetadata = TS.import(script, script.Parent, "shared", "utils").addTagsToMetadata
local _utils = TS.import(script, script, "utils")
local createSharedDecorator = _utils.createSharedDecorator
local createMethodDecorator = _utils.createMethodDecorator
--[[
	*
	 * Marks a method as a test case.
	 * @example
	 * ```typescript
	 * @Test
	 * public myTest() {
	 *   // test code here
	 * }
	 * ```
	 
]]
local Test = createMethodDecorator(function(metadata)
	metadata.isTest = true
	return metadata.isTest
end)
--[[
	*
	 * Disables a test case or test class.
	 * @param message - An optional message explaining why the test is disabled.
	 * @example
	 * ```typescript
	 * @Disabled("This test is temporarily disabled")
	 * public myTest() {
	 *   // test code here
	 * }
	 * ```
	 
]]
local Disabled = function(message)
	return createSharedDecorator(function(metadata)
		metadata.disabled = {
			value = true,
			message = message,
		}
		return metadata.disabled
	end)
end
--[[
	*
	 * Sets a display name for a test case or test class.
	 * @param name - The display name to use.
	 * @example
	 * ```typescript
	 * @DisplayName("My Custom Test Name")
	 * public myTest() {
	 *   // test code here
	 * }
	 * ```
	 
]]
local DisplayName = function(name)
	return createSharedDecorator(function(metadata)
		metadata.displayName = name
		return metadata.displayName
	end)
end
--[[
	*
	 * Sets a timeout for a test case.
	 * @param timeInMilliseconds - The timeout duration in milliseconds.
	 * @example
	 * ```typescript
	 * @Timeout(1000)
	 * public myTest() {
	 *   // test code here
	 * }
	 * ```
	 
]]
local Timeout = function(timeInMilliseconds)
	return createMethodDecorator(function(metadata)
		metadata.timeout = timeInMilliseconds
		return metadata.timeout
	end)
end
--[[
	*
	 * Sets the order in which a test case should be run.
	 * @param order - The order index.
	 * @example
	 * ```typescript
	 * @Order(1)
	 * public myTest() {
	 *   // test code here
	 * }
	 * ```
	 
]]
local Order = function(order)
	return createSharedDecorator(function(metadata)
		metadata.order = order
		return metadata.order
	end)
end
--[[
	*
	 * Marks a method to be run before each test case.
	 * @alias Before
	 * @example
	 * ```typescript
	 * @BeforeEach
	 * public setup() {
	 *   // setup code here
	 * }
	 * ```
	 
]]
local BeforeEach = createMethodDecorator(function(metadata)
	local _lifecycles = metadata.lifecycles
	local _runBeforeEachTest = Lifecycle.RunBeforeEachTest
	table.insert(_lifecycles, _runBeforeEachTest)
	return #_lifecycles
end)
--[[
	*
	 * Marks a method to be run before each test case.
	 * @example
	 * ```typescript
	 * @Before
	 * public setup() {
	 *   // setup code here
	 * }
	 * ```
	 
]]
local Before = BeforeEach
--[[
	*
	 * Marks a method to be run before all test cases.
	 * @example
	 * ```typescript
	 * @BeforeAll
	 * public setupAll() {
	 *   // setup code here
	 * }
	 * ```
	 
]]
local BeforeAll = createMethodDecorator(function(metadata)
	local _lifecycles = metadata.lifecycles
	local _runBeforeAllTests = Lifecycle.RunBeforeAllTests
	table.insert(_lifecycles, _runBeforeAllTests)
	return #_lifecycles
end)
--[[
	*
	 * Marks a method to be run after each test case.
	 * @example
	 * ```typescript
	 * @After
	 * public teardown() {
	 *   // teardown code here
	 * }
	 * ```
	 
]]
local After = createMethodDecorator(function(metadata)
	local _lifecycles = metadata.lifecycles
	local _runAfterEachTest = Lifecycle.RunAfterEachTest
	table.insert(_lifecycles, _runAfterEachTest)
	return #_lifecycles
end)
--[[
	*
	 * Marks a method to be run after each test case.
	 * @example
	 * ```typescript
	 * @AfterEach
	 * public teardown() {
	 *   // teardown code here
	 * }
	 * ```
	 
]]
local AfterEach = createMethodDecorator(function(metadata)
	local _lifecycles = metadata.lifecycles
	local _runAfterEachTest = Lifecycle.RunAfterEachTest
	table.insert(_lifecycles, _runAfterEachTest)
	return #_lifecycles
end)
--[[
	*
	 * Marks a method to be run after all test cases.
	 * @example
	 * ```typescript
	 * @AfterAll
	 * public teardownAll() {
	 *   // teardown code here
	 * }
	 * ```
	 
]]
local AfterAll = createMethodDecorator(function(metadata)
	local _lifecycles = metadata.lifecycles
	local _runAfterAllTests = Lifecycle.RunAfterAllTests
	table.insert(_lifecycles, _runAfterAllTests)
	return #_lifecycles
end)
--[[
	*
	 * Assigns one or more tags to a test case or test class for filtering and categorization.
	 *
	 * Tags allow selective execution of test cases, making it easier to run specific groups of tests
	 * (e.g., regression, smoke, or critical tests).
	 *
	 * @param tags - One or more string tags associated with the test.
	 *
	 * @example
	 * ```typescript
	 * @Tag("Regression")
	 * public myTest() {
	 *   // This test belongs to the "Regression" category
	 * }
	 *
	 * @Tag("Smoke", "Critical")
	 * public anotherTest() {
	 *   // This test belongs to both "Smoke" and "Critical" categories
	 * }
	 * ```
	 
]]
local Tag = function(...)
	local args = { ... }
	return createSharedDecorator(function(metadata)
		return addTagsToMetadata(metadata, unpack(args))
	end)
end
--[[
	*
	 * Flips the result of a test case. If the test case would normally pass, it will be marked as failed, and if it would normally fail, it will be marked as passed.
	 *
	 * This is useful for testing the behavior of test runners and reporters.
	 * @example
	 * ```typescript
	 * @Test
	 * @Negated
	 * public myTest() {
	 *   // test code here
	 * }
	 * ```
	 
]]
local Negated = createMethodDecorator(function(metadata)
	metadata.negated = true
	return metadata.negated
end)
--[[
	*
	 * Conditionally skips a test case or test class.
	 * @param condition - A boolean condition or a function returning a boolean to determine if the test should be skipped.
	 * @param message - An optional message explaining why the test is skipped.
	 * @example
	 * ```typescript
	 * @Skip(process.env.NODE_ENV === 'production', "Skip in production environment")
	 * public myTest() {
	 *   // test code here
	 * }
	 * ```
	 
]]
local Skip = function(condition, message)
	return createSharedDecorator(function(metadata)
		local _object = {}
		local _left = "value"
		local _condition = condition
		_object[_left] = if type(_condition) == "boolean" then condition else condition()
		_object.message = message
		metadata.disabled = _object
	end)
end
--[[
	*
	 * Focuses execution on a specific test case or test class. When any test or class is marked `@Only`,
	 * only those marked are run. Method-level focus narrows within a class; class-level focus narrows
	 * across the whole run.
	 * @example
	 * ```typescript
	 * @Only
	 * @Test
	 * public theOneIcareAbout() {
	 *   // only this test will run if any test has @Only
	 * }
	 * ```
	 
]]
local Only = createSharedDecorator(function(metadata)
	metadata.only = true
	return metadata.only
end)
--[[
	*
	 * Runs a single test method once per row, with the row's values spread as arguments.
	 * Each row produces an independent test result.
	 * @param rows - An array of argument tuples to invoke the test with.
	 * @example
	 * ```typescript
	 * @Each([
	 *   [1, 2, 3],
	 *   [10, 20, 30],
	 * ])
	 * @Test
	 * public addition(a: number, b: number, expected: number) {
	 *   Assert.equal(a + b, expected);
	 * }
	 * ```
	 
]]
local Each = function(rows)
	return createMethodDecorator(function(metadata)
		metadata.cases = rows
		return metadata.cases
	end)
end
--[[
	*
	 * Re-runs a failing test up to `count` additional times before declaring failure.
	 * The first passing attempt wins. Lifecycle hooks (`BeforeEach`/`AfterEach`) re-run between attempts.
	 * @param count - The maximum number of additional attempts after the initial run.
	 * @example
	 * ```typescript
	 * @Retry(3)
	 * @Test
	 * public flakyNetworkCall() {
	 *   // up to 4 total attempts
	 * }
	 * ```
	 
]]
local Retry = function(count)
	return createMethodDecorator(function(metadata)
		metadata.retries = count
		return metadata.retries
	end)
end
--[[
	*
	 * Runs a test `count` times. If any iteration fails, the test is marked as failed.
	 * Lifecycle hooks (`BeforeEach`/`AfterEach`) run for every iteration.
	 * @param count - The number of times to run the test.
	 * @example
	 * ```typescript
	 * @Repeat(50)
	 * @Test
	 * public raceConditionCheck() {
	 *   // run 50 times to surface flaky failures
	 * }
	 * ```
	 
]]
local Repeat = function(count)
	return createMethodDecorator(function(metadata)
		metadata.repeats = count
		return metadata.repeats
	end)
end
local default = {
	Test = Test,
	Disabled = Disabled,
	DisplayName = DisplayName,
	Timeout = Timeout,
	Order = Order,
	Tag = Tag,
	Negated = Negated,
	Skip = Skip,
	Only = Only,
	Each = Each,
	Retry = Retry,
	Repeat = Repeat,
	Before = Before,
	BeforeAll = BeforeAll,
	BeforeEach = BeforeEach,
	After = After,
	AfterEach = AfterEach,
	AfterAll = AfterAll,
}
return {
	Test = Test,
	Disabled = Disabled,
	DisplayName = DisplayName,
	Timeout = Timeout,
	Order = Order,
	BeforeEach = BeforeEach,
	Before = Before,
	BeforeAll = BeforeAll,
	After = After,
	AfterEach = AfterEach,
	AfterAll = AfterAll,
	Tag = Tag,
	Negated = Negated,
	Skip = Skip,
	Only = Only,
	Each = Each,
	Retry = Retry,
	Repeat = Repeat,
	default = default,
}
