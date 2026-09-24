// Runs every check that needs Lune on PATH (or LUNE_EXE): the Studio
// live-sync and plugin scripts, the slow-tag filter, the standalone Studio
// place for a game project (which also needs Rojo on PATH, or ROJO_EXE), then
// the Lune profile against the game fixture and the package fixture.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildStudioPluginScript } = require('../out/studioPluginTemplate');
const { buildLiveSyncJobScript } = require('../out/liveSyncScriptTemplate');

async function main() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunit-regression-'));
	try {
		const script = path.join(dir, 'job.luau');
		fs.writeFileSync(script, buildLiveSyncJobScript());
		const plugin = path.join(dir, 'plugin.luau');
		fs.writeFileSync(plugin, buildStudioPluginScript(34873));
		const result = spawnSync(process.env.LUNE_EXE || 'lune', ['run', 'tests/liveSync.luau', script, plugin], { stdio: 'inherit' });
		if (result.error) throw result.error;
		if (result.status !== 0) return result.status ?? 1;
		for (const scenario of ['', 'cancel-startup', 'slow-unused-ports', 'remembered-workspace', 'remembered-unavailable', 'panel-layout-owned']) {
			const selection = spawnSync(process.env.LUNE_EXE || 'lune', ['run', 'tests/pluginSelection.luau', plugin, scenario], { stdio: 'inherit' });
			if (selection.error) throw selection.error;
			if (selection.status !== 0) return selection.status ?? 1;
		}
		require('./slowFilter.cjs')(dir);
		require('./studioTags.cjs')(dir);
		await require('./studioGame.cjs')(dir);
		await require('./luneGame.cjs')(dir);
		await require('./luneParallel.cjs')(dir);
		require('./luneCli.cjs')(dir);
		return 0;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(err) => {
		console.error(err);
		process.exitCode = 1;
	},
);
