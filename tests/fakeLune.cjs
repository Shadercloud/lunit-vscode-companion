// Stands in for the `lune` executable so tests/luneRunner.test.cjs can drive
// the real runner (scheduling, cancellation, error handling, generated files)
// without Lune. Invoked exactly as luneRunner.ts invokes Lune:
//
//   node fakeLune.cjs run <script> <testsRoot> <lunitRoot> --list
//   node fakeLune.cjs run <script> <testsRoot> <lunitRoot> --job <jobFile>
//
// Environment (passed through lunit.env):
//   FAKE_LUNE_LISTING   JSON file printed verbatim after the module marker
//   FAKE_LUNE_LOG       directory receiving start-<n>/end-<n> files per block
//   FAKE_LUNE_DISCOVERY_FAILS  when set, --list prints noise and exits 2
//
// A job's behaviour is scripted by the last segment of each module path:
//   ok[-*]         run every method in the spec, passing
//   sleep-<ms>     wait that long first, then as ok
//   hang           wait a minute (for cancellation tests)
//   crash          exit 3 after the first result line
//   nosummary      print results but no block summary
//   badsummary     print a malformed block summary
//   mismatch       print a summary counting one result too many
//   loadfail       report the module as failing to load
// Method names starting with "fail" fail; "mixed" fails its second @Each row.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const mode = args.includes('--list') ? '--list' : args.includes('--job') ? '--job' : undefined;
const logDir = process.env.FAKE_LUNE_LOG;
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
const emit = (cls, label, status, error) =>
	console.log(`@@LUNIT_RESULT@@${b64(cls)}\t${b64(label)}\t${status}\t1\t${error ? b64(error) : ''}`);
const log = (name, value) => {
	if (logDir) {
		fs.writeFileSync(path.join(logDir, name), JSON.stringify(value));
	}
};

if (mode === '--list') {
	if (process.env.FAKE_LUNE_DISCOVERY_FAILS) {
		console.log('fake lune: discovery exploded');
		process.exit(2);
	}
	console.log(`@@LUNIT_MODULES@@${fs.readFileSync(process.env.FAKE_LUNE_LISTING, 'utf8').replace(/\r?\n/g, '')}`);
	process.exit(0);
}
if (mode !== '--job') {
	console.log('fake lune: bad arguments');
	process.exit(2);
}

const jobFile = args[args.indexOf('--job') + 1];
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
const blockNumber = job.block.replace('#', '');
const startedAt = Date.now();
log(`start-${blockNumber}`, { at: startedAt, pid: process.pid, jobFile, modules: job.modules.map((m) => m.path) });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
	let results = 0;
	let failed = 0;
	const loadFailures = [];
	let lastKind = 'ok';
	for (const module of job.modules) {
		const [kind, arg] = path.basename(module.path).split('-');
		lastKind = kind;
		if (kind === 'sleep') {
			await sleep(Number(arg));
		} else if (kind === 'hang') {
			await sleep(60_000);
		} else if (kind === 'loadfail') {
			console.log(`[lunit] ERROR: failed to load test module ${module.path}: cannot load`);
			loadFailures.push({ path: module.path, error: 'cannot load' });
			continue;
		}
		console.log(`fake lune: running ${module.path}`);
		const methods = module.spec.all ? ['a'] : Object.keys(module.spec.methods);
		for (const name of methods) {
			const keep = module.spec.all ? true : module.spec.methods[name];
			const label = typeof keep === 'number' ? `${name} (row ${keep})` : name;
			const fails = name.startsWith('fail') || (name.startsWith('mixed') && keep === 2);
			if (kind === 'crash' && results >= 1) {
				console.log('fake lune: crashing now');
				process.exit(3);
			}
			emit(module.className, label, fails ? 'failed' : 'passed', fails ? `${label} went wrong` : undefined);
			results += 1;
			if (fails) {
				failed += 1;
			}
		}
	}
	log(`end-${blockNumber}`, { at: Date.now(), pid: process.pid });
	if (lastKind === 'nosummary') {
		process.exit(0);
	}
	if (lastKind === 'badsummary') {
		console.log('@@LUNIT_BLOCK@@{"results": "two"');
		process.exit(0);
	}
	const summary = {
		block: job.block,
		results: lastKind === 'mismatch' ? results + 1 : results,
		failed,
		loadFailures,
		elapsedMs: Date.now() - startedAt,
	};
	console.log(`@@LUNIT_BLOCK@@${JSON.stringify(summary)}`);
	process.exit(failed > 0 || loadFailures.length > 0 ? 1 : 0);
})();
