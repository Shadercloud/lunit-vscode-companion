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
 *   POST {baseUrl}/heartbeat?jobId=   <- { jobId, phase, test?, testSeconds?, lines: string[] }
 *                                     -> { active: boolean }
 *        About once a second while a job runs, and right before each test
 *        starts (the job calls owner.announce), so VS Code reads a silence
 *        during a test that blocks Studio as busy, not dead. `lines` are the
 *        job's new output lines, so a released run keeps its results.
 *        active false: VS Code released the job, so cancel it and clean up.
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

-- Heartbeats run while a job does. Each one tells the selected window the
-- job is alive, which test (if any) is running and for how long, and carries
-- the job's new output lines, so a run VS Code has to release keeps the
-- results already in. The answer says whether the window still wants the job:
-- "no" means it was stopped, timed out or released there (or the window
-- reloaded). One request at a time; a line is only counted as sent once the
-- window acknowledged it.
local ANNOUNCE_MIN_SECONDS = 0.1
local LIVE_BATCH_SECONDS = 0.25
local LIVE_BATCH_LINES = 50
local function newHeartbeat(owner, target, query: string, jobId: string)
	-- failingSince: when requests started failing (nil while they get through).
	-- A blocked main thread delays heartbeats but never fails them, so only
	-- real failures (VS Code gone) count towards abandoning the job.
	local state = { inFlight = false, lastSent = 0, failingSince = nil, released = false, sentLines = 0 }
	local function failed()
		state.failingSince = state.failingSince or os.clock()
	end
	function state.send()
		if state.inFlight or state.released then return end
		state.inFlight = true
		state.lastSent = os.clock()
		local output = owner.output
		local upTo = type(output) == "table" and #output or 0
		local lines = {}
		for index = state.sentLines + 1, upTo do table.insert(lines, output[index]) end
		local test = owner.currentTest
		local started = owner.currentTestStarted
		local ok, response = pcall(function()
			return HttpService:RequestAsync({
				Url = target.baseUrl .. "/heartbeat" .. query .. "&jobId=" .. HttpService:UrlEncode(jobId),
				Method = "POST",
				Headers = { ["Content-Type"] = "application/json" },
				Body = HttpService:JSONEncode({
					jobId = jobId,
					phase = owner.phase,
					test = test,
					testSeconds = (test ~= nil and type(started) == "number") and (os.clock() - started) or nil,
					lines = lines,
				}),
			})
		end)
		state.inFlight = false
		if not ok then failed() return end
		if response.StatusCode == 409 then state.released = true return end
		if not response.Success then failed() return end
		state.failingSince = nil
		state.sentLines = upTo
		local decodeOk, body = pcall(function() return HttpService:JSONDecode(response.Body) end)
		if decodeOk and type(body) == "table" and body.active == false then state.released = true end
	end
	return state
end

-- Runs the job on its own thread so this one can keep heartbeating. When VS
-- Code no longer wants the job, it is cancelled and cleaned up here, so a job
-- that never returns can never wedge the bridge. Returns nil when abandoned.
local function runJob(code: string, target, query: string, jobId: string): string?
	local fn, compileErr = loadstring(code)
	if not fn then
		return "[lunit] ERROR: failed to compile job: " .. tostring(compileErr)
	end
	local owner = { protocol = 3 }
	local heartbeat = newHeartbeat(owner, target, query, jobId)
	-- The job calls this as each test starts. It sends a heartbeat naming the
	-- test right away, from its own thread: the request is on its way before a
	-- test that blocks Studio's main thread begins, so VS Code knows the
	-- silence that follows is that test, not a dead Studio.
	owner.announce = function()
		if not heartbeat.inFlight and os.clock() - heartbeat.lastSent >= ANNOUNCE_MIN_SECONDS then
			task.spawn(heartbeat.send)
		end
	end
	activeOwner = owner
	local finished, ok, result = false, false, nil
	local jobThread = coroutine.create(function()
		ok, result = pcall(fn, owner)
		finished = true
	end)
	activeJobThread = jobThread
	task.spawn(jobThread)
	local abandoned = false
	while not finished and alive do
		task.wait(0.1)
		-- Heartbeat once a second; sooner when output is waiting, so results
		-- reach VS Code in batches (every 250 ms, or every 50 lines).
		local pending = (type(owner.output) == "table" and #owner.output or 0) - heartbeat.sentLines
		local sinceSent = os.clock() - heartbeat.lastSent
		if not finished and (sinceSent >= HEARTBEAT_SECONDS or pending >= LIVE_BATCH_LINES
			or (pending > 0 and sinceSent >= LIVE_BATCH_SECONDS)) then
			heartbeat.send()
		end
		if not finished and (heartbeat.released or (heartbeat.failingSince ~= nil and os.clock() - heartbeat.failingSince >= UNREACHABLE_ABANDON_SECONDS)) then
			abandoned = true
			break
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
