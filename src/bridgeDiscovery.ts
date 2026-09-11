import * as http from 'http';
import * as path from 'path';
import { BRIDGE_PORT_COUNT, BridgeWorkspace } from './liveSyncBridge';

export interface DiscoveredBridge {
	port: number;
	instanceId: string;
	workspaces: BridgeWorkspace[];
	acceptsRuns: boolean;
}

/** Discovery never polls, so it cannot claim a connection or consume a job. */
export async function discoverBridges(basePort: number, count = BRIDGE_PORT_COUNT): Promise<DiscoveredBridge[]> {
	const results = await Promise.all(Array.from({ length: Math.min(count, 65536 - basePort) }, (_, offset) =>
		new Promise<DiscoveredBridge | undefined>(resolve => {
			const port = basePort + offset;
			const req = http.get({ host: '127.0.0.1', port, path: '/info' }, res => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					body += chunk;
					if (body.length > 65536) { req.destroy(); resolve(undefined); }
				});
				res.on('error', () => resolve(undefined));
				res.on('end', () => {
					try {
						const info = JSON.parse(body);
						if (res.statusCode !== 200 || info.protocol !== 'lunit-bridge-1' || typeof info.instanceId !== 'string' ||
							!Array.isArray(info.workspaces) || !info.workspaces.every((w: BridgeWorkspace) => typeof w.name === 'string' && typeof w.path === 'string')) {
							resolve(undefined); return;
						}
						resolve({ port, instanceId: info.instanceId, workspaces: info.workspaces, acceptsRuns: info.acceptsRuns === true });
					} catch { resolve(undefined); }
				});
			});
			const deadline = setTimeout(() => { req.destroy(); resolve(undefined); }, 750);
			req.on('close', () => clearTimeout(deadline));
			req.on('error', () => resolve(undefined));
		}),
	));
	return results.filter((result): result is DiscoveredBridge => result !== undefined);
}

export function matchingBridges(bridges: DiscoveredBridge[], cwd: string): DiscoveredBridge[] {
	const ranked = bridges.filter(b => b.acceptsRuns).map(bridge => ({
		bridge,
		score: Math.max(-1, ...bridge.workspaces.map(workspace => {
			const relative = path.relative(workspace.path, cwd);
			return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
				? path.resolve(workspace.path).length : -1;
		})),
	}));
	const best = Math.max(-1, ...ranked.map(item => item.score));
	return best < 0 ? [] : ranked.filter(item => item.score === best).map(item => item.bridge);
}
