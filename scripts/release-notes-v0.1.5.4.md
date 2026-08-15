# dsh-fschannel v0.1.5.4

Feishu/Lark bot bridge for DeepSeek Harness. Bind a web-created session to a Feishu chat; messages flow both ways over the official @larksuite/channel SDK (WebSocket long connection, no public callback URL).

## Highlights

- **Credential store integration** — app credentials are saved via the settings page into the DSH credential store (`$DSH_HOME/.credentials.yaml`, masked appId, secret never echoed); layered resolution: entry config > credential service (env > store > project/user .env) > env file
- **Runtime-adjustable settings** — output mode (streaming cards / plain), in-session image display, image staging expiry and caps; all editable in the settings page and persisted per machine
- **Image gallery** — session-header "Feishu images" button opens an API-driven grid of every staged image (click to view original); images are indexed in the plugin's own store and **no longer written into the session log**
- **Session-log repair** — auto-repairs historical logs at boot: marks old `feishu/image` events as harness-accepted `ignorable`, and drops harness-synthesized `interrupted-tool-result` closer blocks whose seq range conflicts with real continuation events (a duplicate-seq log the harness refuses to load); manual re-run via `POST /feishu/repair-logs`
- **Settings page polish** — bindings management rendered as a table (chat ocID / session / DSH session title / action), unified card layout, zh/en headers
- **Single-member group exemption** — groups with one user + the bot answer without @-mention; `@all` never triggers the bot
- **Model controls from Feishu** — button card + `/model` family, `/status`, `/stop`, `/help`; per-session model route persisted and replayed
- **Reactions & queueing** — 👍 on receipt, ✅/☹️ on completion/failure; SDK-level dedup + per-chat serialization with queue position ack

## 中文要点

- 凭据改走 DSH 凭据库（设置页填写，appId 掩码显示，secret 永不回显）
- 图片以**会话内画廊**呈现（会话头「飞书图片」按钮），不再写入会话日志——旧日志由启动时自动修复（`ignorable` 标记 + seq 冲突段清理），`POST /feishu/repair-logs` 可手动重跑
- 设置页绑定管理改为表格：聊天 ocID / 会话 / DSH 会话名称 / 操作
- 单成员群免 @ 响应；`@all` 不响应

## Installation

```sh
cp example.env .env      # path config only; credentials go to the settings page
npm install && npm run build
dsh plugin --profile web add file:<repo-path>
dsh web
```

See the README for the full setup guide (Feishu app creation, permissions, long-connection config, release scope).

## Notes

- Requires Node 22+ and `@anionex/dsh-vision-toolkit` for image recognition
- Version line: `0.1.5.1` (credential store) → `0.1.5.3` (gallery + repair) → `0.1.5.4` (seq-conflict repair + full-session audit)
