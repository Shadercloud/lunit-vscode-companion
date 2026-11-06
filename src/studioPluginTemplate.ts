/**
 * The companion Roblox Studio plugin for the live-sync fast path (see
 * liveSyncBridge.ts, liveSyncScriptTemplate.ts). Installed once via the
 * "Lunit: Install Roblox Studio Plugin" command, which copies this file into
 * Studio's Plugins folder -- from then on it loads automatically whenever
 * Studio opens and polls a local HTTP server the extension starts.
 *
 * Deliberately a *plugin*, not a normal Script: Roblox only runs ordinary
 * Scripts while a place is actually simulating (Play/Run), but plugins run
 * continuously the whole time Studio is open, in Edit mode too -- which is
 * exactly what makes running tests without ever pressing Play possible.
 *
 * Protocol (127.0.0.1-only, see liveSyncBridge.ts):
 *   GET  {baseUrl}/poll?session=      -> { jobId: string, code: string } | { jobId: null }
 *   GET  {baseUrl}/heartbeat?jobId=   -> { active: boolean }  (about once a second while a job runs;
 *                                        false: VS Code released the job, so cancel it and clean up)
 *   POST {baseUrl}/result             <- { jobId: string, output: string }
 * Every request carries the selected window's instanceId and this plugin's session id.
 *
 * `code` is `loadstring`'d and called directly; its return value (a plain
 * string -- see liveSyncScriptTemplate.ts) becomes `output`. Trust model:
 * this executes whatever the local server on the configured port sends it,
 * unauthenticated, same as Rojo's own `rojo serve` -- a deliberate, common
 * localhost-only trust boundary, not an oversight.
 *
 */
import { buildStudioPickerScript } from './studioPickerTemplate';
const TOOLBAR_ICON = 'rbxassetid://14098599607';
/**
 * `debug` (the `lunit.studio.debug` setting, baked in at install) shows the
 * bridge's status lines in Studio's Output: discovery, connecting, selecting.
 * Off, the bridge stays silent unless something goes wrong.
 */
export function buildStudioPluginScript(port: number, debug = false): string {
	return `--!strict
-- Lunit Studio Bridge -- installed by the "Lunit: Install Roblox Studio
-- Plugin" VS Code command. Safe to reinstall/overwrite at any time; re-run
-- that command after updating the extension to pick up changes here.

local HttpService = game:GetService("HttpService")

local BASE_PORT = ${port}
local DEBUG = ${debug ? 'true' : 'false'}

local function debugPrint(message: string)
	if DEBUG then print(message) end
end
local POLL_INTERVAL_SECONDS = 1.5

local toolbar = plugin:CreateToolbar("Lunit")
local running = false

local alive = true
local activeOwner = nil
local activeThread = nil
local selected = nil
local busy = false
local connectionWarning = false
local selectButton = toolbar:CreateButton("LunitOpenConnection", "Open Lunit bridge connection settings", "${TOOLBAR_ICON}", "Lunit")
selectButton.ClickableWhenViewportHidden = true
${buildStudioPickerScript()}

debugPrint("[lunit] Connecting automatically. Click Lunit to manage the bridge connection.")

-- One id per loaded plugin. VS Code uses it to tell a restarted Studio (or a
-- reloaded plugin) from the session that took a job, and releases that job.
local guidOk, guid = pcall(function() return HttpService:GenerateGUID(false) end)
local SESSION_ID = guidOk and tostring(guid) or tostring(os.clock())
local HEARTBEAT_SECONDS = 1
-- A job whose VS Code window has been unreachable this long is abandoned.
local UNREACHABLE_ABANDON_SECONDS = 10
-- How long to keep retrying a result VS Code could not take, before polling again.
local RESULT_RETRY_SECONDS = 30
local activeJobThread = nil

-- Asks the selected window whether it still wants this job. "no" means the
-- run was stopped, timed out or released there (or the window reloaded).
local function jobStillWanted(target, query: string, jobId: string): boolean?
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = target.baseUrl .. "/heartbeat" .. query .. "&jobId=" .. HttpService:UrlEncode(jobId),
			Method = "GET",
		})
	end)
	if not ok then return nil end
	if response.StatusCode == 409 then return false end
	if not response.Success then return nil end
	local decodeOk, body = pcall(function() return HttpService:JSONDecode(response.Body) end)
	if not decodeOk or type(body) ~= "table" then return nil end
	return body.active == true
end

-- Runs the job on its own thread so this one can keep heartbeating. When VS
-- Code no longer wants the job, it is cancelled and cleaned up here, so a job
-- that never returns can never wedge the bridge. Returns nil when abandoned.
local function runJob(code: string, target, query: string, jobId: string): string?
	local fn, compileErr = loadstring(code)
	if not fn then
		return "[lunit] ERROR: failed to compile job: " .. tostring(compileErr)
	end
	local owner = { protocol = 2 }
	activeOwner = owner
	local finished, ok, result = false, false, nil
	local jobThread = coroutine.create(function()
		ok, result = pcall(fn, owner)
		finished = true
	end)
	activeJobThread = jobThread
	task.spawn(jobThread)
	local abandoned = false
	local lastHeartbeat, lastReached = os.clock(), os.clock()
	while not finished and alive do
		task.wait(0.1)
		if not finished and os.clock() - lastHeartbeat >= HEARTBEAT_SECONDS then
			lastHeartbeat = os.clock()
			local wanted = jobStillWanted(target, query, jobId)
			if wanted ~= nil then lastReached = os.clock() end
			if wanted == false or (wanted == nil and os.clock() - lastReached >= UNREACHABLE_ABANDON_SECONDS) then
				abandoned = true
				break
			end
		end
	end
	if not finished then
		pcall(task.cancel, jobThread)
		if abandoned then warn("[lunit] VS Code stopped or released the running test job; it was cancelled and cleaned up.") end
	end
	activeJobThread = nil
	if owner.cleanup then pcall(owner.cleanup) end
	activeOwner = nil
	if not finished then return nil end
	if not ok then
		return "[lunit] ERROR: job errored: " .. tostring(result)
	end
	return tostring(result)
end

local function poll()
	local target = selected
	if not target then return end
	local query = "?instanceId=" .. HttpService:UrlEncode(target.instanceId) .. "&session=" .. HttpService:UrlEncode(SESSION_ID)
	local requestOk, response = pcall(function()
		return HttpService:RequestAsync({
			Url = target.baseUrl .. "/poll" .. query,
			Method = "GET",
		})
	end)
	if not requestOk or not response.Success then
		if not connectionWarning then
			warn("[lunit] Cannot reach selected VS Code window: " .. target.label .. ". " .. tostring(requestOk and response.StatusCode or response))
			connectionWarning = true
			updateConnectionStatus("Cannot reach selected workspace. Reopen it or select another workspace.")
		end
		if requestOk and response.StatusCode == 409 then
			selected = nil
			running = false
			updateConnectionStatus("Selected window closed or reloaded. Click Refresh and connect again.")
			warn("[lunit] The selected window has closed or reloaded. Click Lunit to select it again.")
		end
		return
	end
	connectionWarning = false
	updateConnectionStatus("Connected: " .. target.label)

	local decodeOk, body = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not decodeOk or not body or not body.jobId then
		return
	end

	local output = runJob(body.code, target, query, body.jobId)
	if output == nil then return end

	-- Retry a transient HTTP failure for a while, but never for ever: VS Code
	-- releases the run on its own side (timeout, Stop, heartbeat loss), so a
	-- result nobody takes must not stop this bridge from polling again.
	local retryUntil = os.clock() + RESULT_RETRY_SECONDS
	while alive and os.clock() < retryUntil do
		local sent, response = pcall(function()
			return HttpService:RequestAsync({
				Url = target.baseUrl .. "/result" .. query,
				Method = "POST",
				Headers = { ["Content-Type"] = "application/json" },
				Body = HttpService:JSONEncode({ jobId = body.jobId, output = output }),
			})
		end)
		if sent and (response.Success or response.StatusCode == 409) then break end
		task.wait(POLL_INTERVAL_SECONDS)
	end
end

plugin.Unloading:Connect(function()
	alive = false
	cancelDiscovery()
	destroyPanels()
	if activeThread then pcall(task.cancel, activeThread) end
	if activeJobThread then pcall(task.cancel, activeJobThread) end
	if activeOwner and activeOwner.cleanup then pcall(activeOwner.cleanup) end
	activeOwner = nil
end)

activeThread = task.defer(function()
	while alive do
		if running and selected then
			busy = true
			local ok, failure = pcall(poll)
			busy = false
			if not ok then warn("[lunit] Bridge error: " .. tostring(failure)) end
		end
		task.wait(POLL_INTERVAL_SECONDS)
	end
end)
`;
}
