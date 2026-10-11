/**
 * Download the mihomo core zip through a working local proxy into the plugin's
 * bin/ directory. One-time bootstrap step (see plan section 4).
 *
 * usage: node tools/fetch-kernel.mjs <proxy-url> [dest-dir]
 *   e.g. node tools/fetch-kernel.mjs http://127.0.0.1:7890
 *
 * Uses raw node:http/https with a CONNECT tunnel rather than fetch, so it has
 * zero dependency on undici resolution inside the DSH process.
 */
import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');

const proxyUrl = process.argv[2];
const destDir = process.argv[3] ?? join(PLUGIN_ROOT, 'bin');

if (!proxyUrl) {
  console.error('usage: node tools/fetch-kernel.mjs <proxy-url> [dest-dir]');
  process.exit(2);
}

const VERSION = 'v1.19.15';
const ASSET = `mihomo-windows-amd64-compatible-${VERSION}.zip`;
const RELEASE = `https://github.com/MetaCubeX/mihomo/releases/download/${VERSION}`;
const SOURCES = [
  `${RELEASE}/${ASSET}`,
  `https://ghproxy.net/${RELEASE}/${ASSET}`,
  `https://gh-proxy.com/${RELEASE}/${ASSET}`,
  `https://ghfast.top/${RELEASE}/${ASSET}`,
];

/** One GET through an HTTP proxy, following redirects. Resolves to the stream. */
function proxiedGet(url, proxy, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('too many redirects'));
    const target = new URL(url);
    const hop = new URL(proxy);

    const onResponse = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(proxiedGet(new URL(res.headers.location, url).toString(), proxy, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      resolve(res);
    };

    const commonHeaders = { 'user-agent': 'dsh-net-proxy/0.1', accept: '*/*' };

    if (target.protocol === 'https:') {
      const port = target.port || 443;
      const connectReq = httpRequest({
        host: hop.hostname,
        port: hop.port || 80,
        method: 'CONNECT',
        path: `${target.hostname}:${port}`,
        headers: { host: `${target.hostname}:${port}` },
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`proxy CONNECT ${res.statusCode}`));
          return;
        }
        const tlsReq = httpsRequest(
          {
            host: target.hostname,
            port,
            path: target.pathname + target.search,
            method: 'GET',
            socket,
            agent: false,
            headers: { host: target.hostname, ...commonHeaders },
          },
          onResponse,
        );
        tlsReq.on('error', reject);
        tlsReq.end();
      });
      connectReq.on('error', reject);
      connectReq.end();
      return;
    }

    const req = httpRequest(
      {
        host: hop.hostname,
        port: hop.port || 80,
        method: 'GET',
        path: url,
        headers: { host: target.host, ...commonHeaders },
      },
      onResponse,
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  mkdirSync(destDir, { recursive: true });
  const zipPath = join(destDir, 'mihomo.zip');

  let lastError;
  for (const url of SOURCES) {
    try {
      console.log(`trying ${url}`);
      const res = await proxiedGet(url, proxyUrl);
      const total = Number(res.headers['content-length'] ?? 0);
      let got = 0;
      const out = createWriteStream(zipPath);
      await new Promise((resolve, reject) => {
        res.on('data', (chunk) => {
          got += chunk.length;
          if (total) process.stdout.write(`\r  ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
        });
        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        res.on('error', reject);
      });
      process.stdout.write('\n');
      const size = statSync(zipPath).size;
      if (size < 1024 * 1024) throw new Error(`suspiciously small download (${size} bytes)`);
      const digest = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
      console.log(`downloaded ${size} bytes`);
      console.log(`sha256 ${digest}`);
      writeFileSync(join(destDir, 'mihomo.zip.sha256'), `${digest}  ${basename(zipPath)}\n`, 'utf8');
      console.log('OK -> ' + zipPath);
      return;
    } catch (error) {
      lastError = error;
      console.log(`  failed: ${error.message}`);
      rmSync(zipPath, { force: true });
    }
  }
  throw lastError ?? new Error('all sources failed');
}

main().catch((error) => {
  console.error('FETCH KERNEL FAILED: ' + error.message);
  process.exit(1);
});
