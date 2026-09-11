import { BRIDGE_PORT_COUNT } from './liveSyncBridge';

/** Shares the plugin's selected/busy/alive state; does not use PluginAction APIs. */
export function buildStudioPickerScript(): string {
	return `
local widget = plugin:CreateDockWidgetPluginGuiAsync("LunitWorkspacePanel", DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Float, false, true, 480, 340, 320, 240
))
widget.Title = "Lunit — Connect to VS Code"

local function ui(className, name, properties, parent)
	local object = Instance.new(className)
	object.Name = name
	for key, value in properties do object[key] = value end
	object.Parent = parent
	return object
end
local background = Color3.fromRGB(32, 34, 39)
local foreground = Color3.fromRGB(235, 237, 242)
local muted = Color3.fromRGB(185, 191, 204)
local surface = Color3.fromRGB(47, 51, 59)
local root = ui("Frame", "LunitPanel", {Size = UDim2.fromScale(1, 1), BackgroundColor3 = background, BorderSizePixel = 0}, widget)
local function label(name, text, position, size, parent)
	return ui("TextLabel", name, {Text = text, Position = position, Size = size, BackgroundTransparency = 1,
		TextColor3 = foreground, TextSize = 14, Font = Enum.Font.SourceSans, TextWrapped = true,
		TextXAlignment = Enum.TextXAlignment.Left, TextYAlignment = Enum.TextYAlignment.Top}, parent)
end
local heading = label("Heading", "VS Code connection", UDim2.fromOffset(8, 6), UDim2.new(1, -16, 0, 22), root)
heading.Font = Enum.Font.SourceSansSemibold
heading.TextSize = 18
local connectionLabel = label("ConnectionStatus", "No workspace selected.", UDim2.fromOffset(8, 30), UDim2.new(1, -16, 0, 32), root)
local function button(name, text, position, size, parent)
	return ui("TextButton", name, {Text = text, Position = position, Size = size, BackgroundColor3 = surface,
		BorderSizePixel = 0, TextColor3 = foreground, TextSize = 15, Font = Enum.Font.SourceSansSemibold}, parent)
end
local startStopButton = button("StartStopBridge", "Start", UDim2.fromOffset(8, 66), UDim2.fromOffset(80, 26), root)
local refreshButton = button("RefreshWorkspaces", "Refresh", UDim2.fromOffset(94, 66), UDim2.fromOffset(80, 26), root)
local discoveryLabel = label("DiscoveryStatus", "Click Refresh to find open workspaces.", UDim2.fromOffset(8, 98), UDim2.new(1, -16, 0, 34), root)
discoveryLabel.TextColor3 = muted
local list = ui("ScrollingFrame", "Workspaces", {Position = UDim2.fromOffset(8, 136), Size = UDim2.new(1, -16, 1, -144),
	BackgroundTransparency = 1, BorderSizePixel = 0, ScrollBarThickness = 6,
	CanvasSize = UDim2.fromOffset(0, 0), AutomaticCanvasSize = Enum.AutomaticSize.Y}, root)
ui("UIListLayout", "Layout", {Padding = UDim.new(0, 4), SortOrder = Enum.SortOrder.LayoutOrder}, list)

local rows = {}
local WORKSPACE_SETTING = "LunitSelectedWorkspace"
local readOk, savedWorkspace = pcall(function() return plugin:GetSetting(WORKSPACE_SETTING) end)
if not readOk or type(savedWorkspace) ~= "string" or savedWorkspace == "" then savedWorkspace = nil end
local function workspaceKey(workspaces)
	local paths = {}
	for _, workspace in workspaces do
		if type(workspace.path) ~= "string" or workspace.path == "" then return nil end
		local path = string.gsub(workspace.path, string.char(92), "/")
		if string.match(path, "^%a:") or string.sub(path, 1, 2) == "//" then path = string.lower(path) end
		-- Encoding avoids characters that Studio's settings JSON cannot safely store.
		table.insert(paths, HttpService:UrlEncode(path))
	end
	table.sort(paths)
	return #paths > 0 and table.concat(paths, "|") or nil
end
local function rememberWorkspace(target)
	if not target.acceptsRuns or not target.workspaceKey then return end
	savedWorkspace = target.workspaceKey
	local ok, failure = pcall(function() plugin:SetSetting(WORKSPACE_SETTING, savedWorkspace) end)
	if not ok then warn("[lunit] Connected, but could not remember the workspace: " .. tostring(failure)) end
end
local startupAutoConnect = true
local discoveryThreads = {}
local discoveryGeneration = 0
local discoveryTimeout = nil
local function cancelDiscovery()
	discoveryGeneration += 1
	for _, thread in discoveryThreads do pcall(task.cancel, thread) end
	discoveryThreads = {}
	if discoveryTimeout then pcall(task.cancel, discoveryTimeout) end
	discoveryTimeout = nil
end
local function updateConnectionStatus(message)
	connectionLabel.Text = message or (selected and ((running and "Selected: " or "Stopped: ") .. selected.label) or "No workspace selected.")
	startStopButton.Text = running and "Stop" or "Start"
	selectButton:SetActive(running and selected ~= nil)
	for _, entry in rows do
		entry.button.Text = running and selected and selected.instanceId == entry.target.instanceId and "Selected" or "Connect"
	end
end
startStopButton.Activated:Connect(function()
	startupAutoConnect = false
	if busy then
		updateConnectionStatus("A request or test run is in progress. Stop after it finishes.")
		return
	end
	if not running and not selected then
		updateConnectionStatus("Choose a workspace below and click Connect to start.")
		return
	end
	running = not running
	connectionWarning = false
	updateConnectionStatus()
	print(running and "[lunit] Bridge started." or "[lunit] Bridge stopped.")
end)
local function addWorkspace(target, order)
	local row = ui("Frame", "WorkspaceRow", {Size = UDim2.new(1, -6, 0, 44), AutomaticSize = Enum.AutomaticSize.Y,
		BackgroundColor3 = surface, BorderSizePixel = 0, LayoutOrder = order}, list)
	local text = label("WorkspaceDetails", target.label, UDim2.fromOffset(6, 4), UDim2.new(1, -94, 0, 36), row)
	text.AutomaticSize = Enum.AutomaticSize.Y
	local connect = button("ConnectWorkspace", "Connect", UDim2.new(1, -80, 0, 6), UDim2.fromOffset(74, 26), row)
	connect.BackgroundColor3 = Color3.fromRGB(36, 100, 171)
	table.insert(rows, {frame = row, button = connect, target = target})
	connect.Activated:Connect(function()
		startupAutoConnect = false
		if busy then
			updateConnectionStatus("A request or test run is in progress. Switch workspaces after it finishes.")
			return
		end
		selected = target
		rememberWorkspace(target)
		running = true
		connectionWarning = false
		updateConnectionStatus()
		print("[lunit] Selected VS Code: " .. target.label)
	end)
	updateConnectionStatus()
end
local function refreshWorkspaces()
	cancelDiscovery()
	local generation = discoveryGeneration
	for _, entry in rows do entry.frame:Destroy() end
	rows = {}
	discoveryLabel.Text = "Looking for VS Code workspaces..."
	print("[lunit] Looking for VS Code workspaces...")
	local pending = math.min(${BRIDGE_PORT_COUNT}, 65536 - BASE_PORT)
	local found = 0
	local lastError = ""
	local function finish(timedOut)
		if not alive or generation ~= discoveryGeneration then return end
		if startupAutoConnect then
			startupAutoConnect = false
			-- Use the first VS Code window in port order, not the fastest HTTP
			-- response. Explicit selection or Start/Stop cancels startup selection.
			local first = nil
			local remembered = nil
			for _, entry in rows do
				if entry.target.acceptsRuns and (not first or entry.target.port < first.port) then first = entry.target end
				if savedWorkspace and entry.target.acceptsRuns and entry.target.workspaceKey == savedWorkspace
					and (not remembered or entry.target.port < remembered.port) then remembered = entry.target end
			end
			first = remembered or first
			if first and not selected and not busy then
				selected = first
				-- Keep an unavailable preference so a temporary fallback does not erase it.
				if not savedWorkspace then rememberWorkspace(first) end
				running = true
				connectionWarning = false
				updateConnectionStatus()
				print("[lunit] Automatically selected VS Code: " .. first.label)
			end
		end
		if found == 0 then
			discoveryLabel.Text = "No workspaces found. Open your project with the updated Lunit extension, then Refresh. See Output for details."
			if timedOut and lastError == "" then lastError = "Discovery reached its time limit." end
			warn("[lunit] No compatible workspaces found on ports " .. tostring(BASE_PORT) .. "–" .. tostring(BASE_PORT + ${BRIDGE_PORT_COUNT - 1}) .. ". " .. lastError)
		else
			-- Unused discovery ports may time out. That does not indicate a
			-- problem with a workspace we successfully found or connected to.
			discoveryLabel.Text = tostring(found) .. " workspace(s) found. Click Connect to select one."
		end
	end
	for candidate = BASE_PORT, math.min(65535, BASE_PORT + ${BRIDGE_PORT_COUNT - 1}) do
		discoveryThreads[candidate] = task.defer(function()
			local ok, failure = pcall(function()
				local baseUrl = "http://127.0.0.1:" .. tostring(candidate)
				local response = HttpService:RequestAsync({Url = baseUrl .. "/info", Method = "GET"})
				if not alive or generation ~= discoveryGeneration then return end
				if not response.Success then lastError = "HTTP " .. tostring(response.StatusCode); return end
				local info = HttpService:JSONDecode(response.Body)
				if type(info) ~= "table" or info.protocol ~= "lunit-bridge-1" or type(info.instanceId) ~= "string" or type(info.workspaces) ~= "table" then return end
				local names = {}
				for _, workspace in info.workspaces do
					table.insert(names, workspace.name .. " — " .. workspace.path)
				end
				local name = #names > 0 and table.concat(names, "; ") or (info.acceptsRuns and "Empty VS Code window" or "Standalone Lunit CLI")
				found += 1
				addWorkspace({baseUrl = baseUrl, port = candidate, acceptsRuns = info.acceptsRuns == true, workspaceKey = workspaceKey(info.workspaces), instanceId = info.instanceId, label = name .. " (" .. tostring(info.pid) .. ")"}, candidate)
				discoveryLabel.Text = "Looking for VS Code workspaces... " .. tostring(found) .. " found. You can connect now."
			end)
			if not alive or generation ~= discoveryGeneration then return end
			if not ok then lastError = tostring(failure) end
			pending -= 1
			if pending == 0 then finish(false) end
		end)
	end
	discoveryTimeout = task.delay(10, function()
		if generation ~= discoveryGeneration or not alive then return end
		if pending > 0 then
			finish(true)
			discoveryTimeout = nil
			cancelDiscovery()
		end
	end)
end
refreshButton.Activated:Connect(refreshWorkspaces)
selectButton.Click:Connect(function()
	-- Show the panel before starting any network request, including during a run.
	widget.Enabled = true
	refreshWorkspaces()
end)
-- Discover once on plugin startup without opening the window.
refreshWorkspaces()
`;
}
