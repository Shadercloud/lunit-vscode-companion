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
 * The toolbar icon is one of Roblox Studio's own bundled icons, referenced
 * via `rbxasset://` -- no upload, no local image file, no network access
 * needed, so it's guaranteed to actually load. Modeled directly on
 * https://github.com/Shadercloud/rbxts-react-screenshot-plugin's own
 * `TOOLBAR_ICON` (a bundled Camera icon), including its finding that an
 * unrelated "Unable to load plugin icon. Image may have an invalid or
 * unknown format." line shows up in the Output panel regardless of this
 * icon -- confirmed there even with the toolbar icon left completely blank,
 * so it's not a symptom of anything wrong with this one either.
 *
 * A hand-generated local PNG file was tried first and rendered as a tiny,
 * indistinct circle in Studio's toolbar -- almost certainly Studio's default
 * placeholder for a custom icon it couldn't actually load via that
 * mechanism, not the real image, matching why the reference plugin above
 * avoided local/custom icons entirely. There's no literal test tube/flask/
 * beaker among Studio's ~2,400 bundled icons (checked directly against a
 * real Studio install's own `content/studio_svg_textures/` folder); this is
 * `TestService`'s icon (a checkmark in a circle) -- Roblox's own closest
 * "testing"-flavored one.
 */
const TOOLBAR_ICON = 'rbxasset://studio_svg_textures/Shared/InsertableObjects/Dark/Standard/TestService.png';

export function buildStudioPluginScript(port: number): string {
	return `--!strict
-- Lunit Studio Bridge -- installed by the "Lunit: Install Roblox Studio
-- Plugin" VS Code command. Safe to reinstall/overwrite at any time; re-run
-- that command after updating the extension to pick up changes here.

local HttpService = game:GetService("HttpService")

local BASE_URL = "http://127.0.0.1:${port}"
local POLL_INTERVAL_SECONDS = 1.5

local toolbar = plugin:CreateToolbar("Lunit")
local toggleButton = toolbar:CreateButton(
	"LunitBridgeToggle",
	"Lunit test bridge: polling for VS Code test runs. Click to pause/resume.",
	"${TOOLBAR_ICON}",
	"Lunit"
)

local running = true
toggleButton:SetActive(running)

toggleButton.Click:Connect(function()
	running = not running
	toggleButton:SetActive(running)
end)

local function runJob(code: string): string
	local fn, compileErr = loadstring(code)
	if not fn then
		return "[lunit] failed to compile job: " .. tostring(compileErr)
	end
	local ok, result = pcall(fn)
	if not ok then
		return "[lunit] job errored: " .. tostring(result)
	end
	return tostring(result)
end

local function poll()
	local requestOk, response = pcall(function()
		return HttpService:RequestAsync({
			Url = BASE_URL .. "/poll",
			Method = "GET",
		})
	end)
	if not requestOk or not response.Success then
		return
	end

	local decodeOk, body = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not decodeOk or not body or not body.jobId then
		return
	end

	local output = runJob(body.code)

	pcall(function()
		HttpService:RequestAsync({
			Url = BASE_URL .. "/result",
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = HttpService:JSONEncode({ jobId = body.jobId, output = output }),
		})
	end)
end

local alive = true
plugin.Unloading:Connect(function()
	alive = false
end)

task.spawn(function()
	while alive do
		if running then
			poll()
		end
		task.wait(POLL_INTERVAL_SECONDS)
	end
end)
`;
}
