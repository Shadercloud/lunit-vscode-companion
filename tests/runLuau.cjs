const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {buildStudioPluginScript} = require('../out/studioPluginTemplate');
const {buildLiveSyncJobScript} = require('../out/liveSyncScriptTemplate');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunit-regression-'));
try {
 const script = path.join(dir, 'job.luau');
 fs.writeFileSync(script, buildLiveSyncJobScript());
 const plugin = path.join(dir, 'plugin.luau');
 fs.writeFileSync(plugin, buildStudioPluginScript(34873));
 const result = spawnSync(process.env.LUNE_EXE || 'lune', ['run', 'tests/liveSync.luau', script, plugin], {stdio: 'inherit'});
 if (result.error) throw result.error;
 process.exitCode = result.status ?? 1;
} finally {
 fs.rmSync(dir, {recursive: true, force: true});
}
