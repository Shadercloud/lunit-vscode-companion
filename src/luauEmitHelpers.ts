import { RESULT_MARKER } from './resultProtocol';

/**
 * Pure Luau (no Lune- or Roblox-specific APIs) so it works unmodified in the
 * generated Lune runner script, the Roblox Studio bootstrap script, and the
 * live-sync job script (see liveSyncScriptTemplate.ts). Base64-encodes each
 * field so `lunitEmitResult` can safely carry arbitrary class/label/error
 * text as one grep-able line, and also buffers every emitted line (in
 * addition to printing it) so a caller that needs the result back as a plain
 * string -- rather than reading it off stdout/a file, e.g. the live-sync
 * path, which returns its result directly from a `loadstring`'d function --
 * can just join `LUNIT_OUTPUT_BUFFER` at the end.
 *
 * Also defines `lunitRunClass(lunit, cls, className)`, the per-class
 * "run through TestRunner.fromClasses, collect onTestEnd results, emit them"
 * loop shared by all three generated scripts (each has its own class
 * discovery / require mechanism, but this middle part is identical) --
 * see bootstrapTemplate.ts's docs for why `onTestEnd` is used at all instead
 * of the more obvious-looking `TestRunResult.tests` Map.
 */
export function buildLuauEmitHelpers(): string {
	return `local LUNIT_RESULT_MARKER = "${RESULT_MARKER}"

local LUNIT_OUTPUT_BUFFER = {}

local LUNIT_B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

local function lunitB64Encode(data)
	data = tostring(data)
	local out = {}
	local len = #data
	local i = 1
	while i <= len do
		local b1, b2, b3 = string.byte(data, i, i + 2)
		b2 = b2 or 0
		b3 = b3 or 0
		local n = b1 * 65536 + b2 * 256 + b3
		out[#out + 1] = string.sub(LUNIT_B64_CHARS, math.floor(n / 262144) % 64 + 1, math.floor(n / 262144) % 64 + 1)
		out[#out + 1] = string.sub(LUNIT_B64_CHARS, math.floor(n / 4096) % 64 + 1, math.floor(n / 4096) % 64 + 1)
		out[#out + 1] = (i + 1 <= len)
			and string.sub(LUNIT_B64_CHARS, math.floor(n / 64) % 64 + 1, math.floor(n / 64) % 64 + 1)
			or "="
		out[#out + 1] = (i + 2 <= len) and string.sub(LUNIT_B64_CHARS, n % 64 + 1, n % 64 + 1) or "="
		i = i + 3
	end
	return table.concat(out)
end

local function lunitEmitResult(className, label, status, elapsedMs, errorMessage)
	local fields = {
		lunitB64Encode(className),
		lunitB64Encode(label),
		status,
		tostring(math.floor((elapsedMs or 0) + 0.5)),
		errorMessage ~= nil and lunitB64Encode(errorMessage) or "",
	}
	local line = LUNIT_RESULT_MARKER .. table.concat(fields, "\\t")
	print(line)
	table.insert(LUNIT_OUTPUT_BUFFER, line)
end

-- roblox-ts compiles the optional-chained call site
-- (reporter?.onTestEnd?.(...)) as a colon call, so the callback below
-- receives the reporter table itself as an implicit first arg ahead of
-- (label, result).
local function lunitRunClass(lunit, cls, className)
	local labelOrder = {}
	local lastByLabel = {}
	local result = lunit.TestRunner:fromClasses({ cls }):run({
		reporter = {
			onTestEnd = function(_self, label, testResult)
				if lastByLabel[label] == nil then
					table.insert(labelOrder, label)
				end
				lastByLabel[label] = testResult
			end,
		},
	}):expect()
	for _, label in labelOrder do
		local testResult = lastByLabel[label]
		local status = testResult.skipped and "skipped" or (testResult.passed and "passed" or "failed")
		lunitEmitResult(className, testResult.label, status, testResult.elapsedTimeMs, testResult.errorMessage)
	end
	return result.numTestsFailed > 0
end`;
}
