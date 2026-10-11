# dsh-net-proxy

**把下面这段直接粘给你的 AI Agent（Claude Code、Codex、Cursor、DeepSeek Harness——任何能跑命令的都行），它会帮你装好并配置这个插件：**

```text
把 https://github.com/FIZMIE/dsh-net-proxy 这个 DSH 插件装到我的 DeepSeek Harness 里。
读它的 README，接进 ~/.dsh/profiles/<profile>/package.json 和 cordis.patch.yml，
再用它 tools/ 目录里的脚本把 mihomo 内核和规则库拉下来。
问我要 Clash 订阅链接，导入，打开代理，然后访问 https://github.com 验证它真的通了。
```

*给 DeepSeek Harness 桌面版的**自包含出网代理**。*

[English](README.md)

> **你需要一个订阅。** 这个插件是**客户端**，它自己不提供也不售卖任何线路——请用你现有服务商的
> Clash 格式订阅链接。没有订阅它就没有节点可连。

---

## 它做什么

订阅链接只需粘一次。之后插件会：

1. **启动自己的代理内核** —— 内置 mihomo 二进制，不用额外装任何东西
2. **自己实测每个节点** —— 并发对 `https://github.com` 测延迟
3. **用最快的那个** —— 节点挂了自动切换
4. **接管 Agent 的出网** —— `web_fetch`、模型请求，以及 `git`、`npm` 这类子进程

不用后台常驻 Clash 客户端，不用开系统代理，不用改 hosts，不需要管理员权限。

---

## 为什么会有这个插件

在被墙的网络里让 Agent 干活是这样的：请求超时 → Agent 判断"网络坏了" → 你每次会话都要手动跟它解释一遍你的代理怎么开。

常见的办法对 Agent 都不好使：

- **系统代理**它看不见 —— Node 进程里的 `fetch` 根本不吃系统代理
- **图形界面代理客户端**可能没开着，而 Agent 在沙箱里也起不了 GUI 程序
- **客户端自带的 `url-test` 组**按固定间隔（常常是一天）对 `gstatic.com` 测速 —— 那既不是你关心的站点，而且请求失败时它也不会重测

所以这个插件做的事是：**在该测的时候，测你真正关心的那个站点；请求失败时立刻切换。**

---

## 安装

### 一句话交给 AI

把文件顶部那段粘给一个能执行 shell 的 Agent。那段话里已经包含它需要的一切：仓库地址、profile 在哪、跑哪些脚本、怎么验证结果。

### 手动安装

```powershell
# 1. 克隆到一个固定位置（别放进 profile 的 node_modules 里）
git clone https://github.com/FIZMIE/dsh-net-proxy.git "$env:USERPROFILE\.dsh\plugins\dsh-net-proxy"

# 2. 让 profile 认到它
#    在 $DSH_HOME\profiles\<profile>\package.json 里加：
#      "dependencies": { "dsh-net-proxy": "link:C:/Users/<你>/.dsh/plugins/dsh-net-proxy" }
#      "dsh": { "profile": { "bundles": [ ..., "dsh-net-proxy" ] } }
#    然后建链接，让加载器能解析这个名字：
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-net-proxy" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-net-proxy"

# 3. 在 $DSH_HOME\profiles\<profile>\cordis.patch.yml 里注册这个 bundle：
#      - id: dsh-net-proxy
#        disabled: false

# 4. 自检
node "$env:USERPROFILE\.dsh\plugins\dsh-net-proxy\tools\verify-setup.mjs"

# 5. 重启 DeepSeek Harness（新的宿主插件没法热挂载）
```

内核和规则库**已经提交在仓库里**，所以重启就是最后一步 —— 不需要下载任何东西。
以后想更新它们（或者你为了缩小克隆体积把它们删了），见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

## 用法

打开 **设置 → 网络代理**。

- **第一次**：粘订阅链接 → 点 **更新订阅**
- **之后每次**：点 **启用代理** 就行。整个流程就这一步 —— 它会启动内核、给所有节点测速、接管出网，大约 2 秒。

节点表会列出每个节点和实测延迟；点节点名可以**固定**用它，点 **自动选最快** 恢复自动。
**显示日志** 可以看到插件在干什么。

### 你不点它就一直关着

打开应用**什么都不会发生**：不起内核、不下载订阅、不挂载任何东西（约 4 ms）。
上次关掉时代理是开着的，**也不会**自动恢复 —— 插件每次启动都是关闭的，等你点。
如果你不想每次惦记它，下面那节"写进 Agent 记忆"就是干这个的。

### 写进 Agent 记忆

安装时插件会往 `$DSH_HOME/AGENTS.md` 追加一小节，告诉 Agent 有这个代理、怎么开。
没有这一步，Agent 根本不知道它存在，只会一直报"GitHub 连不上"。
它**只写一次**，且仅在文件里没有等效章节时才写 —— 你后来改过的文件永远不会被重写。
想关掉，把 `$DSH_HOME/.dsh-net-proxy/config.json` 里的 `"writeMemory"` 设为 `false`。

---

## 实测行为

在一个真实的 23 节点订阅上测得：

| | |
|---|---|
| 节点测速 | 23/23 可达，最快约 90 ms，最慢约 274 ms |
| 点击到可用 | 点「启用代理」后约 2 秒 |
| 应用启动开销 | 约 4 ms，且不启动任何进程 |
| 开代理后出口 IP | `5.34.221.111` — 🇯🇵 日本东京（Akari Networks） |
| 关代理时出口 IP | `112.50.79.219` — 🇨🇳 广东广州（China Mobile） |
| 故障切换 | 淘汰当前节点 → 自动走到下一个 → `https://github.com` 返回 200 |
| loopback | 始终直连（`127.0.0.1:19387` 打到 DSH 本体，没走代理） |

内核自己的日志是流量确实经过它的证据：

```
[TCP] 127.0.0.1:60196 --> github.com:443 match DomainKeyword(github) using 九云[...]
[TCP] 127.0.0.1:60206 --> 127.0.0.1:19387 match IPCIDR(127.0.0.0/8) using DIRECT
```

---

## 设计说明

改代码前值得读一遍 —— 下面每一条都是踩坑踩出来的。

**绝不重塑订阅文档。** mihomo 的 YAML 解析器**拒绝重复键**（比 YAML 规范严格），所以把自己的键前置会直接失败；而把 `dns:` 这类块从文档里抽出来会破坏相邻结构。插件只**就地改写几个监听/控制器的标量键**，所有块原样留在供应商放置的位置 —— 包括供应商的怪癖写法，比如节点名里不带引号的全角冒号。

**用订阅自带的选择组，不自建。** 自建组就要改组列表，又撞上上面那条。真实订阅都自带一个覆盖全部节点的 selector，所以插件通过 API 发现它并在其中切换。

**不重启换节点。** 路由走一个装在 Node 全局 dispatcher 槽位的 undici dispatcher —— 这就是 `@deepseek-ai/dsh-http-proxy` 用的同一套跨包机制。dispatcher 是每次请求读取的，所以切换节点会改变**下一个**请求的去向。

**规则库必须内置，而且必须是完整版。** 订阅规则里引用 `GEOIP,CN` / `GEOSITE`，所以内核**在解析配置之前就需要这些数据**。缺了它，内核会去 GitHub 下载然后**卡死且没有任何报错**；把 `geox-url` 置空则会直接 fatal 退出。而「精简版」数据库砍掉了 `gfw` 分类，DNS 配置引用了它的订阅会报 `list gfw not found in geosite.dat` 起不来。另外内核是在**工作目录**里找这些文件，不是可执行文件旁边，所以每次启动都会复制过去。

**订阅下载有第二条路：走内置内核。** 宿主的 `fetch` 受进程所带代理环境影响，在被墙的网络里可能**完全没有出口** —— 而这是最不该失败的地方，因为那次下载是插件的唯一入口。所以 `fetch` 失败时，插件会用一份只有 `MATCH,DIRECT` 的临时配置把内置内核拉起来（不需要订阅、不需要节点、不需要规则库就能启动），拿它当 HTTP 代理把订阅拉下来，然后清理掉。另一个进程有另一套网络栈，这是实打实的第二次机会；而订阅服务商通常恰恰是唯一直连可达的那个域名。

**启停串行，且停止要等进程真死。** `child.kill()` 只投递信号；旧进程还占着端口和工作目录时启动新的，表现为第二次启动**静默卡住**。所有启停走一条队列，旧进程的退出会被等待，而且它的 exit 回调会先确认自己仍是当前子进程才去动状态。

**运行配置每次启动重建。** 写一次然后复用，会让文件和内存状态不一致 —— 文件里留着过期端口，插件就会去一个没人监听的地址轮询，把**已经成功启动**的内核报成失败。

**启动失败要能看见，不能吞掉。** 启用是立即返回、后台完成的，所以那里的异常没有 HTTP 响应可搭车。错误会存进 `state.lastError`，由 `/status` 读回给界面 —— 否则用户看到的只是一个"点了没反应"的按钮。

---

## HTTP 接口

全部在 `/dsh-net-proxy` 下，仅接受环回来源：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/status` | 内核、节点、当前出口、路由状态、进度、最近错误 |
| GET | `/log` | 最近 200 行日志 |
| POST | `/enabled` | `{"enabled":true\|false}` 总开关 |
| POST | `/subscription` | `{"url":"..."}` 保存订阅链接 |
| POST | `/refresh` | 重新下载并加载；`{"preferCache":true}` 用本地缓存 |
| POST | `/test` | 立即重新测速 |
| POST | `/select` | `{"node":"..."}` 固定节点，`{"node":"auto"}` 恢复自动 |
| POST | `/kernel` | `{"action":"start"\|"stop"\|"restart"}` |
| POST | `/failover-test` | 走一遍故障切换；`{"force":true}` 先淘汰当前节点 |

## 目录结构

```
lib/index.js       宿主半边：内核生命周期、订阅、测速排序、故障切换、路由
client/client.js   浏览器半边：设置页（手写的 ModuleLoader bundle）
bin/               内置的 mihomo 内核 + 规则库
tools/             fetch-kernel.mjs、fetch-geodata.mjs、verify-setup.mjs
```

## 运行要求

- DeepSeek Harness 桌面版，Windows x64
- 一个 Clash 格式的订阅链接
- 不需要管理员权限，不需要其他代理客户端

## 已知限制

- **只吃 Clash YAML 订阅。** base64 订阅链接会被明确拒绝，请在服务商后台切换格式。
- **只支持 HTTP 代理。** DSH 自己的代理层只接受 `http(s)://`，而内置内核提供的是 HTTP 混合端口 —— 实际不构成限制，但纯 SOCKS 订阅不支持。
- **模型请求默认不走代理**（`proxyModelCalls: false`），这样坏节点不会把对话一起拖下水。可在 `config.json` 里改。
- **内置内核仅 Windows x64。** 插件自身代码与平台无关，但 `bin/` 不是。
- **规则库不自动更新。** 随插件走；需要时用 `tools/fetch-geodata.mjs` 刷新。

## 许可

插件自身源码为 MIT。内置的 mihomo 内核与规则库是 GPL-3.0，以独立文件形式原样再分发 —— 见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
