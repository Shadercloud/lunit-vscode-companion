local fs = require('@lune/fs')
local luau = require('@lune/luau')
local task = require('@lune/task')
local process = require('@lune/process')
local roblox = require('@lune/roblox')
local buttons = {}
local unloading
local calls = {}
local stale = false
local delivered = false
local expectedPort = 34873
local warnings = {}
local prints = {}
local objects = {}
local discoveryDelay = 0.15
local noWorkspaces = false
local widget
local panelIds = {}
local panelOrder = {}
local savedSettings = {}
local scenario = process.args[2]
-- abandon-hung-job: what the plugin saw and did with a job that never returns.
local hung = {polls = 0, heartbeats = 0, posted = false, cleaned = false, pollsAfterAbandon = 0}
if scenario == 'remembered-workspace' then
 savedSettings.LunitSelectedWorkspace = '/project34874'
 expectedPort = 34874
elseif scenario == 'quiet-startup' or scenario == 'debug-startup' then
 -- No VS Code is open: what a Play copy of the plugin, or a Studio window
 -- without the extension, sees at startup.
 noWorkspaces = true
elseif scenario == 'remembered-unavailable' then
 savedSettings.LunitSelectedWorkspace = '/unavailable-project'
end
local function signal()
 local callback
 return {Connect = function(_, fn) callback = fn end, fire = function() if callback then callback() end end}
end
local function newObject(className)
 local object = {ClassName = className, Activated = signal(), destroyed = false}
 function object:Destroy()
  self.destroyed = true
  for _, child in objects do if child.Parent == self then child:Destroy() end end
 end
 table.insert(objects, object)
 return object
end
local function find(name)
 for i = #objects, 1, -1 do
  local object = objects[i]
  if object.Name == name and not object.destroyed then return object end
 end
 error('UI not found: ' .. name)
end
local plugin = {
 GetSetting = function(_, key) return savedSettings[key] end,
 SetSetting = function(_, key, value) savedSettings[key] = value end,
 CreatePluginAction = function() error('picker must not use PluginAction') end,
 CreatePluginMenu = function() error('picker must not use popup menus') end,
 CreateDockWidgetPluginGuiAsync = function(_, id)
  assert(id:sub(1, 20) == 'LunitWorkspacePanel_', 'panel layout id must be window specific: ' .. id)
  assert(not panelIds[id], 'panel layout ids must not be reused: ' .. id)
  panelIds[id] = true
  table.insert(panelOrder, id)
  local panel = newObject('DockWidgetPluginGui')
  panel.Enabled = false
  if scenario == 'panel-layout-owned' and #panelOrder == 1 then
   -- Studio ignores Enabled when another open Studio window owns this layout.
   widget = setmetatable({}, {__index = panel, __newindex = function(_, key, value)
    if key == 'Enabled' and value == true then return end
    panel[key] = value
   end})
   return widget
  end
  widget = panel
  return panel
 end,
 Unloading = {Connect = function(_, callback) unloading = callback end},
 CreateToolbar = function()
  return {CreateButton = function(_, id, tooltip, icon, text)
   assert(next(buttons) == nil, 'plugin must have exactly one ribbon button')
   assert(icon == 'rbxassetid://14098599607', 'wrong ribbon icon')
   assert(text == 'Lunit', 'ribbon text must remain Lunit')
   local button = {SetActive = function() end}
   button.Click = {Connect = function(_, callback) button.click = callback end}
   buttons[id] = button
   return button
  end}
 end,
}
local http = {}
function http:JSONDecode(value) return value end
function http:JSONEncode(value) return value end
function http:UrlEncode(value) return value end
function http:RequestAsync(request)
 table.insert(calls, request)
 local port = tonumber(request.Url:match(':(%d+)/'))
 if request.Url:find('/info', 1, true) then
  if process.args[2] == 'slow-unused-ports' and port >= 34875 then task.wait(60) end
  task.wait(discoveryDelay + (port == 34873 and 0.05 or 0))
  if noWorkspaces then return {Success = false, StatusCode = 404} end
  if port ~= 34873 and port ~= 34874 then return {Success = false} end
  return {Success = true, Body = {
   protocol = 'lunit-bridge-1', instanceId = 'id' .. tostring(port), pid = port,
   workspaces = {{name = port == 34873 and 'A' or 'B', path = '/project' .. tostring(port)}}, acceptsRuns = true,
  }}
 end
 assert(port == expectedPort, 'must not poll or post results to the unselected workspace')
 assert(request.Url:find('instanceId=id' .. tostring(expectedPort), 1, true), 'missing selected window identity')
 if scenario == 'abandon-hung-job' then
  assert(request.Url:find('session=', 1, true), 'every bridge request must name its plugin session')
  if request.Method == 'POST' then hung.posted = true; return {Success = true} end
  if request.Url:find('/heartbeat', 1, true) then
   assert(request.Url:find('jobId=hung', 1, true), 'heartbeat must name its job')
   hung.heartbeats += 1
   -- VS Code keeps the job for one heartbeat, then the user presses Stop.
   return {Success = true, Body = {active = hung.heartbeats < 2}}
  end
  hung.polls += 1
  if hung.polls == 1 then return {Success = true, Body = {jobId = 'hung', code = 'local owner = ...\nowner.cleanup = CLEANED\ncoroutine.yield()\nreturn "never"'}} end
  if hung.cleaned then hung.pollsAfterAbandon += 1 end
  return {Success = true, Body = {}}
 end
 if port == 34873 then return {Success = true, Body = {}} end
 if stale then return {Success = false, StatusCode = 409} end
 if request.Method == 'POST' then
  assert(request.Body.jobId == 'job' and request.Body.output == 'done')
  delivered = true
  return {Success = true}
 end
 return {Success = true, Body = delivered and {} or {jobId = 'job', code = 'return "done"'}}
end
local environment = {
 Instance = {new = newObject}, Enum = roblox.Enum, Color3 = roblox.Color3, UDim2 = roblox.UDim2, UDim = roblox.UDim,
 DockWidgetPluginGuiInfo = {new = function(...) return {...} end},
 game = {GetService = function() return http end, PlaceId = 0, Name = 'Test Place'},
 plugin = plugin, task = task, print = function(message) table.insert(prints, message) end, warn = function(message) table.insert(warnings, message) end,
 loadstring = function(code)
  return luau.load(code, {environment = {CLEANED = function() hung.cleaned = true end}, injectGlobals = true})
 end,
}
luau.load(fs.readFile(process.args[1]), {environment = environment, injectGlobals = true})()
task.wait(0.02)
assert(not widget.Enabled, 'startup discovery should not open the panel')
assert(#calls == 20, 'startup must automatically discover windows')
assert(find('DiscoveryStatus').Text:find('Looking for', 1, true))
if scenario == 'remembered-workspace' or scenario == 'remembered-unavailable' then
 local remembered = savedSettings.LunitSelectedWorkspace
 task.wait(1.8)
 assert(find('ConnectionStatus').Text:find('/project' .. tostring(expectedPort), 1, true), 'startup must prefer the remembered workspace, or fall back when unavailable')
 assert(savedSettings.LunitSelectedWorkspace == remembered, 'automatic fallback must preserve the saved preference')
 assert(#calls > 20, 'restored selection must poll')
 unloading()
 print('Remembered workspace startup regression checks passed: ' .. scenario)
 process.exit(0)
end
if scenario == 'quiet-startup' then
 task.wait(0.3)
 assert(find('DiscoveryStatus').Text:find('No workspaces found', 1, true), 'empty results must still show in the panel')
 assert(#prints == 0, 'without debug, startup must print nothing: ' .. table.concat(prints, '\n'))
 assert(#warnings == 0, 'without debug, an empty startup scan must not warn: ' .. table.concat(warnings, '\n'))
 find('RefreshWorkspaces').Activated.fire()
 task.wait(0.3)
 assert(#warnings == 1 and warnings[1]:find('No compatible workspaces', 1, true), 'a Refresh that finds nothing must warn')
 assert(#prints == 0, 'without debug, a Refresh must print nothing')
 unloading()
 print('Quiet startup regression checks passed')
 process.exit(0)
end
if scenario == 'debug-startup' then
 task.wait(0.3)
 assert(table.concat(prints, '\n'):find('Connecting automatically', 1, true), 'debug must print the startup line')
 assert(table.concat(prints, '\n'):find('Looking for VS Code workspaces', 1, true), 'debug must print discovery')
 assert(#warnings == 1 and warnings[1]:find('No compatible workspaces', 1, true), 'debug must report an empty startup scan')
 unloading()
 print('Debug startup regression checks passed')
 process.exit(0)
end
if scenario == 'abandon-hung-job' then
 -- Startup connects to the first window, which delivers a job that never
 -- returns. When VS Code stops wanting it, the plugin cancels it, cleans up,
 -- posts nothing and goes back to polling: no Studio restart needed.
 local deadline = os.clock() + 8
 while hung.pollsAfterAbandon == 0 and os.clock() < deadline do task.wait(0.05) end
 assert(hung.heartbeats >= 2, 'a running job must heartbeat')
 assert(hung.cleaned, 'an abandoned job must be cleaned up')
 assert(not hung.posted, 'an abandoned job must not post a result')
 assert(hung.pollsAfterAbandon > 0, 'the bridge must poll again after abandoning a job')
 local abandonWarning = false
 for _, message in warnings do
  if message:find('stopped or released the running test job', 1, true) then abandonWarning = true end
 end
 assert(abandonWarning, 'abandoning must say so: ' .. table.concat(warnings, '\n'))
 unloading()
 print('Hung job abandonment regression checks passed')
 process.exit(0)
end
if scenario == 'panel-layout-owned' then
 buttons.LunitOpenConnection.click()
 assert(#panelOrder == 2, 'a window that cannot show its panel must claim its own layout')
 assert(widget.Enabled, 'the replacement panel must open')
 assert(find('LunitPanel').Parent == widget, 'panel contents must move to the replacement widget')
 unloading()
 print('Panel layout contention regression checks passed')
 process.exit(0)
end
if process.args[2] == 'slow-unused-ports' then
 task.wait(10.8)
 assert(find('DiscoveryStatus').Text:find('2 workspace(s) found', 1, true))
 assert(not find('DiscoveryStatus').Text:find('timed out', 1, true), 'unused ports must not show a connection warning')
 assert(#warnings == 0, table.concat(warnings, '\n'))
 assert(find('StartStopBridge').Text == 'Stop', 'discovery deadline must still auto-connect to an available window')
 assert(#calls > 20, 'connected workspace must continue polling')
 unloading()
 print('Unused discovery port timeout regression checks passed')
 process.exit(0)
end
if process.args[2] == 'cancel-startup' then
 find('StartStopBridge').Activated.fire()
 task.wait(1.7)
 assert(find('StartStopBridge').Text == 'Start', 'user controls must override startup auto-connect')
 assert(#calls == 20, 'cancelled startup selection must never poll')
 unloading()
 print('Startup auto-connect cancellation regression checks passed')
 process.exit(0)
end
task.wait(0.3)
assert(#calls == 20, 'discovery should only call info endpoints')
assert(find('DiscoveryStatus').Text:find('2 workspace(s)', 1, true))
assert(find('StartStopBridge').Text == 'Stop')
assert(find('ConnectionStatus').Text:find('/project34873', 1, true), 'startup must choose the first port even if it responds later')
task.wait(1.6)
assert(#calls > 20, 'startup selection must begin polling without a click')
buttons.LunitOpenConnection.click()
assert(widget.Enabled, 'panel must open before discovery finishes')
task.wait(0.3)
local function connectB()
 for _, object in objects do
  if object.Name == 'WorkspaceDetails' and not object.destroyed and object.Text:find('/project34874', 1, true) then
   for _, child in objects do
    if child.Parent == object.Parent and child.Name == 'ConnectWorkspace' then child.Activated.fire(); return end
   end
  end
 end
 error('workspace B row not found')
end
expectedPort = 34874
connectB()
assert(savedSettings.LunitSelectedWorkspace == '/project34874', 'manual selection must persist the workspace path')
assert(find('ConnectionStatus').Text:find('Selected:', 1, true))
for _ = 1, 3 do find('RefreshWorkspaces').Activated.fire(); task.wait(0.3) end
local liveRows = 0
for _, object in objects do
 if object.Name == 'WorkspaceRow' and not object.destroyed then liveRows += 1 end
end
assert(liveRows == 2, 'refresh must replace rows rather than accumulate them')
assert(#warnings == 0, table.concat(warnings, '\n'))
task.wait(1.6)
assert(delivered, 'selected workspace did not receive job result')
assert(find('StartStopBridge').Text == 'Stop')
find('StartStopBridge').Activated.fire()
assert(find('StartStopBridge').Text == 'Start')
assert(find('ConnectionStatus').Text:find('Stopped:', 1, true))
local stoppedCalls = #calls
task.wait(1.6)
assert(#calls == stoppedCalls, 'Stop must suspend bridge polling')
find('StartStopBridge').Activated.fire()
assert(find('StartStopBridge').Text == 'Stop')
task.wait(1.6)
assert(#calls > stoppedCalls, 'Start must reconnect to the retained workspace')
stale = true
task.wait(1.6)
assert(find('ConnectionStatus').Text:find('closed or reloaded', 1, true))
local count = #calls
task.wait(1.6)
assert(#calls == count, 'stale selection must stop polling')
assert(find('StartStopBridge').Text == 'Start', 'closed window must reset bridge controls')
noWorkspaces = true
find('RefreshWorkspaces').Activated.fire()
task.wait(0.3)
assert(find('DiscoveryStatus').Text:find('No workspaces found', 1, true), 'empty results must be visible in the panel')
-- A refresh supersedes delayed results from the previous scan.
noWorkspaces = false
discoveryDelay = 0.5
find('RefreshWorkspaces').Activated.fire()
find('RefreshWorkspaces').Activated.fire()
task.wait(0.6)
local refreshedRows = 0
for _, object in objects do
 if object.Name == 'WorkspaceRow' and not object.destroyed then refreshedRows += 1 end
end
assert(refreshedRows == 2, 'cancelled scans must not add duplicate rows')
widget.Enabled = false
buttons.LunitOpenConnection.click()
assert(widget.Enabled, 'toolbar must reopen a closed panel')
unloading()
assert(widget.destroyed, 'unloading must destroy the panel')
local unloadedCalls = #calls
task.wait(1.6)
assert(#calls == unloadedCalls, 'unloaded plugin must stop all HTTP requests')
print('Studio workspace panel regression checks passed')
-- Explicitly end the standalone harness after verifying shutdown; Lune can
-- retain cancelled deferred timers even though their coroutines no longer run.
process.exit(0)
