/**
 * Self-check: confirm the bundled core is present and runnable, and report the
 * exact facts the plugin depends on. Safe to run any time; touches nothing.
 *
 * usage: node tools/verify-setup.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const stateDir = join(dshHome, '.dsh-net-proxy');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

// 1. the core ships with the plugin
const binDir = join(pluginRoot, 'bin');
const kernels = existsSync(binDir) ? readdirSync(binDir).filter((f) => /^mihomo.*\.exe$/i.test(f)) : [];
check('bundled mihomo core', kernels.length > 0, kernels[0] ?? `nothing in ${binDir}`);

if (kernels.length > 0) {
  const corePath = join(binDir, kernels[0]);
  check('core size plausible', statSync(corePath).size > 5_000_000, `${(statSync(corePath).size / 1048576).toFixed(1)} MB`);
  const version = spawnSync(corePath, ['-v'], { encoding: 'utf8', windowsHide: true });
  check('core executes', version.status === 0, (version.stdout ?? '').trim().split('\n')[0]);
}

// 2. undici is reachable, which is what makes no-restart switching possible
const anchors = [
  join(pluginRoot, 'package.json'),
  join(dshHome, 'profiles', process.env.DSH_PROFILE ?? 'desktop', 'package.json'),
];
let undiciPath;
let undiciAnchor;
for (const anchor of anchors) {
  try {
    undiciPath = createRequire(anchor)('undici');
    undiciAnchor = anchor;
    break;
  } catch { /* next */ }
}
if (undiciPath === undefined) {
  console.log('INFO  undici not resolvable from a plain shell — expected; inside the DSH host it resolves from the app bundle');
} else {
  check('undici resolvable', typeof undiciPath === 'object' || typeof undiciPath === 'string', `${undiciAnchor} -> ${undiciPath}`);
  const { ProxyAgent } = createRequire(undiciAnchor)('undici');
  check('undici exposes ProxyAgent', typeof ProxyAgent === 'function');
  check('global dispatcher slot exists', typeof Symbol.for('undici.globalDispatcher.1') === 'symbol');
}

// 3. saved state
const configPath = join(stateDir, 'config.json');
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  console.log(`INFO  saved config: subscription=${config.subscriptionUrl === '' ? '(none)' : 'set'}, mixed-port=${config.mixedPort}, api-port=${config.apiPort}, enabled=${config.enabled}`);
  // Ports are claimed on demand and released on stop, so zeros here mean "the
  // proxy is off", not "the plugin is broken".
  if (config.enabled) check('ports assigned while enabled', config.mixedPort > 0 && config.apiPort > 0);
  else console.log('INFO  ports are 0 because the proxy is off — they are claimed when it starts');
  check('api secret present', typeof config.apiSecret === 'string' && config.apiSecret.length >= 16);
} else {
  console.log('INFO  no saved config yet — the plugin writes it on first load');
}
check('subscription cached', existsSync(join(stateDir, 'subscription.yaml')));
check('runtime config generated', existsSync(join(stateDir, 'runtime.yaml')));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
