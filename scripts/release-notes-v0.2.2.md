# dsh-fschannel v0.2.2

Feishu/Lark bot bridge for DeepSeek Harness. Bind a web-created session to a Feishu chat; messages flow both ways over the official @larksuite/channel SDK (WebSocket long connection, no public callback URL).

## What's new since v0.2.1

### Embedded card images (this release)
- **Local images are embedded into final cards — no remote links**: when the assistant's reply contains a markdown image reference (`![alt](path)`) pointing to a real image file inside the session workspace, the plugin uploads the bytes (`im.v1.image.create`, `image_type: message`) and renders a card v2 `img` element with the alt text; the markdown syntax is removed from the prose
- Remote URLs and unreadable paths are **never** embedded: the reference is stripped from the card and the alt text is kept as plain prose — no dead/broken images, no leaked links
- Images are appended after the text elements; a reply that is only images produces a bare image card
- Path resolution is confined to the session workspace (same `relative()` rule incl. Windows cross-drive as the image route and the send tools)

### Settings page
- **Plugin version shown in the status card** — `/feishu/status` now returns `version` (read once from the package manifest), displayed monospace in the settings status card (zh/en)

## 中文要点

- **卡片图片内嵌**（本次核心）：agent 回复中的 markdown 图片引用（`![说明](路径)`）若指向会话工作区内的本地图片文件，会自动上传并以内嵌 `img` 元素显示在最终卡片里——**不显示远程链接/死链**；远程 URL 或无法读取的路径不会出现在卡片中（保留说明文字）
- **设置页显示插件版本号**：状态卡片新增「插件版本」，`/feishu/status` 返回 `version`

## Full feature set (v0.2.x line)

- **i18n**: Feishu-facing copy follows the host locale (client reports `locale`; zh/en dictionaries for all messages, commands, toasts, error codes)
- **Image gallery**: session-header "Feishu images" button (API-driven grid; images no longer written into the session log)
- **Session-log repair**: boot-time auto-repair (ignorable markers + seq-conflict closer removal, incremental fingerprints); `POST /feishu/repair-logs` forces a pass
- **Settings page**: bindings table (chat ocID / session / DSH title / action), unified card layout
- **Send tools**: `send_feishu_image` and `send_feishu_file` — the agent can deliver generated images/files to the bound chat (workspace-confined paths, Buffer upload, optional caption/file name)
- **Reliability**: CSRF closure, credential masking, concurrency fixes, stream leaks, oversized-card degradation, TTL de-index, etc.

## Installation

```sh
cp example.env .env      # path config only; credentials go to the settings page
npm install && npm run build
dsh plugin --profile web add file:<repo-path>
dsh web
```

See README (中文) / README.en.md (English) for the full setup guide.

## Notes

- Requires Node 22+; `@anionex/dsh-vision-toolkit` needed for image recognition
- Version line: 0.2.0 (i18n + hardening) → 0.2.1 (send tools) → **0.2.2** (embedded card images + version display)
