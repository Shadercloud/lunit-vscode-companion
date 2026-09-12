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
 *   GET  {baseUrl}/poll   -> { jobId: string, code: string } | { jobId: null }
 *   POST {baseUrl}/result <- { jobId: string, output: string }
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
export function buildStudioPluginScript(port: number): string {
	return `--!strict
-- Lunit Studio Bridge -- installed by the "Lunit: Install Roblox Studio
-- Plugin" VS Code command. Safe to reinstall/overwrite at any time; re-run
-- that command after updating the extension to pick up changes here.

local HttpService = game:GetService("HttpService")

local BASE_PORT = ${port}
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

print("[lunit] Connecting automatically. Click Lunit to manage the bridge connection.")

local function runJob(code: string): string
	local fn, compileErr = loadstring(code)
	if not fn then
		return "[lunit] ERROR: failed to compile job: " .. tostring(compileErr)
	end
	local owner = {}
	activeOwner = owner
	local ok, result = pcall(fn, owner)
	if owner.cleanup then pcall(owner.cleanup) end
	activeOwner = nil
	if not ok then
		return "[lunit] ERROR: job errored: " .. tostring(result)
	end
	return tostring(result)
end

local function poll()
	local target = selected
	if not target then return end
	local query = "?instanceId=" .. HttpService:UrlEncode(target.instanceId)
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

	local output = runJob(body.code)

	-- A result acknowledges cleanup. Retry delivery before accepting another
	-- job, so a transient HTTP failure cannot strand the extension's run lock.
	while alive do
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
