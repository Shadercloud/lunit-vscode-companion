/**
 * Builds a small, fully self-contained Rojo project file dedicated to
 * running tests in Roblox Studio -- deliberately NOT the workspace's own
 * `default.project.json` (the project may not even have one; library
 * packages like `@rbxts/react-clean-ui` typically don't, since they're never
 * built into a real place on their own).
 *
 * Maps:
 *   ReplicatedStorage.rbxts_include                              <- node_modules/roblox-ts/include
 *   ReplicatedStorage.rbxts_include.node_modules[scope]           <- node_modules/<scope>, for every "@..." scope folder with Luau content
 *   ReplicatedStorage.rbxts_include.node_modules[packageScope][name] <- ${outDir} (the package/game under test, under its own scope)
 *
 * Each qualifying scope is synced wholesale with one `$path`, deliberately
 * *not* flattened package-by-package. Rojo auto-loads any nested
 * `default.project.json` a synced folder contains and renames the resulting
 * instance to that project's own `name` field (e.g. the `react-reconciler`
 * folder becomes an instance literally named `ReactReconciler`) -- and
 * hand-written compatibility shims in this ecosystem are *written expecting*
 * exactly that renamed, PascalCase layout (e.g. `@rbxts/react/src/init.lua`
 * does `script.Parent.Parent:WaitForChild("@rbxts-js").React`). See
 * studioRunner.ts's findNodeModuleScopes for the fuller history here: an
 * earlier version tried to route around the rename and broke this instead.
 *
 * Every `@`-scoped folder that contains Luau content is synced, not just
 * `@rbxts`: e.g. `@rbxts/react` itself depends on `react-lua`'s internals,
 * published under a *different* scope, `@rbxts-js`. Missing a scope doesn't
 * error -- it hangs: roblox-ts (and hand-written shims like the one above)
 * compile to `TS.getModule(...)` / `WaitForChild`-style lookups that
 * silently block forever ("Infinite yield possible") when the target was
 * never synced, rather than failing fast. Confirmed against a real Studio
 * run. Pure JS/TS tooling scopes (e.g. `@roblox-ts`, which nests its own
 * node_modules and can be 1000+ files) are excluded by the same filter,
 * since syncing one wholesale also risks a nested default.project.json Rojo
 * can't merge cleanly -- also confirmed against a real build failure.
 *
 * The package under test is deliberately mounted as if it were just another
 * dependency under its own scope, sitting alongside its real siblings, so
 * that `TS.getModule`'s ancestor walk for `node_modules` (see
 * bootstrapTemplate.ts) succeeds from anywhere inside it -- this only works
 * because neither `_G[script]` runtime bootstrapping nor `TS.getModule`
 * resolution bake in any compile-time assumption about where things end up
 * in the Rojo tree (verified by reading roblox-ts's own RuntimeLib.lua);
 * only purely-relative in-project imports are position-sensitive, and Rojo
 * preserves their relative shape automatically no matter where the whole
 * tree is mounted.
 */
export interface StudioProjectPaths {
	/**
	 * Absolute (forward-slash) path to node_modules/roblox-ts/include. Rojo
	 * accepts absolute `$path` values, so these are never computed relative
	 * to the generated project file's own location -- that file lives outside
	 * the workspace, in this extension's storage directory (see
	 * studioRunner.ts), and an absolute path sidesteps needing it and the
	 * project to be on the same filesystem drive at all.
	 */
	rbxtsIncludePath: string;
	/**
	 * Every "@scope" folder found directly under node_modules with Luau
	 * content, each mapped to its absolute (forward-slash) path.
	 */
	scopePaths: ReadonlyMap<string, string>;
	/** Absolute (forward-slash) path to the compiled outDir. */
	outDirPath: string;
	/** The scope the package under test publishes as, e.g. "@rbxts". */
	packageScope: string;
	/** The package's own name with its scope stripped, e.g. "react-clean-ui". Used as its mount name under node_modules[packageScope]. */
	packageName: string;
}

export function buildStudioProjectFile(paths: StudioProjectPaths): string {
	const nodeModules: Record<string, unknown> = { $className: 'Folder' };
	for (const [scope, scopePath] of paths.scopePaths) {
		const isPackageScope = scope === paths.packageScope;
		nodeModules[scope] = {
			$path: scopePath,
			...(isPackageScope ? { [paths.packageName]: { $path: paths.outDirPath } } : {}),
		};
	}
	// The package's scope might not otherwise exist as a real node_modules
	// folder (a project never depends on its own scope's sibling packages).
	if (!paths.scopePaths.has(paths.packageScope)) {
		nodeModules[paths.packageScope] = { $className: 'Folder', [paths.packageName]: { $path: paths.outDirPath } };
	}

	const project = {
		name: 'lunit-test-place',
		tree: {
			$className: 'DataModel',
			ReplicatedStorage: {
				$className: 'ReplicatedStorage',
				rbxts_include: {
					$path: paths.rbxtsIncludePath,
					node_modules: nodeModules,
				},
			},
		},
	};
	return JSON.stringify(project, null, '\t') + '\n';
}

/** Splits an npm package name into scope (defaulting to "@rbxts") and bare name. */
export function parsePackageName(rawName: string): { scope: string; name: string } {
	const trimmed = rawName.trim();
	if (trimmed.startsWith('@') && trimmed.includes('/')) {
		const slash = trimmed.indexOf('/');
		return { scope: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
	}
	return { scope: '@rbxts', name: trimmed };
}
