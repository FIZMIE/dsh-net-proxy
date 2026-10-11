/**
 * dsh-net-proxy — browser half.
 *
 * One settings page ("网络代理"). Hand-written ModuleLoader bundle, no build
 * step: the host serves this file from the package's `exports["./client"]`.
 *
 * The page is deliberately thin — it renders `/status` and posts to the routes.
 * All state (kernel, nodes, ranking, failover) lives in the host half, so a
 * page reload never loses anything.
 */
window.__ModuleLoader__.load({
	id: "dsh-net-proxy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = react.createElement;

		const NS = "dsh-net-proxy";
		const BASE = "/dsh-net-proxy";

		const zh = {
			title: "网络代理",
			subtitle: "内置 mihomo 内核 · 填订阅链接即用 · 自动选最快节点",
			subscription: "订阅链接",
			placeholder: "粘贴 Clash 订阅链接（http:// 或 https://）",
			import: "更新订阅",
			importing: "正在更新…",
			enable: "启用代理",
			enabling: "正在启用…",
			disable: "停用代理",
			disabling: "正在停用…",
			test: "重新测速",
			testing: "测速中…",
			nodes: "节点",
			current: "当前出口",
			noNodes: "还没有节点。填入订阅链接后点「更新订阅」，再点「启用代理」。",
			auto: "自动选最快",
			colNode: "节点",
			colDelay: "延迟",
			colStatus: "状态",
			inUse: "使用中",
			ok: "可用",
			dead: "不可用",
			cooldown: "冷却中",
			idle: "未测速",
			kernelMissing: "内核缺失",
			kernelStopped: "内核未运行（点「启用代理」会自动启动）",
			kernelRunning: "内核运行中",
			kernelStarting: "内核启动中…",
			kernelFailed: "内核启动失败",
			routingOn: "已接管出网",
			routingOff: "未接管（直连）",
			restartKernel: "重启内核",
			enableHint: "点「启用代理」会自动启动内核并选好最快节点，稍等几秒",
			log: "运行日志",
			showLog: "显示日志",
			hideLog: "隐藏日志",
			manualHint: "点节点名可固定使用该节点，再点「自动选最快」恢复自动",
			status: "状态",
		};
		const en = {
			title: "Network proxy",
			subtitle: "Bundled mihomo core · paste a subscription · fastest node chosen for you",
			subscription: "Subscription link",
			placeholder: "Paste a Clash subscription link",
			import: "Update subscription",
			importing: "Updating…",
			enable: "Enable proxy",
			enabling: "Enabling…",
			disable: "Disable proxy",
			disabling: "Disabling…",
			test: "Re-test nodes",
			testing: "Testing…",
			nodes: "Nodes",
			current: "Current exit",
			noNodes: "No nodes yet. Paste a subscription link, press Update, then Enable.",
			auto: "Fastest (automatic)",
			colNode: "Node",
			colDelay: "Delay",
			colStatus: "Status",
			inUse: "in use",
			ok: "ok",
			dead: "dead",
			cooldown: "cooling down",
			idle: "untested",
			kernelMissing: "Core missing",
			kernelStopped: "Core not running (Enable starts it)",
			kernelRunning: "Core running",
			kernelStarting: "Core starting…",
			kernelFailed: "Core failed",
			routingOn: "Outbound intercepted",
			routingOff: "Direct (not intercepted)",
			restartKernel: "Restart core",
			enableHint: "Enabling starts the core and picks the fastest node — a few seconds",
			log: "Activity log",
			showLog: "Show log",
			hideLog: "Hide log",
			manualHint: "Click a node name to pin it; click Fastest to resume automatic",
			status: "Status",
		};

		// Maple Mono CN first (the user's house font), generic fallback last.
		const CSS = [
			`.dsnp{--dsnp-fg:var(--dsh-text-primary,inherit);--dsnp-dim:var(--dsh-text-tertiary,#8a8f98);--dsnp-line:var(--dsh-border-subtle,rgba(127,127,127,.22));--dsnp-bg:var(--dsh-surface-subtle,rgba(127,127,127,.06));font-family:"Maple Mono CN","Maple Mono CN Medium",ui-monospace,SFMono-Regular,Menlo,Consolas,"Microsoft YaHei UI",monospace;display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;color:var(--dsnp-fg)}`,
			`.dsnp h2{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}`,
			`.dsnp .sub{color:var(--dsnp-dim);font-size:12px;margin-top:2px}`,
			`.dsnp .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}`,
			`.dsnp .field{display:flex;flex-direction:column;gap:6px}`,
			`.dsnp label{font-size:12px;color:var(--dsnp-dim)}`,
			`.dsnp input[type=text]{flex:1;min-width:280px;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsnp-line);background:transparent;color:inherit;font:inherit;font-size:12px}`,
			`.dsnp input[type=text]:focus{outline:2px solid #4d6bfe;outline-offset:1px}`,
			`.dsnp button{height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsnp-line);background:var(--dsnp-bg);color:inherit;font:inherit;font-size:12px;cursor:pointer}`,
			`.dsnp button:hover:not(:disabled){border-color:#4d6bfe}`,
			`.dsnp button:disabled{opacity:.5;cursor:not-allowed}`,
			`.dsnp button.primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}`,
			`.dsnp .cards{display:flex;gap:10px;flex-wrap:wrap}`,
			`.dsnp .card{flex:1 1 190px;border:1px solid var(--dsnp-line);border-radius:10px;padding:10px 12px;background:var(--dsnp-bg)}`,
			`.dsnp .card .k{font-size:11px;color:var(--dsnp-dim)}`,
			`.dsnp .card .v{font-size:14px;margin-top:4px;word-break:break-all}`,
			`.dsnp .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle}`,
			`.dsnp .ok{background:#2fbf71}.dsnp .bad{background:#e5534b}.dsnp .warn{background:#d29922}`,
			`.dsnp table{width:100%;border-collapse:collapse;font-size:12px}`,
			`.dsnp th,.dsnp td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--dsnp-line)}`,
			`.dsnp th{color:var(--dsnp-dim);font-weight:500;position:sticky;top:0;background:var(--dsh-surface,transparent)}`,
			`.dsnp td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}`,
			`.dsnp .list{max-height:320px;overflow:auto;border:1px solid var(--dsnp-line);border-radius:10px}`,
			`.dsnp tr.active{background:rgba(77,107,254,.12)}`,
			`.dsnp tr.clickable{cursor:pointer}`,
			`.dsnp tr.clickable:hover{background:rgba(127,127,127,.10)}`,
			`.dsnp pre{max-height:220px;overflow:auto;margin:0;padding:10px;border-radius:10px;border:1px solid var(--dsnp-line);background:var(--dsnp-bg);font-size:11px;line-height:1.5;white-space:pre-wrap}`,
			`.dsnp .muted{color:var(--dsnp-dim);font-size:11px}`,
			`.dsnp .err{color:#e5534b;font-size:12px;word-break:break-all}`,
		].join("");

		/** Inject the stylesheet once per document. */
		function ensureCss() {
			if (typeof document === "undefined") return;
			const tagId = NS + "/client.css";
			if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = NS;
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const post = async (path, body) => {
			const response = await fetch(BASE + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {}),
			});
			const text = await response.text();
			let parsed;
			try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
			if (!response.ok) throw new Error(parsed?.error ?? "HTTP " + response.status);
			return parsed;
		};

		const Status = ({ node, current, t }) => {
			if (node === undefined) return h("span", null, t("idle"));
			if (node.name === current) return h("span", null, t("inUse"));
			if (node.status === "ok") return h("span", null, t("ok"));
			if (node.status === "dead") return h("span", null, t("dead"));
			if (node.status === "cooldown") return h("span", null, t("cooldown"));
			return h("span", null, t("idle"));
		};

		/** The settings page body. */
		function Page(props) {
			const t = props.t;
			const [status, setStatus] = react.useState(undefined);
			const [url, setUrl] = react.useState("");
			const [busy, setBusy] = react.useState("");
			const [error, setError] = react.useState("");
			const [logText, setLogText] = react.useState("");
			const [showLog, setShowLog] = react.useState(false);
			const urlTouched = react.useRef(false);

			const load = react.useCallback(async () => {
				try {
					const response = await fetch(BASE + "/status", { cache: "no-store" });
					const parsed = await response.json();
					setStatus(parsed);
					if (!urlTouched.current && typeof parsed.subscriptionUrl === "string") setUrl(parsed.subscriptionUrl);
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				}
			}, []);

			react.useEffect(() => {
				void load();
				const timer = setInterval(() => void load(), 2500);
				return () => clearInterval(timer);
			}, [load]);

			react.useEffect(() => {
				if (!showLog) return undefined;
				const pull = async () => {
					try {
						const response = await fetch(BASE + "/log", { cache: "no-store" });
						const parsed = await response.json();
						setLogText((parsed.lines ?? []).join("\n"));
					} catch { /* keep the previous text */ }
				};
				void pull();
				const timer = setInterval(() => void pull(), 2000);
				return () => clearInterval(timer);
			}, [showLog]);

			const run = async (label, fn) => {
				setBusy(label);
				setError("");
				try { await fn(); } catch (cause) { setError(String(cause?.message ?? cause)); } finally {
					setBusy("");
					void load();
				}
			};

			const kernel = status?.kernel ?? {};
			const kernelOk = kernel.status === "running";
			const kernelLabel = kernel.status === "running" ? t("kernelRunning")
				: kernel.status === "starting" ? t("kernelStarting")
					: kernel.status === "missing" ? t("kernelMissing")
						: kernel.status === "failed" ? t("kernelFailed") : t("kernelStopped");
			const nodes = status?.nodes ?? [];
			const alive = nodes.filter((n) => n.status === "ok").length;

			// The host works in the background, so "coming up" is its own phase:
			// the switch is on but the kernel is not serving yet.
			const startingUp = status?.busy === "enable" || kernel.status === "starting";
			const dotClass = kernelOk ? "ok" : startingUp ? "warn" : "bad";

			const switchLabel = busy === "enable" || startingUp ? t("enabling")
				: busy === "disable" ? t("disabling")
					: status?.enabled ? t("disable") : t("enable");

			return h("div", { className: "dsnp" },
				h("div", null,
					h("h2", null, t("title")),
					h("div", { className: "sub" }, t("subtitle")),
				),

				h("div", { className: "row" },
					h("button", {
						className: status?.enabled ? "" : "primary",
						// One click is the whole flow, so this must never be
						// gated on the user having primed anything first.
						disabled: busy !== "" || startingUp,
						onClick: () => void run(status?.enabled ? "disable" : "enable", () => post("/enabled", { enabled: !status?.enabled })),
					}, switchLabel),
					h("button", {
						disabled: busy !== "" || nodes.length === 0,
						onClick: () => void run("test", () => post("/test", {})),
					}, status?.testing || busy === "test" ? t("testing") : t("test")),
					kernelOk
						? h("button", {
							disabled: busy !== "",
							onClick: () => void run("kernel", () => post("/kernel", { action: "restart" })),
						}, t("restartKernel"))
						: null,
				),
				!status?.enabled && nodes.length > 0
					? h("div", { className: "muted" }, t("enableHint"))
					: null,

				h("div", { className: "cards" },
					h("div", { className: "card" },
						h("div", { className: "k" }, t("status")),
						h("div", { className: "v" }, h("span", { className: "dot " + dotClass }), kernelLabel),
						status?.proxyUrl ? h("div", { className: "muted" }, status.proxyUrl) : null,
					),
					h("div", { className: "card" },
						h("div", { className: "k" }, t("current")),
						h("div", { className: "v" }, status?.current ?? "—"),
						h("div", { className: "muted" },
							(status?.pinnedNode && status.pinnedNode !== "auto" ? "固定 · " : t("auto") + " · ")
							+ alive + "/" + nodes.length + " " + t("ok")),
					),
					h("div", { className: "card" },
						h("div", { className: "k" }, t("routingOn")),
						h("div", { className: "v" }, h("span", { className: "dot " + (status?.routing?.installed ? "ok" : "bad") }),
							status?.routing?.installed ? t("routingOn") : t("routingOff")),
						status?.routing?.error ? h("div", { className: "err" }, status.routing.error) : null,
					),
				),

				h("div", { className: "field" },
					h("label", null, t("subscription")),
					h("div", { className: "row" },
						h("input", {
							type: "text",
							value: url,
							placeholder: t("placeholder"),
							onChange: (event) => { urlTouched.current = true; setUrl(event.target.value); },
						}),
						h("button", {
							className: "primary",
							disabled: busy !== "",
							onClick: () => void run("import", async () => {
								await post("/subscription", { url });
								await post("/refresh", {});
							}),
						}, busy === "import" ? t("importing") : t("import")),
					),
				),

				error !== "" ? h("div", { className: "err" }, error) : null,
				// A background failure has no HTTP response to ride in, so the
				// host parks it in the status snapshot for us to show.
				error === "" && status?.lastError ? h("div", { className: "err" }, status.lastError) : null,
				kernel.status === "failed" || kernel.status === "missing"
					? h("div", { className: "err" }, kernel.error ?? "")
					: null,

				h("div", null,
					h("div", { className: "row", style: { justifyContent: "space-between" } },
						h("label", null, t("nodes") + " (" + nodes.length + ")"),
						h("span", { className: "muted" }, t("manualHint")),
					),
					nodes.length === 0
						? h("div", { className: "muted", style: { marginTop: 6 } }, t("noNodes"))
						: h("div", { className: "list" },
							h("table", null,
								h("thead", null, h("tr", null,
									h("th", null, t("colNode")),
									h("th", { className: "num" }, t("colDelay")),
									h("th", null, t("colStatus")),
								)),
								h("tbody", null, nodes.map((node) => h("tr", {
									key: node.name,
									className: (node.name === status?.current ? "active " : "") + "clickable",
									onClick: () => void run("select", () => post("/select", { node: node.name })),
									title: node.error ?? node.name,
								},
									h("td", null, node.name),
									h("td", { className: "num" }, node.delay === undefined ? "—" : node.delay + " ms"),
									h("td", null, h(Status, { node, current: status?.current, t })),
								))),
							),
						),
					status?.pinnedNode && status.pinnedNode !== "auto"
						? h("div", { className: "row", style: { marginTop: 6 } },
							h("button", { onClick: () => void run("select", () => post("/select", { node: "auto" })) }, t("auto")))
						: null,
				),

				h("div", null,
					h("button", { onClick: () => setShowLog(!showLog) }, showLog ? t("hideLog") : t("showLog")),
					showLog ? h("pre", { style: { marginTop: 8 } }, logText) : null,
				),
			);
		}

		/** Build a translator backed by the plugin locale registry. */
		function translator(ctx) {
			let bound;
			try {
				ctx.locale.register(NS, { zh, en });
				bound = ctx.locale.bind(NS);
			} catch { bound = undefined; }
			return (key) => {
				if (bound !== undefined) {
					try {
						const value = bound(key);
						if (typeof value === "string" && value !== "" && value !== key) return value;
					} catch { /* fall through */ }
				}
				return zh[key] ?? key;
			};
		}

		/** Client plugin body. */
		function apply(ctx) {
			ensureCss();
			const t = translator(ctx);
			try {
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "net-proxy",
					order: 55,
					label: () => t("title"),
					locale: NS,
					inject: () => ({ t }),
				}, Page));
			} catch (error) {
				console.warn("[dsh-net-proxy] settings.section registration failed", error);
			}
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		return module.exports;
	},
});
