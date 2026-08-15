# dsh-fschannel v0.2.0

Feishu/Lark bot bridge for DeepSeek Harness. Bind a web-created session to a Feishu chat; messages flow both ways over the official @larksuite/channel SDK (WebSocket long connection, no public callback URL).

## What's new since v0.1.5.4

### Internationalization (i18n)
- **Server-side copy** follows the host language: all Feishu-facing messages (guidance hints, `/model` command replies, queue acknowledgements, image hints, streaming-card placeholders, card-action toasts, error codes) now come from `lib/locales.js` zh/en dictionaries — the client reports the host's active locale (`POST /feishu/config { locale }`) and re-reports on `locale/change`, so Feishu replies switch language together with the Web UI
- **English README**: new `README.en.md` with a language switcher on both files; `README.md` stays Chinese (default) and GitHub serves the English version to English visitors automatically
- 49 keys, zh/en parity enforced by `scripts/smoke-locales.mjs` (key set + `{placeholder}` parity + fallback semantics)

### Image gallery & repair (from v0.1.5.x line)
- **API-driven session image gallery**: session-header "Feishu images" button opens a grid of staged images (click to view original); images are indexed in the plugin's own store and **no longer written into the session log** — the old `feishu/image` event type made the harness refuse the whole log
- **Session-log repair** at boot: marks historical `feishu/image` events as harness-accepted `ignorable`, and drops harness-synthesized `interrupted-tool-result` closer blocks whose seq range conflicts with real continuation events (duplicate-seq logs the harness refuses); incremental per-log fingerprints skip unchanged logs on later boots; manual re-run via `POST /feishu/repair-logs`

### Settings page
- **Bindings management as a table**: chat ocID (short, full-id tooltip) | session (short) | DSH session title (the workspace list name, e.g. "继续开发插件") | action; pending sessions share the table with a badge + created time
- Unified card layout, status dot, aligned inputs/buttons, zh/en headers

### Reliability fixes (highlights)
- **Security**: two CSRF bypasses closed on the loopback API; credential masking fixed (short secrets were echoed verbatim); loopback API hardened
- **Concurrency**: two processes can no longer clobber each other's bindings; the connect guard can actually fail and reconnect; a superseded session's response can no longer overwrite the current one
- **Correctness**: `resolveCredentials` tier-atomic (mixed sources no longer lose the secret); `bind()` no longer drops the session's model route; TTL de-index now matches; reaction misattribution fixed; gallery button stayed hidden after broadcasts — now re-reads
- **Cards**: table size capped (138 KB card degradation to markdown), fenced-code closing rules fixed
- **Streaming**: stream leak on teardown fixed; plugin teardown hardened

### Engineering
- `npm test` — offline gate: eslint no-undef + `tsc --noEmit` (strictNullChecks) + build + 14 smoke suites (incl. client-behavior, images-lifecycle, settings-render, locales)
- `.gitattributes` pinning line endings; `restart-dsh.ps1` reinstalls the plugin and verifies what actually runs
- Dead code removed (unused imports/methods), media-type tables collapsed to one source, boot-repair timer cleared on teardown, TTL-expired held images no longer leave orphan files

## 中文要点

- **国际化**：飞书侧所有文案（引导提示、/model 命令回复、排队提示、图片提示、流式卡片占位、卡片 toast、错误码）跟随宿主语言 —— 客户端上报宿主当前语言（`POST /feishu/config { locale }`），宿主切换语言时飞书回复同步切换；新增英文 README（`README.en.md`），中文 README 保持默认，GitHub 自动按访客语言重定向
- **图片画廊**：会话头「飞书图片」按钮打开图片网格；图片索引由插件自管，不再写入会话日志（旧事件类型会导致会话无法加载）；启动时自动修复历史日志（ignorable 标记 + seq 冲突清理，增量跳过），`POST /feishu/repair-logs` 可手动全量重跑
- **设置页**：绑定管理表格化（聊天 ocID / 会话 / DSH 会话标题 / 操作），统一卡片排版
- **可靠性**：关闭两个 CSRF 绕过、修复凭据掩码泄露、双进程绑定互踩、连接守卫失效、TTL 索引不匹配、表情误标、画廊按钮不刷新、超大卡片降级、流式泄漏等 20+ 项
- **工程**：`npm test` 离线门禁（eslint + tsc strictNullChecks + 构建 + 14 个冒烟套件）；移除死代码、合并重复表

## Installation

```sh
cp example.env .env      # path config only; credentials go to the settings page
npm install && npm run build
dsh plugin --profile web add file:<repo-path>
dsh web
```

See README (中文) / README.en.md (English) for the full setup guide (Feishu app creation, permissions, long-connection config, release scope).

## Notes

- Requires Node 22+; `@anionex/dsh-vision-toolkit` needed for image recognition
- Version line: 0.1.x (credential store, gallery, repair) → **0.2.0** (i18n + hardening)
