/**
 * Fetch the plugin's geodata files and install them into bin/.
 *
 * Why this exists: the subscription's rules reference GEOIP/GEOSITE, so mihomo
 * needs the databases PRESENT BEFORE it can parse the config at all. Without
 * them it either deadlocks trying to download them or dies on the rule. They are
 * therefore bundled with the plugin, and this is the one-time bootstrap that
 * obtains them.
 *
 * Downloading goes through an HTTP proxy (default 127.0.0.1:7890 — any working
 * local proxy client), because the release assets live on GitHub.
 *
 * usage: node tools/fetch-geodata.mjs [proxy-url]
 */
import { createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const binDir = join(pluginRoot, 'bin');
mkdirSync(binDir, { recursive: true });

const proxy = new URL(process.argv[2] ?? 'http://127.0.0.1:7890');
const RELEASE = 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest';
const FULL = process.env.FULL_GEODATA === '1';

/** The lite databases are a fraction of the full ones and are enough to decide
 *  whether a destination is in China, which is all the plugin asks of them. */
const FILES = [
  { name: 'geoip.metadb', file: FULL ? 'geoip.metadb' : 'geoip-lite.metadb', min: 100_000 },
  { name: 'geosite.dat', file: FULL ? 'geosite.dat' : 'geosite-lite.dat', min: 100_000 },
  { name: 'asn.mmdb', file: 'GeoLite2-ASN.mmdb', min: 100_000, optional: true },
];

/** GET through the proxy, one hop at a time, following redirects manually. */
function get(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);

    const onResponse = (response, socket) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location !== undefined) {
        response.resume();
        if (socket !== undefined) socket.destroy();
        resolve(get(new URL(response.headers.location, url).toString()));
        return;
      }
      if (status !== 200) {
        response.resume();
        if (socket !== undefined) socket.destroy();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      resolve(response);
    };

    const connect = httpRequest({
      host: proxy.hostname,
      port: proxy.port === '' ? 80 : Number(proxy.port),
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: { host: `${target.hostname}:443` },
      timeout: 30000,
    });
    connect.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${response.statusCode}`));
        return;
      }
      const request = httpsRequest({
        host: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        method: 'GET',
        socket,
        agent: false,
        headers: { host: target.hostname, 'user-agent': 'dsh-net-proxy/0.1' },
      }, (res) => onResponse(res, socket));
      request.on('error', (error) => reject(new Error(`${error.code ?? 'ERR'} ${error.message}`)));
      request.end();
    });
    connect.on('timeout', () => { connect.destroy(); reject(new Error('proxy connect timeout')); });
    connect.on('error', (error) => reject(new Error(`${error.code ?? 'ERR'} ${error.message}`)));
    connect.end();
  });
}

let failures = 0;
for (const item of FILES) {
  const url = `${RELEASE}/${item.file}`;
  const destination = join(binDir, item.name);
  try {
    console.log(`fetching ${item.name} (${item.file}) …`);
    const response = await get(url);
    const total = Number(response.headers['content-length'] ?? 0);
    const temp = `${destination}.part`;
    const out = createWriteStream(temp);
    let got = 0;
    await new Promise((resolve, reject) => {
      response.on('data', (chunk) => {
        got += chunk.length;
        if (total) process.stdout.write(`\r  ${(got / 1024).toFixed(0)} / ${(total / 1024).toFixed(0)} KB`);
      });
      response.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      response.on('error', reject);
    });
    process.stdout.write('\n');
    const size = statSync(temp).size;
    if (size < item.min) throw new Error(`too small (${size} bytes)`);
    renameSync(temp, destination);
    writeFileSync(`${destination}.sha256`, `${createHash('sha256').update(String(size)).digest('hex')}  ${item.name} (${size} bytes)\n`, 'utf8');
    console.log(`  OK ${(size / 1024).toFixed(0)} KB`);
  } catch (error) {
    if (!item.optional) failures += 1;
    console.log(`  FAILED: ${error.message}`);
    rmSync(`${destination}.part`, { force: true });
  }
}

console.log(`\n${failures === 0 ? 'GEODATA OK' : failures + ' REQUIRED FILE(S) FAILED'}`);
console.log('bin/ now holds: ' + readdirSync(binDir).filter((f) => /\.(exe|dat|metadb|mmdb)$/i.test(f)).join(', '));
process.exit(failures === 0 ? 0 : 1);
