# dsh-net-proxy

**Paste this into your AI agent (Claude Code, Codex, Cursor, DeepSeek Harness — anything that can run commands) and it will install and configure this plugin for you:**

```text
Install the DSH plugin at https://github.com/FIZMIE/dsh-net-proxy into my DeepSeek Harness.
Read its README, wire it into ~/.dsh/profiles/<profile>/package.json and cordis.patch.yml,
then use the tools in its tools/ directory to fetch the mihomo core and geodata.
Ask me for my Clash subscription link, import it, turn the proxy on, and
verify it works by fetching https://github.com.
```

*A self-contained outbound proxy for the DeepSeek Harness desktop app.*

[中文说明](README.zh.md)

> **You need a subscription.** This plugin is a *client*. It does not sell, provide or
> bypass anything by itself — bring a Clash-format subscription link from whatever
> provider you already use. Without one it has no nodes to connect through.

---

## What it does

Paste a Clash subscription link once. The plugin then:

1. **Starts its own proxy core** — a bundled mihomo binary, so nothing else has to be installed
2. **Measures every node itself** against `https://github.com`, concurrently
3. **Uses the fastest one**, and switches automatically when a node dies
4. **Routes the agent's traffic through it** — `web_fetch`, model calls, and child processes like `git` and `npm`

No Clash client running in the background. No system proxy. No hosts file. No admin rights.

---

## Why it exists

Asking an agent to work with GitHub from a censored network goes like this: the request
times out, the agent concludes the network is broken, and you end up explaining your proxy
setup by hand, every session.

The usual fixes do not fit an agent:

- **A system proxy** is invisible to it — `fetch` inside a Node process does not use one.
- **A GUI proxy client** may not be running, and the agent cannot start a GUI app from its sandbox.
- **The client's own `url-test` group** re-tests on a fixed interval (often daily) against
  `gstatic.com`, which is not the site you actually care about, and it does not re-test when
  a request fails.

So this plugin measures the thing that matters, when it matters, and switches when a request
fails.

---

## Install

### The one-prompt way

Copy the block at the top of this file into an agent that can run shell commands. It has
everything it needs: the repo URL, where the profile lives, which tools to run, and how to
verify the result.

### By hand

```powershell
# 1. Clone somewhere permanent (not into the profile's node_modules)
git clone https://github.com/FIZMIE/dsh-net-proxy.git "$env:USERPROFILE\.dsh\plugins\dsh-net-proxy"

# 2. Let the profile see it
#    Add to $DSH_HOME\profiles\<profile>\package.json:
#      "dependencies": { "dsh-net-proxy": "link:C:/Users/<you>/.dsh/plugins/dsh-net-proxy" }
#      "dsh": { "profile": { "bundles": [ ..., "dsh-net-proxy" ] } }
#    then create the link so the loader resolves the name:
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-net-proxy" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-net-proxy"

# 3. Register the bundle in $DSH_HOME\profiles\<profile>\cordis.patch.yml:
#      - id: dsh-net-proxy
#        disabled: false

# 4. Check the pieces are in place
node "$env:USERPROFILE\.dsh\plugins\dsh-net-proxy\tools\verify-setup.mjs"

# 5. Restart DeepSeek Harness (a new host plugin cannot be hot-mounted)
```

The core and geodata are **committed to this repository**, so step 5 is the last one —
there is nothing to download. If you want to refresh them later (or you stripped them out
to keep the clone small), see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

## Use

Open **Settings → Network proxy**.

- **First time:** paste your subscription link, press **Update subscription**
- **Every other time:** press **Enable proxy**. That is the whole flow — it starts the core,
  ranks the nodes and takes over outbound traffic in about two seconds.

The node table shows every node with its measured latency; click one to pin it, or
**Fastest (automatic)** to go back to automatic selection. **Activity log** shows what the
plugin has been doing.

### It stays off until you ask

Opening the app does **nothing**: no core process, no subscription download, no dispatcher
(~4 ms). A previous session's "on" does not restore itself — the plugin starts closed and
waits for you to enable it. If you would rather not think about it, the agent-memory section
below tells the agent to enable it when a task needs it.

### Agent memory

On install the plugin appends a short section to `$DSH_HOME/AGENTS.md` teaching the agent
that the proxy exists and how to turn it on. Without it the agent has no way to know, and
would keep reporting GitHub as unreachable. It is written **once**, and only when no such
section is present — a file you have since edited is never rewritten. Set
`"writeMemory": false` in `$DSH_HOME/.dsh-net-proxy/config.json` to opt out.

---

## Verified behaviour

Measured against a real 23-node subscription:

| | |
|---|---|
| Nodes ranked | 23/23 reachable, fastest ≈ 90 ms, slowest ≈ 274 ms |
| Click to live | ≈ 2 s from pressing *Enable* |
| Cost of app start | ≈ 4 ms, and no process started |
| Exit IP, proxy on | `5.34.221.111` — Tokyo, JP (Akari Networks) |
| Exit IP, proxy off | `112.50.79.219` — Guangzhou, CN (China Mobile) |
| Failover | current node retired → walked to the next → `https://github.com` returned 200 |
| Loopback | stays direct (`127.0.0.1:19387` reached DSH itself, not the proxy) |

The core's own log is the proof that traffic went through it rather than somewhere else:

```
[TCP] 127.0.0.1:60196 --> github.com:443 match DomainKeyword(github) using 九云[...]
[TCP] 127.0.0.1:60206 --> 127.0.0.1:19387 match IPCIDR(127.0.0.0/8) using DIRECT
```

---

## Design notes

Worth reading before changing the code — most of these were learned the hard way.

**The subscription document is never reshaped.** mihomo's YAML parser rejects duplicate
mapping keys (stricter than the YAML spec), so prepending your own keys fails outright, and
lifting a block like `dns:` out of the document breaks its neighbours. The plugin rewrites
only a handful of listener/controller **scalars, in place**, and leaves every block exactly
where the provider put it — including provider quirks such as unquoted full-width colons in
node names.

**The subscription's own selector group is used, not a new one.** Creating a group would mean
editing the group list, which runs into the paragraph above. Real subscriptions ship a
selector covering all their nodes, so the plugin discovers it through the API and switches
within it.

**The proxy is swapped without a restart.** Routing goes through a single undici dispatcher
installed into Node's global-dispatcher slot — the same cross-package mechanism
`@deepseek-ai/dsh-http-proxy` uses. Because the dispatcher is read per request, a node switch
changes where the very next request goes.

**Geodata must be bundled, and must be the full set.** A subscription's rules reference
`GEOIP,CN` / `GEOSITE`, so the core needs the databases *before* it can parse the config.
Missing them, it tries to download from GitHub and **hangs with no error at all**. Pointing
`geox-url` at nothing makes it exit fatally. The "lite" databases omit the `gfw` category,
and a subscription whose DNS config references it fails with
`list gfw not found in geosite.dat`. The core also looks for these files in its *working
directory*, not beside the executable, so they are copied there on every start.

**The subscription download has a second path through the bundled core.** The host's own
`fetch` is subject to whatever proxy environment the process carries, and on a censored
network it may simply have no route out — which is the worst place to fail, because that
download is the plugin's only way in. So when `fetch` fails, the plugin starts its bundled
core on a throwaway config containing nothing but `MATCH,DIRECT` (no subscription, no nodes,
no geodata needed to boot), uses it as an HTTP proxy for the download, then tears it down. A
separate process with an ordinary network stack is a genuine second chance, and the provider
is usually the one host that *is* reachable directly.

**Start and stop are serialised, and stopping waits.** `child.kill()` only delivers a signal;
starting the replacement while the old process still holds its ports and working directory is
a race that presents as a second start silently hanging. Every start/stop runs through one
queue, the old process's exit is awaited, and its exit handler checks that it is still the
current child before touching any state.

**The runtime config is rebuilt on every start.** Writing it once and reusing it let the file
and the in-memory state disagree — a stale port in the file means the plugin polls an address
nothing is listening on and reports a core that actually started as a failure.

**Startup failures are surfaced, not swallowed.** Enabling answers immediately and finishes in
the background, so a throw there has no HTTP response to travel in. The error is parked in
`state.lastError` and read back from `/status`, because the alternative is a button that looks
like it did nothing.

---

## HTTP routes

All under `/dsh-net-proxy`, loopback-only:

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | Kernel, nodes, current exit, routing state, progress, last error |
| GET | `/log` | Last 200 activity lines |
| POST | `/enabled` | `{"enabled":true\|false}` — the master switch |
| POST | `/subscription` | `{"url":"..."}` — save the link |
| POST | `/refresh` | Re-download and reload; `{"preferCache":true}` to reuse the saved copy |
| POST | `/test` | Re-measure every node now |
| POST | `/select` | `{"node":"..."}` to pin, `{"node":"auto"}` to resume automatic |
| POST | `/kernel` | `{"action":"start"\|"stop"\|"restart"}` |
| POST | `/failover-test` | Walk the failover chain; `{"force":true}` retires the current node first |

## Layout

```
lib/index.js       host half: kernel lifecycle, subscription, ranking, failover, routing
client/client.js   browser half: the settings page (hand-written ModuleLoader bundle)
bin/               bundled mihomo core + geodata
tools/             fetch-kernel.mjs, fetch-geodata.mjs, verify-setup.mjs
```

## Requirements

- DeepSeek Harness desktop, Windows x64
- A Clash-format subscription link
- No admin rights, no other proxy client

## Known limitations

- **Clash YAML subscriptions only.** A base64 subscription link is rejected with a clear
  message; switch the format in your provider's dashboard.
- **HTTP proxies only.** DSH's own proxy layer accepts `http(s)://` URLs and the bundled core
  exposes an HTTP mixed port, so this is not a practical limit — but a SOCKS-only subscription
  is not supported.
- **Model requests bypass the proxy by default** (`proxyModelCalls: false`), so a broken node
  cannot take the conversation down with it. Change it in `config.json`.
- **The bundled core is Windows x64 only.** The plugin's own code is platform-neutral; `bin/` is not.
- **Geodata is not auto-updated.** It ships with the plugin; refresh it with
  `tools/fetch-geodata.mjs` when you care.

## Licence

MIT for this plugin's own source. The bundled mihomo core and geodata are GPL-3.0 and are
redistributed unmodified as separate files — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
