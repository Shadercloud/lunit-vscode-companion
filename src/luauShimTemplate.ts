/**
 * Builds a minimal shim (inlined directly into the generated Lune runner
 * script) that lets Lune run roblox-ts compiled output, INCLUDING ordinary
 * package imports like `import { Test } from "@rbxts/lunit"`.
 *
 * This intentionally does not reuse @rbxts/lunit's own bundled
 * `scripts/lune-shim.luau`: that shim only implements `TS.import` (relative
 * `script.Parent`-style requires), not `TS.getModule` -- but roblox-ts
 * compiles any `node_modules` package import (i.e. every normal
 * `import { X } from "@rbxts/somePackage"`, which is the only realistic way
 * anyone imports Lunit itself) to a `TS.getModule(script, scope, moduleName)`
 * call. Without it, every test file that imports `@rbxts/lunit` crashes
 * under Lune with "attempt to call a nil value" on its very first line.
 * Confirmed against a real consumer project that had independently
 * hand-forked its own copy of this exact fix.
 *
 * `TS.getModule` walks up ancestor directories looking for
 * `node_modules/<scope>/<moduleName>`, mirroring the real `TS.getModule`
 * (node_modules/roblox-ts/include/RuntimeLib.lua) walking up Instance
 * ancestors for a `node_modules` child. Everything else here is otherwise
 * equivalent to @rbxts/lunit's own `lune-shim.luau` (MIT licensed).
 *
 * @param promiseRequirePath Relative (Lune-style `./`/`../`) require path,
 *   from the generated script's own directory, to
 *   `node_modules/@rbxts/lunit/scripts/promise` (no extension). Lunit's own
 *   minimal Promise implementation is reused as-is -- only the TS runtime
 *   shim around it needed the fix.
 */
export function buildLuauShim(promiseRequirePath: string): string {
	return `local luau = require("@lune/luau")
local shimFs = require("@lune/fs")
local shimTask = require("@lune/task")
local shimStdio = require("@lune/stdio")
local Promise = require("${promiseRequirePath}")

local DEFAULT_SCOPE = "@rbxts"

_G.task = shimTask
_G.warn = function(...)
	local parts = { ... }
	for i, v in ipairs(parts) do
		parts[i] = tostring(v)
	end
	shimStdio.ewrite(shimStdio.color("yellow") .. table.concat(parts, "\\t") .. shimStdio.color("reset") .. "\\n")
end

local shimCache = {}
local shimScriptByPath = {}

local function shimMakeScript(path)
	local existing = shimScriptByPath[path]
	if existing then
		return existing
	end
	local self = { __path = path }
	setmetatable(self, {
		__index = function(_, key)
			if key == "Parent" then
				local cut = string.find(path, "/[^/]*$")
				if not cut then
					return nil
				end
				return shimMakeScript(string.sub(path, 1, cut - 1))
			end
			return shimMakeScript(path .. "/" .. tostring(key))
		end,
		__tostring = function()
			return "Script(" .. path .. ")"
		end,
	})
	shimScriptByPath[path] = self
	return self
end

local function shimResolveFile(path)
	local asFile = path .. ".luau"
	if shimFs.isFile(asFile) then
		return asFile
	end
	local asInit = path .. "/init.luau"
	if shimFs.isFile(asInit) then
		return asInit
	end
	return nil
end

local shimLoadModule

local function shimBuildTS()
	local TS = { Promise = Promise }

	function TS.import(_caller, module, ...)
		local target = module
		for i = 1, select("#", ...) do
			target = target[(select(i, ...))]
		end
		return shimLoadModule(target)
	end

	function TS.getModule(context, scope, moduleName)
		if moduleName == nil then
			moduleName = scope
			scope = DEFAULT_SCOPE
		end

		local current = context.__path
		while true do
			local candidate = (current == "" and "" or current .. "/") .. "node_modules/" .. scope .. "/" .. moduleName
			if shimFs.isDir(candidate) or shimResolveFile(candidate) ~= nil then
				return shimMakeScript(candidate)
			end

			if current == "" then
				break
			end

			local cut = string.find(current, "/[^/]*$")
			current = if cut then string.sub(current, 1, cut - 1) else ""
		end

		error(
			string.format(
				'TS.getModule: could not find an ancestor with "node_modules/%s/%s" (starting from "%s")',
				scope,
				moduleName,
				context.__path
			),
			2
		)
	end

	function TS.async(callback)
		return function(...)
			local n = select("#", ...)
			local args = { ... }
			return Promise.new(function(resolve, reject)
				coroutine.wrap(function()
					local ok, result = pcall(callback, table.unpack(args, 1, n))
					if ok then
						resolve(result)
					else
						reject(result)
					end
				end)()
			end)
		end
	end

	function TS.await(p)
		if not Promise.is(p) then
			return p
		end
		local status, value = p:awaitStatus()
		if status == Promise.Status.Resolved then
			return value
		elseif status == Promise.Status.Rejected then
			error(value, 2)
		else
			error("The awaited Promise was cancelled", 2)
		end
	end

	function TS.instanceof(obj, class)
		if type(class) == "table" and type(class.instanceof) == "function" then
			return class.instanceof(obj)
		end
		if type(obj) == "table" then
			obj = getmetatable(obj)
			while obj ~= nil do
				if obj == class then
					return true
				end
				local mt = getmetatable(obj)
				obj = mt and mt.__index or nil
			end
		end
		return false
	end

	TS.TRY_RETURN = 1
	TS.TRY_BREAK = 2
	TS.TRY_CONTINUE = 3

	function TS.try(try, catchFn, finallyFn)
		local trySuccess, exitTypeOrTryError, returns = pcall(try)
		local exitType, tryError
		if trySuccess then
			exitType = exitTypeOrTryError
		else
			tryError = exitTypeOrTryError
		end

		local catchSuccess, catchError = true, nil
		if not trySuccess and catchFn then
			local newExitTypeOrCatchError, newReturns
			catchSuccess, newExitTypeOrCatchError, newReturns = pcall(catchFn, tryError)
			local newExitType
			if catchSuccess then
				newExitType = newExitTypeOrCatchError
			else
				catchError = newExitTypeOrCatchError
			end
			if newExitType then
				exitType, returns = newExitType, newReturns
			end
		end

		if finallyFn then
			local newExitType, newReturns = finallyFn()
			if newExitType then
				exitType, returns = newExitType, newReturns
			end
		end

		if exitType ~= TS.TRY_RETURN and exitType ~= TS.TRY_BREAK and exitType ~= TS.TRY_CONTINUE then
			if not catchSuccess then
				error(catchError, 2)
			end
			if not trySuccess and not catchFn then
				error(tryError, 2)
			end
		end

		return exitType, returns
	end

	function TS.bit_lrsh(a, b)
		return bit32.arshift(a, b)
	end

	return TS
end

function shimLoadModule(scriptObj)
	local path = scriptObj.__path
	local cached = shimCache[path]
	if cached ~= nil then
		return cached
	end

	local filePath = shimResolveFile(path)
	if not filePath then
		error("module not found: " .. path, 2)
	end

	_G[scriptObj] = shimBuildTS()

	local source = "local script, task, warn = ..., _G.task, _G.warn\\n" .. shimFs.readFile(filePath)
	local chunk = luau.load(source, { debugName = path })
	local result = chunk(scriptObj)
	shimCache[path] = result
	return result
end

local function rbxRequire(path)
	return shimLoadModule(shimMakeScript(path))
end`;
}
