# Third-party notices

The plugin's own source is MIT (see [LICENSE](LICENSE)). It **ships two things it
did not write**, and both keep their own licences.

## 1. mihomo — `bin/mihomo-windows-amd64-compatible.exe`

The proxy core. This is what makes the plugin self-contained: one binary can
speak VMess, VLESS, Trojan, Shadowsocks, Hysteria and the rest, which is not
something a JavaScript plugin could implement.

| | |
|---|---|
| Project | [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) |
| Version | `v1.19.15` (Windows amd64, "compatible" build) |
| Licence | **GPL-3.0** |
| Obtained from | <https://github.com/MetaCubeX/mihomo/releases> |
| SHA-256 | see `bin/mihomo.zip.sha256` (the release archive that was extracted) |

Because mihomo is GPL-3.0 and is redistributed here as a separate executable —
invoked as a subprocess, never linked into this plugin's code — the plugin's own
MIT-licensed source stays MIT. The binary itself remains GPL-3.0, and its
corresponding source is available from the project link above.

## 2. Geodata — `bin/geoip.metadb`, `bin/geosite.dat`

Routing and DNS decisions in a real subscription reference `GEOIP,CN`,
`GEOSITE` and `fallback-filter.geosite`, so the core needs these databases
**present before it can parse the configuration**. They are therefore bundled
rather than downloaded on first run.

| | |
|---|---|
| Project | [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) |
| Release | `latest` |
| Files | `geoip.metadb`, `geosite.dat` |
| Licence | **GPL-3.0** (the project's own licence; the underlying GeoIP data derives from MaxMind's GeoLite2, whose terms are in that repository) |
| Obtained from | <https://github.com/MetaCubeX/meta-rules-dat/releases> |

## Refreshing either one

```powershell
# Both must go through a working proxy, since the release assets live on GitHub.
node tools/fetch-kernel.mjs  http://127.0.0.1:7890
node tools/fetch-geodata.mjs http://127.0.0.1:7890
```

`fetch-geodata.mjs` takes the "lite" databases by default (a few hundred KB);
set `FULL_GEODATA=1` for the full-size ones. **Use the full ones in practice** —
the lite set omits the `gfw` category, and any subscription whose DNS config
references it will fail to start with `list gfw not found in geosite.dat`.
