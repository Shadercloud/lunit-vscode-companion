-- Fails at load: the discovery step must report it as a load failure and the
-- run must go on without it.
local TS = _G[script]
error("this module cannot be loaded on purpose")
