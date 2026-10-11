/**
 * dsh-net-proxy — host half.
 *
 * A self-contained outbound proxy for DeepSeek Harness:
 *   - ships its own mihomo core (no Clash, no system proxy, no extra install)
 *   - imports whatever subscription link the user pastes in the UI
 *   - measures every node itself and uses the fastest
 *   - on failure, cools that node down, switches to the next, and retries
 *
 * Three decisions here are load-bearing, each learned the hard way against the
 * real core — please do not "simplify" them away:
 *
 * 1. THE SUBSCRIPTION IS NEVER RESHAPED. mihomo's YAML parser rejects duplicate
 *    mapping keys (stricter than the YAML spec), so prepending our own keys
 *    fails, and moving a block out of the document breaks its neighbours. We
 *    therefore rewrite only listener/controller *scalars*, in place, and let
 *    every block (`dns:`, `proxies:`, `proxy-groups:`, `rules:`) stay exactly
 *    where the provider put it. Provider quirks — unquoted full-width colons in
 *    node names, for instance — then keep parsing exactly as they did for the
 *    provider's own client.
 *
 * 2. WE RIDE THE SUBSCRIPTION'S OWN GROUP instead of inventing one. Building a
 *    custom selector would mean editing the group list (see 1). Every real
 *    subscription ships a selector covering all its nodes, so we discover that
 *    group through the API and switch within it. The chosen group is recorded
 *    at runtime, not baked into the file.
 *
 * 3. THE PROXY IS SWAPPED WITHOUT A RESTART. Routing goes through one undici
 *    dispatcher installed into Node's global-dispatcher slot, which is the
 *    documented cross-package mechanism (@deepseek-ai/dsh-http-proxy ships the
 *    same coupling). A node switch therefore changes where the next request
 *    goes, with no process restart.
 *
 * Routes (all under /dsh-net-proxy):
 *   GET  /status          full snapshot for the settings page
 *   POST /enabled         { enabled }        master switch
 *   POST /subscription    { url }            save the subscription link
 *   POST /refresh         { preferCache? }   (re-)import the subscription
 *   POST /test            { targets? }       measure every node now
 *   POST /select          { node }           pin a node, or "auto"
 *   POST /kernel          { action }         start | stop | restart the core
 *   GET  /log             recent activity lines
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis plugin name. */
export const name = 'dsh-net-proxy';

/** Services required before routes can mount. */
export const inject = ['webServer'];

const BASE = '/dsh-net-proxy';

/**
 * Adopt the subscription configured in an already-installed client (Clash Mi)
 * so the first run needs no typing. Only ever used when the user has not set a
 * link in this plugin, so it can never overwrite a deliberate choice.
 *
 * @returns the adopted URL, or undefined when there is nothing to adopt.
 */
function seedSubscriptionFromLocalClient() {
  if (state.config.subscriptionUrl !== '' || state.config.subscriptionSeeded === true) return undefined;
  const appData = process.env.APPDATA;
  if (typeof appData !== 'string' || appData === '') return undefined;
  try {
    const file = join(appData, 'clashmi', 'clashmi', 'profiles.json');
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const profiles = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
    const chosen = profiles.find((p) => p.id === parsed.current_id && typeof p.url === 'string' && p.url !== '')
      ?? profiles.find((p) => typeof p.url === 'string' && p.url !== '');
    if (chosen === undefined) return undefined;
    state.config.subscriptionUrl = chosen.url;
    state.config.subscriptionSeeded = true;
    log(`已从本机客户端「${chosen.remark ?? '未命名'}」读取订阅链接，可在界面里替换`);
    return chosen.url;
  } catch {
    return undefined;
  }
}

/** Built-in proxy types, i.e. anything that is not a real upstream node. */
const BUILTIN_TYPES = new Set([
  'Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay',
  'Direct', 'Reject', 'RejectDrop', 'Compatible', 'Pass', 'Dns',
]);

/** Default ranking targets, GitHub first: reaching GitHub is the point. */
const DEFAULT_TARGETS = ['https://github.com', 'https://www.gstatic.com/generate_204'];

const DEFAULT_CONFIG = {
  enabled: false,
  subscriptionUrl: '',
  mixedPort: 0,
  apiPort: 0,
  apiSecret: '',
  testTargets: DEFAULT_TARGETS,
  testTimeoutMs: 4000,
  testConcurrency: 6,
  failoverCooldownMs: 300000,
  maxFailover: 4,
  autoTestIntervalMs: 1800000,
  refreshIntervalMs: 86400000,
  bypass: ['localhost', '127.0.0.1', '::1', '[::1]'],
  proxyModelCalls: false,
  pinnedNode: 'auto',
  /** Write the agent-memory section on install. Set false to leave AGENTS.md alone. */
  writeMemory: true,
  /** Set once the first-run steps have happened, so they never repeat. */
  autoEnabled: false,
  subscriptionSeeded: false,
};

// ── paths ────────────────────────────────────────────────────────────────────

const dshHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh');
const stateDir = () => join(dshHome(), '.dsh-net-proxy');
const configPath = () => join(stateDir(), 'config.json');
const runtimeConfigPath = () => join(stateDir(), 'runtime.yaml');
const subscriptionPath = () => join(stateDir(), 'subscription.yaml');
const kernelLogPath = () => join(stateDir(), 'kernel.log');
const pluginRoot = () => join(fileURLToPath(new URL('.', import.meta.url)), '..');
const binDir = () => join(pluginRoot(), 'bin');

// ── utilities ────────────────────────────────────────────────────────────────

const logLines = [];
function log(message) {
  logLines.push(`${new Date().toISOString().slice(11, 19)}  ${message}`);
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
}

function readConfigFile() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function persist() {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(configPath(), `${JSON.stringify(state.config, null, 2)}\n`, 'utf8');
  } catch (error) {
    log(`保存配置失败：${error?.message ?? error}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A free loopback port, obtained by binding to 0 and releasing. */
async function freePort() {
  const { createServer } = await import('node:net');
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ── live state ───────────────────────────────────────────────────────────────

const state = {
  config: { ...DEFAULT_CONFIG },
  kernel: { status: 'stopped', pid: undefined, error: undefined },
  nodes: [],
  /** The subscription's own selector we switch within, discovered from the core. */
  group: undefined,
  current: undefined,
  testing: false,
  lastTestAt: undefined,
  lastRefreshAt: undefined,
  /** 'enable' while the master switch is coming up, for the page's progress state. */
  busy: undefined,
  /**
   * Last failure of a background operation.
   *
   * Enabling answers immediately and finishes in the background, so a throw
   * there has no HTTP response to travel in. Without this the page would just
   * sit there looking like nothing happened.
   */
  lastError: undefined,
  /** Set to abandon an in-flight measurement sweep (see disableProxy). */
  testAbort: false,
  routing: { installed: false, via: 'none', error: undefined },
};

/**
 * Serialises start/stop.
 *
 * Enabling and disabling both drive the kernel and the node roster, and running
 * them concurrently produced a reproducible failure: a disable landing in the
 * middle of a start left the freshly spawned kernel to kill itself, and the
 * start reported "内核启动失败". Chaining the operations is what makes the
 * switch behave the way a switch is expected to.
 */
let lifecycleChain = Promise.resolve();
function serialize(operation) {
  const result = lifecycleChain.then(operation, operation);
  lifecycleChain = result.then(() => {}, () => {});
  return result;
}

// ── core API ─────────────────────────────────────────────────────────────────

/**
 * Bumped whenever the kernel is stopped or (re)started.
 *
 * Every core call captures it and aborts quietly if it changed while the call
 * was in flight. Without this, switching the proxy off while a measurement is
 * running kills the kernel underneath that request, the failed `fetch` becomes
 * an unhandled rejection, and Node tears the whole host process down — which is
 * exactly how the disable path used to take the app with it.
 */
let kernelGeneration = 0;
const generationNow = () => kernelGeneration;

async function api(path, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  const generation = generationNow();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${state.config.apiPort}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${state.config.apiSecret}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`core API ${method} ${path} -> ${response.status} ${text.slice(0, 160)}`);
    return text === '' ? undefined : JSON.parse(text);
  } catch (error) {
    // The kernel went away mid-call: that is a superseded operation, not a
    // fault, and callers should treat it as "stop what you are doing".
    if (generation !== generationNow()) {
      const superseded = new Error('内核已重启，此操作已作废');
      superseded.code = 'SUPERSEDED';
      throw superseded;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** True when an error is a superseded core call rather than a real failure. */
const isSuperseded = (error) => error?.code === 'SUPERSEDED';

// ── kernel lifecycle ─────────────────────────────────────────────────────────

function findKernel() {
  const dir = binDir();
  if (!existsSync(dir)) return undefined;
  const found = readdirSync(dir).find((file) => /^mihomo.*\.exe$/i.test(file));
  return found === undefined ? undefined : join(dir, found);
}

/**
 * The geodata databases the subscription's rules need.
 *
 * The core looks for these in its WORKING directory (`-d`), not beside the
 * executable, and it refuses to finish starting without them — the rules
 * reference `GEOIP,CN`/`GEOSITE`, so it either deadlocks downloading them or
 * dies parsing the rule. They therefore ship inside the plugin (`bin/`) and are
 * placed into the working directory before every start. Copying rather than
 * pointing at them keeps the working directory self-describing, and keeps a
 * user's manually updated database from being overwritten only when absent.
 */
const GEODATA_FILES = ['geoip.metadb', 'geosite.dat'];

function ensureGeodata() {
  const source = binDir();
  const target = stateDir();
  const copied = [];
  for (const file of GEODATA_FILES) {
    const from = join(source, file);
    const to = join(target, file);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      copyFileSync(from, to);
      copied.push(file);
    } catch (error) {
      log(`规则库放置失败（${file}）：${error?.message ?? error}`);
    }
  }
  if (copied.length > 0) log(`规则库已就位：${copied.join(', ')}`);
  return copied;
}

let child;
let kernelOutput = [];

async function startKernel() {
  if (state.kernel.status === 'running') return state.kernel;

  const kernel = findKernel();
  if (kernel === undefined) {
    state.kernel = { status: 'missing', error: `bin/ 里没有 mihomo 内核：${binDir()}` };
    log(state.kernel.error);
    return state.kernel;
  }
  if (!existsSync(subscriptionPath())) {
    state.kernel = { status: 'unconfigured', error: '还没有订阅，请先导入' };
    return state.kernel;
  }

  mkdirSync(stateDir(), { recursive: true });
  ensureGeodata();

  // The runtime config is rebuilt from the saved subscription on EVERY start,
  // using the ports held in memory. Writing it once and reusing it left the
  // file and the state able to disagree — a stale port in the file means the
  // plugin polls an address nothing is listening on, and reports a core that
  // actually started as a failure.
  await acquirePorts();
  const configChanged = !existsSync(runtimeConfigPath())
    || !readFileSync(runtimeConfigPath(), 'utf8').includes(`external-controller: 127.0.0.1:${state.config.apiPort}`);
  if (configChanged) {
    writeFileSync(runtimeConfigPath(), buildRuntimeConfig(readFileSync(subscriptionPath(), 'utf8')), 'utf8');
  }

  kernelOutput = [];
  const spawned = spawn(kernel, ['-d', stateDir(), '-f', runtimeConfigPath()], {
    cwd: stateDir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const generation = kernelGeneration;
  const output = [];
  child = spawned;
  spawned.stdout.on('data', (chunk) => { output.push(String(chunk)); kernelOutput.push(String(chunk)); });
  spawned.stderr.on('data', (chunk) => { output.push(String(chunk)); kernelOutput.push(String(chunk)); });
  spawned.on('exit', (code) => {
    // Only ever speak for the process this handler was created for. Stopping a
    // kernel can take seconds (signal, then a forced kill), and in that window a
    // replacement may already be running — without this guard the old process's
    // exit would tear down the new one's state and "kill" the switch.
    if (child !== spawned) return;
    const tail = output.join('').trim().slice(-400);
    if (state.kernel.status !== 'stopped') log(`内核退出，code=${code}${tail === '' ? '' : ` — ${tail.slice(-200)}`}`);
    state.kernel = { status: 'stopped', error: `内核退出 (${code})${tail === '' ? '' : `: ${tail.slice(-300)}`}` };
    try { writeFileSync(kernelLogPath(), output.join(''), 'utf8'); } catch { /* ignore */ }
    child = undefined;
    kernelGeneration = Math.max(kernelGeneration, generation + 1);
  });

  state.kernel = { status: 'starting', pid: spawned.pid };

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(250);
    if (child === undefined) break; // it died; the exit handler recorded why
    try {
      await api('/version', { timeoutMs: 1500 });
      state.kernel = { status: 'running', pid: child.pid };
      log(`内核已启动 pid=${child.pid}`);
      return state.kernel;
    } catch { /* keep waiting */ }
  }

  const tail = kernelOutput.join('').slice(-800);
  try { writeFileSync(kernelLogPath(), kernelOutput.join(''), 'utf8'); } catch { /* ignore */ }
  state.kernel = { status: 'failed', error: tail.trim() === '' ? '内核未在 20 秒内就绪' : tail.trim() };
  log(`内核启动失败：${state.kernel.error.slice(0, 300)}`);
  await stopKernel();
  return state.kernel;
}

/**
 * Stop the kernel and WAIT for the process to actually be gone.
 *
 * `child.kill()` only delivers the signal. Starting the replacement while the
 * old process still holds its listening ports and the working directory is a
 * race, and it showed up as a second start hanging during geodata load with no
 * error at all. Waiting is the cheap, deterministic fix.
 */
async function stopKernel() {
  // Invalidate in-flight core calls FIRST, so anything mid-flight treats the
  // shutdown below as "superseded" instead of surfacing a connection reset.
  kernelGeneration += 1;
  const dying = child;
  child = undefined;
  if (dying !== undefined) {
    const exited = new Promise((resolve) => {
      if (dying.exitCode !== null || dying.signalCode !== null) return resolve();
      dying.once('exit', resolve);
      setTimeout(resolve, 5000);
    });
    try { dying.kill(); } catch { /* already gone */ }
    await exited;
    if (dying.exitCode === null && dying.signalCode === null) {
      try { dying.kill('SIGKILL'); } catch { /* give up */ }
      log('内核未响应终止信号，已强制结束');
    }
  }
  if (state.kernel.status === 'running' || state.kernel.status === 'starting') {
    state.kernel = { status: 'stopped' };
  }
  // Ports are released here but the values are left alone: startKernel()
  // re-acquires a fresh pair before it spawns, and persisting zeros in the
  // meantime is what previously let memory and the config file disagree.
  state.config.mixedPort = 0;
  state.config.apiPort = 0;
}

// ── subscription → runtime config ────────────────────────────────────────────

/**
 * Rewrite top-level scalar keys in place, appending any that the document did
 * not declare. Blocks are never touched: only lines whose key we own and whose
 * value is a scalar on the same line.
 */
function rewriteScalars(text, values) {
  const lines = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (match !== null && Object.hasOwn(values, match[1])) {
      lines.push(`${match[1]}: ${values[match[1]]}`);
      seen.add(match[1]);
      continue;
    }
    lines.push(line);
  }
  const missing = Object.entries(values).filter(([key]) => !seen.has(key));
  if (missing.length > 0) {
    // A key we own that the document omits: safe to add at the very top,
    // because it is by definition not declared anywhere else.
    lines.unshift(...missing.map(([key, value]) => `${key}: ${value}`));
  }
  return lines.join('\n');
}

function buildRuntimeConfig(subscriptionText) {
  return rewriteScalars(subscriptionText, {
    'mixed-port': state.config.mixedPort,
    'port': 0,
    'socks-port': 0,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    'external-controller': `127.0.0.1:${state.config.apiPort}`,
    'secret': state.config.apiSecret,
  });
}

async function acquirePorts() {
  const patch = {};
  if (!(state.config.mixedPort > 0)) patch.mixedPort = await freePort();
  if (!(state.config.apiPort > 0)) patch.apiPort = await freePort();
  if (typeof state.config.apiSecret !== 'string' || state.config.apiSecret === '') {
    patch.apiSecret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  Object.assign(state.config, patch);
  if (Object.keys(patch).length > 0) persist();
}

/** Import a subscription: re-download when a URL is set, else reuse the copy on disk. */
async function refreshSubscription({ preferCache = false } = {}) {
  const url = state.config.subscriptionUrl;

  if (url === '' || preferCache) {
    if (existsSync(subscriptionPath())) {
      log('使用本地已保存的订阅');
      await applySubscription(readFileSync(subscriptionPath(), 'utf8'));
      return { nodes: state.nodes.length, source: 'cache' };
    }
    if (url === '') throw new Error('尚未填写订阅链接');
  }

  log('正在下载订阅…');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let text;
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'ClashMeta/1.19.31; mihomo/1.19.31' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    // A failed refresh must not cost the user the node list they already have.
    if (existsSync(subscriptionPath())) {
      log(`下载失败（${error?.message ?? error}），改用本地已保存的订阅`);
      await applySubscription(readFileSync(subscriptionPath(), 'utf8'));
      return { nodes: state.nodes.length, source: 'cache-after-failure' };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!/^\s*(proxies|proxy-groups|rules|mixed-port|port)\s*:/m.test(text)) {
    throw new Error('订阅内容不是 Clash 配置（若是 base64 订阅链接，请在服务商处改为 Clash 格式）');
  }

  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(subscriptionPath(), text, 'utf8');
  state.lastRefreshAt = Date.now();
  log(`订阅已下载（${text.length} 字节）`);
  await applySubscription(text);
  return { nodes: state.nodes.length, source: 'network' };
}

async function applySubscription(text) {
  if (state.kernel.status === 'running' || state.kernel.status === 'starting') await stopKernel();
  await acquirePorts();
  writeFileSync(runtimeConfigPath(), buildRuntimeConfig(text), 'utf8');
  await startKernel();
  if (state.kernel.status !== 'running') {
    throw new Error(`内核未运行 — ${state.kernel.error ?? state.kernel.status}`);
  }

  await readNodesFromCore();
  log(`已从内核读到 ${state.nodes.length} 个节点，使用订阅自带的组「${state.group ?? '无'}」`);
}

/** Read the node roster and pick the subscription's own selector to steer. */
async function readNodesFromCore() {
  const all = await api('/proxies');
  const proxies = all?.proxies ?? {};

  const nodes = [];
  const selectors = [];
  for (const [nodeName, info] of Object.entries(proxies)) {
    if (BUILTIN_TYPES.has(info.type)) {
      if (info.type === 'Selector') selectors.push({ name: nodeName, members: info.all ?? [], now: info.now });
      continue;
    }
    nodes.push({ name: nodeName, type: info.type, delay: undefined, status: 'idle', failCount: 0, cooldownUntil: 0 });
  }

  // Prefer the selector that covers the most real nodes; skip the global one
  // when a subscription-provided group ties with it, since the provider's group
  // carries their own rules.
  selectors.sort((a, b) => {
    const coversA = a.members.filter((m) => nodes.some((n) => n.name === m)).length;
    const coversB = b.members.filter((m) => nodes.some((n) => n.name === m)).length;
    if (coversA !== coversB) return coversB - coversA;
    return a.name === 'GLOBAL' ? 1 : -1;
  });

  state.nodes = nodes;
  state.group = selectors[0]?.name;
  state.current = selectors[0]?.now;
  return nodes;
}

// ── measuring ────────────────────────────────────────────────────────────────

async function measureNode(nodeName, target, timeoutMs) {
  const query = new URLSearchParams({ url: target, timeout: String(timeoutMs) });
  const result = await api(`/proxies/${encodeURIComponent(nodeName)}/delay?${query}`, { timeoutMs: timeoutMs + 5000 });
  const delay = Number(result?.delay ?? 0);
  if (!Number.isFinite(delay) || delay <= 0) throw new Error('未返回延迟');
  return delay;
}

/** Measure every node concurrently and rank the survivors. */
async function testAllNodes({ targets } = {}) {
  if (state.kernel.status !== 'running') {
    await startKernel();
    if (state.kernel.status !== 'running') throw new Error(`内核未运行 — ${state.kernel.error ?? state.kernel.status}`);
  }
  if (state.nodes.length === 0) await readNodesFromCore();

  const requested = (targets ?? state.config.testTargets).filter((t) => typeof t === 'string' && t !== '');
  const effective = requested.length > 0 ? requested : DEFAULT_TARGETS;
  const { testConcurrency, testTimeoutMs } = state.config;

  state.testing = true;
  log(`开始测速：${state.nodes.length} 个节点 × ${effective.length} 个目标`);
  const queue = [...state.nodes];

  async function worker() {
    for (;;) {
      if (state.testAbort === true) return;
      const node = queue.shift();
      if (node === undefined) return;
      let best;
      let lastError;
      for (const target of effective) {
        try {
          const delay = await measureNode(node.name, target, testTimeoutMs);
          if (best === undefined || delay < best.delay) best = { delay, target };
        } catch (error) {
          // The kernel was stopped or replaced under us: abandon the sweep
          // rather than marking every remaining node dead.
          if (isSuperseded(error)) return;
          lastError = error;
        }
      }
      if (best !== undefined) {
        node.delay = best.delay;
        node.target = best.target;
        node.status = 'ok';
        node.failCount = 0;
        node.cooldownUntil = 0;
        node.error = undefined;
      } else {
        node.delay = undefined;
        node.status = 'dead';
        node.failCount = (node.failCount ?? 0) + 1;
        node.error = String(lastError?.message ?? 'timeout').slice(0, 120);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, testConcurrency) }, worker));
  } finally {
    state.testing = false;
    state.lastTestAt = Date.now();
  }

  state.nodes.sort((a, b) => {
    const aliveDiff = (a.status === 'ok' ? 0 : 1) - (b.status === 'ok' ? 0 : 1);
    if (aliveDiff !== 0) return aliveDiff;
    return (a.delay ?? Infinity) - (b.delay ?? Infinity);
  });

  const alive = state.nodes.filter((n) => n.status === 'ok');

  // A sweep that was abandoned must not then go and retarget the core: that is
  // what killed the kernel the user had just switched off.
  if (state.testAbort === true) {
    state.testAbort = false;
    log('测速已被取消');
    return { alive: alive.length, total: state.nodes.length, aborted: true };
  }

  log(`测速完成：${alive.length}/${state.nodes.length} 可用${alive.length > 0 ? `，最快「${alive[0].name}」${alive[0].delay}ms` : ''}`);

  if (state.config.pinnedNode === undefined || state.config.pinnedNode === 'auto') await selectBest();
  return { alive: alive.length, total: state.nodes.length };
}

/** Resolve when no measurement sweep is running (or the wait runs out). */
async function waitForIdleTest(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (state.testing && Date.now() < deadline) await sleep(200);
  return state.testing !== true;
}

async function switchTo(nodeName, reason) {
  if (state.group === undefined) throw new Error('没有可用的选择组');
  await api(`/proxies/${encodeURIComponent(state.group)}`, { method: 'PUT', body: { name: nodeName } });
  state.current = nodeName;
  const node = state.nodes.find((n) => n.name === nodeName);
  log(`切换到「${nodeName}」${node?.delay === undefined ? '' : ` (${node.delay}ms)`} — ${reason}`);
  return nodeName;
}

/**
 * Health-check one node the honest way: does a tunnel to the ranking target
 * actually open through it?
 *
 * The core's own `/delay` probe only reports that the node answers *somewhere*.
 * What matters for failover is whether a real connection to the destination
 * succeeds, so this drives the core's mixed port with a CONNECT and hangs up as
 * soon as the tunnel is established.
 */
async function probeThroughNode(nodeName, target, timeoutMs) {
  const { request } = await import('node:http');
  const previous = state.current;
  try {
    // The core routes by its group's selection, so aim it at the node first.
    await api(`/proxies/${encodeURIComponent(state.group)}`, { method: 'PUT', body: { name: nodeName } });
    const tls = new URL(target);
    const port = tls.port === '' ? (tls.protocol === 'https:' ? 443 : 80) : Number(tls.port);
    return await new Promise((resolve) => {
      const connect = request({
        host: '127.0.0.1',
        port: state.config.mixedPort,
        method: 'CONNECT',
        path: `${tls.hostname}:${port}`,
        timeout: timeoutMs,
      });
      const finish = (ok, detail) => {
        try { connect.destroy(); } catch { /* already gone */ }
        resolve({ ok, detail });
      };
      connect.on('connect', (response, socket) => {
        const status = response.statusCode ?? 0;
        socket.destroy();
        finish(status === 200, `CONNECT ${status}`);
      });
      connect.on('timeout', () => finish(false, 'timeout'));
      connect.on('error', (error) => finish(false, error.code ?? error.message));
      connect.end();
    });
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  } finally {
    // A failed probe must not leave the group pointing at the bad node.
    if (previous !== undefined && previous !== nodeName) {
      try { await api(`/proxies/${encodeURIComponent(state.group)}`, { method: 'PUT', body: { name: previous } }); } catch { /* ignore */ }
    }
  }
}

/** Point the group at the fastest healthy node. */
async function selectBest() {
  const pinned = state.config.pinnedNode;
  if (pinned !== undefined && pinned !== 'auto') return await switchTo(pinned, '手动指定');

  const now = Date.now();
  const best = state.nodes.find((n) => n.status === 'ok' && (n.cooldownUntil ?? 0) <= now);
  if (best === undefined) {
    log('没有可用节点（全部不可用或处于冷却）');
    return undefined;
  }
  return await switchTo(best.name, '自动选最快');
}

/** Retire a failing node and move to the next candidate. */
async function failover(fromNode, error) {
  const node = state.nodes.find((n) => n.name === fromNode);
  if (node !== undefined) {
    node.failCount = (node.failCount ?? 0) + 1;
    node.cooldownUntil = Date.now() + state.config.failoverCooldownMs;
    node.status = 'cooldown';
    node.error = String(error ?? '').slice(0, 120);
  }
  log(`节点「${fromNode ?? '未知'}」失败，冷却 ${Math.round(state.config.failoverCooldownMs / 1000)}s`);
  return await selectBest();
}

/**
 * Walk candidate nodes until one really reaches the target.
 *
 * Each candidate is retired as it fails, so `maxFailover` bounds the walk and a
 * fully broken subscription cannot spin here. Returns the node that worked.
 */
async function failoverWalk(target, failureDetail) {
  if (state.group === undefined) throw new Error('没有可用的选择组');
  const attempted = [];
  for (let step = 0; step < state.config.maxFailover; step += 1) {
    const failed = state.current;
    if (failed !== undefined) await failover(failed, failureDetail);
    const candidate = state.current;
    if (candidate === undefined || candidate === failed || attempted.includes(candidate)) break;
    attempted.push(candidate);
    const probe = await probeThroughNode(candidate, target, state.config.testTimeoutMs);
    if (probe.ok) {
      const node = state.nodes.find((n) => n.name === candidate);
      if (node !== undefined) { node.status = 'ok'; node.failCount = 0; node.error = undefined; }
      return candidate;
    }
    failureDetail = probe.detail;
  }
  return undefined;
}

// ── outbound routing ─────────────────────────────────────────────────────────

const SLOT = Symbol.for('undici.globalDispatcher.1');
let originalDispatcher;
let ownedAgent;
let undiciModule;

/**
 * Every plausible place `undici` can be resolved from, best first.
 *
 * The harness's own copy is preferred and the app-bundle copy is the reliable
 * fallback, but the install root is NOT hard-coded to one machine: DSH exposes
 * its own directories through the environment, and the executable path is the
 * last resort. A plugin that resolved a *second* undici would hand Node a
 * dispatcher built from foreign symbols, which is the cross-version coupling the
 * DSH docs explicitly warn about — so this list matters more than it looks.
 */
function undiciAnchors() {
  const anchors = [
    join(pluginRoot(), 'package.json'),
    join(dshHome(), 'profiles', process.env.DSH_PROFILE ?? 'desktop', 'package.json'),
  ];
  // Whatever root the desktop app advertises, if any.
  for (const key of ['DSH_APP_ROOT', 'DSH_DESKTOP_ROOT', 'DSH_INSTALL_ROOT']) {
    const root = process.env[key];
    if (typeof root === 'string' && root !== '') {
      anchors.push(join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    }
  }
  // Derived from the running executable: <install>/resources/app.asar/...
  const exe = process.execPath;
  if (typeof exe === 'string' && exe !== '') {
    const install = dirname(dirname(exe));
    for (const inner of ['dsh/node_modules/@deepseek-ai/dsh', 'dsh/node_modules/@deepseek-ai/dsh-desktop-host']) {
      anchors.push(join(install, 'resources', 'app.asar', inner, 'package.json'));
    }
  }
  return anchors;
}

async function loadUndici() {
  if (undiciModule !== undefined) return undiciModule;
  for (const anchor of undiciAnchors()) {
    try {
      undiciModule = createRequire(anchor)('undici');
      return undiciModule;
    } catch { /* next anchor */ }
  }
  throw new Error('无法解析 undici，代理无法挂载');
}

const proxyUrl = () => `http://127.0.0.1:${state.config.mixedPort}`;

function buildAgent() {
  const { Agent, ProxyAgent } = undiciModule;
  const tunnels = new Map();
  const proxyFor = (origin) => {
    const host = new URL(origin).hostname;
    if (state.config.bypass.some((entry) => entry !== '' && (host === entry || host.endsWith(`.${entry}`)))) return undefined;
    if (!state.config.proxyModelCalls && /(^|\.)deepseek\.com$/i.test(host)) return undefined;
    return proxyUrl();
  };
  return new Agent({
    factory: (origin) => {
      const proxy = proxyFor(origin.toString());
      if (proxy === undefined) return new Agent();
      let tunnel = tunnels.get(proxy);
      if (tunnel === undefined) {
        tunnel = new ProxyAgent({ uri: proxy });
        tunnels.set(proxy, tunnel);
      }
      return tunnel;
    },
  });
}

async function installRouting() {
  try {
    await loadUndici();
    originalDispatcher ??= globalThis[SLOT];
    ownedAgent = buildAgent();
    globalThis[SLOT] = ownedAgent;

    // Children (git, npm, curl) read the environment, never the dispatcher.
    const bypass = state.config.bypass.join(',');
    for (const [key, value] of Object.entries({
      HTTP_PROXY: proxyUrl(), HTTPS_PROXY: proxyUrl(),
      http_proxy: proxyUrl(), https_proxy: proxyUrl(),
      NO_PROXY: bypass, no_proxy: bypass,
      NODE_USE_ENV_PROXY: '1',
    })) process.env[key] = value;

    state.routing = { installed: true, via: 'global dispatcher + child env', error: undefined };
    log(`代理已挂载 → ${proxyUrl()}`);
    return true;
  } catch (error) {
    state.routing = { installed: false, via: 'none', error: String(error?.message ?? error) };
    log(`代理挂载失败：${state.routing.error}`);
    return false;
  }
}

/**
 * Put the process back on a direct connection.
 *
 * Every step is individually guarded, and the dispatcher slot is never
 * `delete`d: undici installs that property as non-configurable, so `delete`
 * throws a TypeError that would abort the whole request — which is exactly how
 * switching the proxy off used to fail. Restoring `undefined` puts Node back on
 * its own default dispatcher, which is the same effect without the throw.
 */
function uninstallRouting() {
  try {
    globalThis[SLOT] = originalDispatcher;
  } catch (error) {
    log(`恢复默认 dispatcher 失败：${error?.message ?? error}`);
  }
  ownedAgent = undefined;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']) {
    try { delete process.env[key]; } catch { /* non-configurable env entry */ }
  }
  state.routing = { installed: false, via: 'none', error: undefined };
  log('代理已卸载，恢复直连');
}

// ── agent memory ─────────────────────────────────────────────────────────────

/**
 * Marker that records "this plugin has already taught the agent about itself".
 *
 * It is used purely as a presence check. Nothing here ever searches for a
 * section, truncates a file, or rewrites what is already there — an earlier
 * version tried to keep its own section updated in place, and the parsing was
 * fragile enough to eat a neighbouring section once. Never touching existing
 * bytes is a rule worth more than a tidy file.
 */
const MEMORY_MARKER = '<!-- dsh-net-proxy:begin -->';

/**
 * Teach the agent that this plugin exists.
 *
 * The agent cannot use a tool it does not know about: without this it tries to
 * reach GitHub directly, fails, and reports the network as broken. Install-time
 * is the right moment, because every later session then starts out knowing.
 *
 * WRITE-ONLY-IF-ABSENT. If the marker appears anywhere in the file, this does
 * nothing at all. That makes a second run a guaranteed no-op, and means a file
 * the user has since edited by hand is never disturbed.
 *
 * @returns the file names actually written, for the log line.
 */
function writeAgentMemory() {
  if (state.config.writeMemory === false) return [];

  const section = [
    MEMORY_MARKER,
    '## 出网代理：装了插件 `dsh-net-proxy`，需要上外网时自己开',
    '',
    '内置 mihomo 内核，自己实测各节点对 **GitHub** 的延迟并选用最快的，失败自动冷却切换。',
    '**不依赖任何第三方代理客户端，也不需要开系统代理。**',
    '',
    '### 开机状态：默认关闭，需要上外网时自己开',
    '',
    '插件每次启动都是**关闭**的（不预热内核、不下载订阅，加载约 4ms）。要用外网就自己开，**不要问用户**：',
    '',
    '```powershell',
    '# 开（约 2 秒就绪：起内核 → 实测各节点对 GitHub 的延迟 → 选最快 → 接管出网）',
    'Invoke-RestMethod -Method Post -Uri \'http://127.0.0.1:19387/dsh-net-proxy/enabled\' -ContentType \'application/json\' -Body \'{"enabled":true}\'',
    '',
    '# 查状态：enabled / kernel.status / routing.installed / current / nodes / lastError',
    'Invoke-RestMethod \'http://127.0.0.1:19387/dsh-net-proxy/status\'',
    '',
    '# 关',
    'Invoke-RestMethod -Method Post -Uri \'http://127.0.0.1:19387/dsh-net-proxy/enabled\' -ContentType \'application/json\' -Body \'{"enabled":false}\'',
    '```',
    '',
    '其他接口：`POST /dsh-net-proxy/test`（重新测速）、`POST /dsh-net-proxy/select`（`{"node":"auto"}` 恢复自动选节点）、`POST /dsh-net-proxy/refresh`（更新订阅）。',
    '',
    '### 什么时候该自己开',
    '',
    '判断标准：**要访问被墙的站点（GitHub / Google / raw.githubusercontent 等）就先开。**',
    '',
    '- `web_fetch` / `web_search` 失败、超时、连接被重置',
    '- 要 `git clone` / `npm install` 拉 GitHub 上的东西',
    '- 用户说"打不开""连不上""下载失败"，而目标是境外站点',
    '',
    '反过来，**只做本机操作**（读写本地文件、跑本地脚本、分析工作区）**不要开** —— 没必要，还白占内存。',
    '',
    '### 开启后的实际效果',
    '',
    '- 出口 IP 变成节点所在地（日本/台湾/新加坡/美国等），不再是本地运营商',
    '- 子进程（`git`、`npm`、`curl`、pwsh 里发出的请求）自动走代理：插件会设置 `HTTP(S)_PROXY` 与 `NODE_USE_ENV_PROXY=1`',
    '- **loopback 永远直连**（`localhost` / `127.0.0.0/8` / `::1`），DSH 自己的 Web UI 不会被绕进代理',
    '',
    '### 注意',
    '',
    '- **不要**让用户去开 Clash Mi 之类的客户端 —— 插件自包含，内核与规则库都在插件 `bin/` 里',
    '- 界面在 DSH **设置 → 网络代理**：可手动切节点、看每个节点的延迟、看运行日志',
    '- 使用说明与实现细节在插件目录的 `README.md`；改代码之前先读，里面记着几个很坑的约束',
    '<!-- /dsh-net-proxy -->',
    '',
  ].join('\n');

  // Only `AGENTS.md`: it is the documented name, and it is the file DSH actually
  // loads here. An earlier version also wrote a `.AGENTS.md` sibling "for
  // compatibility", which just created a second copy of the same text in the
  // user's home directory for no benefit.
  const file = join(dshHome(), 'AGENTS.md');
  try {
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    // Marker, or a section a human already wrote by hand. Either way the agent
    // has been taught, and appending again would only duplicate it.
    if (existing.includes(MEMORY_MARKER) || /^##\s*(?:\d+\.\s*)?出网代理/m.test(existing)) return [];
    mkdirSync(dshHome(), { recursive: true });
    const prefix = existing.trim() === '' ? '# 全局工作偏好（对所有会话生效）\n\n' : `${existing.trimEnd()}\n\n---\n\n`;
    writeFileSync(file, `${prefix}${section}`, 'utf8');
    return ['AGENTS.md'];
  } catch (error) {
    log(`写入 AGENTS.md 失败（忽略）：${error?.message ?? error}`);
    return [];
  }
}

// ── orchestration ────────────────────────────────────────────────────────────

/**
 * Bring the proxy up, doing everything the user should not have to do by hand.
 *
 * One click must be enough, so this starts the kernel itself. It deliberately
 * does NOT re-download the subscription: that belongs to "更新订阅", and doing
 * it here made every start wait on the provider (and made a fresh start look
 * broken while it waited). The cached subscription is used instead, and the
 * background job refreshes it on its own schedule.
 */
async function enableProxy(isDisposed) {
  // The disposer can run while an enable is still in flight; starting a kernel
  // behind a plugin that is being torn down would leak a process.
  if (isDisposed !== undefined && isDisposed() === true) return false;
  await acquirePorts();

  if (state.nodes.length === 0) {
    // Bootstrap the node list from wherever it can be had: the saved copy
    // first, and the subscription URL when there is no copy yet (a fresh
    // install, or a user who only just pasted a link). Failing here without
    // trying the URL is what made the first click appear to do nothing.
    if (existsSync(subscriptionPath())) {
      await applySubscription(readFileSync(subscriptionPath(), 'utf8'));
    } else if (state.config.subscriptionUrl !== '') {
      await refreshSubscription();
    } else {
      throw new Error('还没有订阅：请在「订阅链接」里填入链接并点「更新订阅」');
    }
  }
  if (state.nodes.length === 0) throw new Error('订阅里没有解析出任何节点，请点「更新订阅」');
  if (state.kernel.status !== 'running') {
    await startKernel();
    if (state.kernel.status !== 'running') throw new Error(`内核启动失败 — ${state.kernel.error ?? state.kernel.status}`);
  }

  if (!await installRouting()) throw new Error(state.routing.error ?? '代理挂载失败');
  state.config.enabled = true;
  persist();

  // Ranking runs in the background on purpose — the switch must report success
  // as soon as traffic can flow. A superseded sweep is expected when the user
  // turns the proxy straight back off, so it must not become an unhandled
  // rejection.
  if (state.nodes.every((n) => n.delay === undefined)) {
    void testAllNodes().catch((error) => {
      if (!isSuperseded(error)) log(`测速失败：${error?.message ?? error}`);
    });
  } else {
    await selectBest();
  }
  return true;
}

/**
 * Bring the proxy down. Must never throw: a failure here would leave a switch
 * that cannot be turned off, so the enabled flag is cleared no matter what.
 */
async function disableProxy() {
  try {
    if (state.routing.installed) uninstallRouting();
  } catch (error) {
    log(`卸载路由出错（已忽略）：${error?.message ?? error}`);
  }
  // Abandon any sweep in progress and let it unwind before the kernel goes
  // away. Waiting is not politeness: a sweep that outlives the kernel will try
  // to retarget a core that is already gone.
  if (state.testing) {
    state.testAbort = true;
    const settled = await waitForIdleTest();
    if (!settled) log('测速未在超时内结束，仍然停止内核');
  }
  state.testAbort = false;
  try {
    await stopKernel();
  } catch (error) {
    log(`停止内核出错（已忽略）：${error?.message ?? error}`);
  }
  state.config.enabled = false;
  state.config.autoEnabled = true;
  state.lastError = undefined;
  try { persist(); } catch { /* config stays in memory */ }
  return true;
}

function snapshot() {
  return {
    enabled: state.config.enabled,
    subscriptionUrl: state.config.subscriptionUrl,
    kernel: { ...state.kernel, path: findKernel(), log: kernelOutput.join('').slice(-1500) },
    routing: state.routing,
    group: state.group,
    current: state.current,
    testing: state.testing,
    busy: state.busy,
    lastError: state.lastError,
    lastTestAt: state.lastTestAt,
    proxyUrl: state.config.mixedPort > 0 ? proxyUrl() : undefined,
    mixedPort: state.config.mixedPort,
    testTargets: state.config.testTargets,
    pinnedNode: state.config.pinnedNode ?? 'auto',
    nodes: state.nodes.map((n) => ({
      name: n.name,
      type: n.type,
      delay: n.delay,
      status: n.status,
      error: n.error,
      cooldownMs: Math.max(0, (n.cooldownUntil ?? 0) - Date.now()),
      failCount: n.failCount ?? 0,
    })),
  };
}

// ── plugin body ──────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  state.config = { ...readConfigFile(), ...config };
  log('插件已加载');

  /**
   * Disposal flag for THIS load.
   *
   * Deliberately a local, not a field on the shared state: the state object
   * outlives one `apply()` (it is module-level), so a disposed load would
   * otherwise leave a flag behind that blocks every later enable.
   */
  let disposed = false;
  const isDisposed = () => disposed;

  // Adopt the subscription an installed client already has, so the first run
  // needs no typing. This only records a URL — it starts nothing.
  seedSubscriptionFromLocalClient();

  // Teach the agent this plugin exists, once. Install-time, not boot-time, and
  // idempotent, so it never touches a file the user has since edited.
  try {
    const written = writeAgentMemory();
    if (written.length > 0) log(`已把用法写入记忆：${written.join(', ')}（下次会话的 Agent 会自动知道有这个插件）`);
  } catch (error) {
    log(`写入记忆失败（忽略）：${error?.message ?? error}`);
  }

  persist();

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '');
  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text === '' ? {} : JSON.parse(text);
  };

  ctx.effect(() => ctx.webServer.register({
    method: 'GET',
    path: `${BASE}/status`,
    handler: (req, res) => (isLocal(req) ? json(res, 200, snapshot()) : json(res, 403, { error: 'loopback only' })),
  }));

  ctx.effect(() => ctx.webServer.register({
    method: 'GET',
    path: `${BASE}/log`,
    handler: (req, res) => (isLocal(req) ? json(res, 200, { lines: logLines.slice(-200) }) : json(res, 403, { error: 'loopback only' })),
  }));

  const post = (path, handler) => ctx.effect(() => ctx.webServer.register({
    method: 'POST',
    path: `${BASE}${path}`,
    handler: async (req, res) => {
      if (!isLocal(req)) return json(res, 403, { error: 'loopback only' });
      try {
        json(res, 200, (await handler(await readBody(req))) ?? { ok: true });
      } catch (error) {
        log(`接口 ${path} 出错：${error?.message ?? error}`);
        json(res, 500, { error: String(error?.message ?? error) });
      }
    },
  }));

  /**
   * The master switch.
   *
   * Starting is done in the background and answered immediately: the kernel
   * needs a few seconds to come up, and holding the HTTP response open for that
   * made the button look stuck. The page polls `/status` anyway, so it shows the
   * real progress. Stopping is synchronous and cannot fail.
   */
  /**
   * The master switch.
   *
   * Starting is done in the background and answered immediately: the kernel
   * needs a few seconds to come up, and holding the HTTP response open for that
   * made the button look stuck. The page polls `/status` anyway, so it shows the
   * real progress. Stopping is synchronous and cannot fail.
   */
  post('/enabled', async ({ enabled }) => {
    if (enabled) {
      state.lastError = undefined;
      // Gate on the routing that is actually installed, not on the saved flag:
      // a flag that says "on" while nothing is mounted must not stop us from
      // bringing it up (and a flag that says "off" must not stop us either).
      if (!state.routing.installed) {
        state.busy = 'enable';
        void serialize(() => enableProxy(isDisposed))
          .catch((error) => {
            if (isSuperseded(error)) return;
            state.lastError = String(error?.message ?? error);
            log(`启用失败：${state.lastError}`);
          })
          .finally(() => { state.busy = undefined; });
      }
    } else {
      state.busy = 'disable';
      try {
        await serialize(() => disableProxy());
        state.lastError = undefined;
      } catch (error) {
        // disableProxy is already fail-safe; this is belt and braces so the
        // switch can never become impossible to turn off.
        state.lastError = String(error?.message ?? error);
        state.config.enabled = false;
        log(`停用出错（已强制关闭）：${state.lastError}`);
      } finally {
        state.busy = undefined;
      }
    }
    return snapshot();
  });

  post('/subscription', async ({ url }) => {
    state.config.subscriptionUrl = String(url ?? '').trim();
    persist();
    return { subscriptionUrl: state.config.subscriptionUrl };
  });

  post('/refresh', async ({ preferCache } = {}) => {
    const result = await refreshSubscription({ preferCache: preferCache === true });
    if (state.config.enabled) await installRouting();
    return { ...result, status: snapshot() };
  });

  post('/test', async ({ targets } = {}) => ({ ...await testAllNodes({ targets }), status: snapshot() }));

  post('/select', async ({ node }) => {
    if (node === undefined || node === 'auto') {
      state.config.pinnedNode = 'auto';
      persist();
      await selectBest();
    } else {
      state.config.pinnedNode = node;
      persist();
      await switchTo(node, '手动指定');
    }
    return snapshot();
  });

  post('/kernel', async ({ action } = {}) => {
    if (action === 'stop') await stopKernel();
    else if (action === 'restart') { await stopKernel(); await startKernel(); }
    else await startKernel();
    return snapshot();
  });

  /**
   * Walk the failover chain for real and report where it landed.
   *
   * `force` retires the current node first, which is how a user (or a test) can
   * exercise the self-healing path on demand instead of waiting for a genuine
   * outage.
   */
  post('/failover-test', async ({ target, force } = {}) => {
    if (state.kernel.status !== 'running') throw new Error('内核未运行');
    const chosen = target ?? state.config.testTargets[0] ?? DEFAULT_TARGETS[0];
    const before = state.current;
    if (force === true && before !== undefined) {
      log('手动触发故障切换测试');
      await failover(before, '手动触发测试');
    }
    const landed = await failoverWalk(chosen, '故障切换测试');
    return {
      target: chosen,
      from: before,
      landed,
      ok: landed !== undefined,
      status: snapshot(),
    };
  });

  // Housekeeping: expire cooldowns, re-measure on a schedule, re-import daily.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          if (state.config.enabled && !state.testing) {
            const now = Date.now();
            let expired = false;
            for (const node of state.nodes) {
              if (node.status === 'cooldown' && (node.cooldownUntil ?? 0) <= now) {
                node.status = 'idle';
                expired = true;
              }
            }
            const stale = state.lastTestAt === undefined || now - state.lastTestAt > state.config.autoTestIntervalMs;
            if (stale || expired) await testAllNodes();
          }
          if (state.config.subscriptionUrl !== '' && state.config.refreshIntervalMs > 0) {
            const last = state.lastRefreshAt ?? 0;
            if (state.lastRefreshAt === undefined) state.lastRefreshAt = Date.now();
            else if (Date.now() - last > state.config.refreshIntervalMs) {
              state.lastRefreshAt = Date.now();
              log('订阅定时更新');
              await refreshSubscription().catch((error) => log(`订阅更新失败：${error?.message ?? error}`));
            }
          }
        } catch (error) {
          log(`后台任务出错：${error?.message ?? error}`);
        }
      })();
    }, 60000);
    return () => clearInterval(timer);
  });

  // Leave the machine on a direct connection when the plugin goes away.
  ctx.effect(() => () => {
    disposed = true;
    try { if (state.routing.installed) uninstallRouting(); } catch { /* shutting down */ }
    void stopKernel().catch(() => {});
  });

  /*
   * NOTHING starts here, ever. This is the whole point of the file's shape.
   *
   * Loading the plugin must be free: no kernel process, no subscription
   * download, no dispatcher. Someone who does not need a proxy on a given day
   * should never pay for one, and doing this work at boot put seconds onto every
   * app start. The kernel comes up when the user turns the proxy on — and a
   * previous session's "on" is NOT a reason to start now, because the user's
   * complaint was precisely that opening the app began work they had not asked
   * for. The saved flag only decides what the switch shows.
   */
  if (state.config.enabled) {
    log('上次会话里代理是开启的；本次等待你点「启用代理」后再启动内核');
    state.config.enabled = false;
    state.config.autoEnabled = true;
    persist();
  } else {
    log('就绪（未启动内核）。点「启用代理」即可开始。');
  }
}

export { state as _state, testAllNodes as _testAllNodes, selectBest as _selectBest, failover as _failover, failoverWalk as _failoverWalk };
