# dsh-fschannel

**English** | [中文](README.md)

Connect a DeepSeek Harness Web session to a Feishu bot: **choose "Connect Feishu" when creating a new session**, then send the bot a message in Feishu — the message is delivered into that DSH session for the agent to process, and replies flow back to the Feishu chat. Web and Feishu can drive the same session at the same time.

The transport layer uses the official Feishu [@larksuite/channel](https://github.com/larksuite/channel-sdk-node) SDK — **WebSocket long connection, no public callback URL required**.

---

## Features

### Session ↔ Feishu chat bridge
- One-to-one binding (one session ↔ one chat, replaced on either side), persisted in `$DSH_HOME/feishu-bindings.json`
- **Pending-bind mechanism**: a session marked as pending is bound to the chat of your **next message** to the bot (FIFO)
- Agents are `resume`d automatically when offline; bindings survive restarts

### Messaging
- **Streaming cards** (default `output: 'stream'`): the card opens the moment a turn starts (showing "正在处理…"/processing), replies type out character by character; tool calls show a "正在调用工具：{name}" reference line; **when the turn ends the card keeps the final result**, automatically re-laid-out as a structured card (paragraphs/tables/code blocks rendered from markdown; empty or failed turns stay on the card). Falls back to plain messages without card permission
- `output: 'plain'` switches to "one markdown message per step"
- **Queueing**: SDK-level dedup (30s) + per-chat serialized delivery; when the agent is busy it replies with the queue position
- **Reactions**: inbound messages get 👍, the turn completes to ✅, fails to ☹️ (configurable emoji and toggles; only applies to your own messages, Web-driven turns never get swapped)
- **Image staging & recognition**: Feishu images are staged first, then delivered with your NEXT text message as file paths plus a recognition instruction — the agent loads the vision-tools skill and recognizes each image with vision tools (vision_glance/vision_ocr etc.), answering combined with the text (requires @anionex/dsh-vision-toolkit installed and its runtime ready; images live in the session workspace `.dsh-fschannel-images/`)
- **Session image gallery**: the "Feishu images" button in the session header opens a grid of that session's images (click to view the original). Image metadata is managed by the plugin itself (`feishu-bindings.json`) and is **no longer written into the session log** — the old `feishu/image` event type was unknown to the harness and made the whole session unloadable; since v0.1.5.3 the plugin repairs historical logs at boot (marks those events with the harness-accepted `ignorable` flag) and re-indexes historical images
- Groups only answer when the bot is @-mentioned by default (`requireMention`); unbound chats get a guidance hint (can be disabled)

### Model control from Feishu
- Mentioning "调整/切换/查看 模型/effort" pops a **button card** showing the current model and reasoning level with one-click switching
- `/model` — same card (query current model & effort)
- `/model list` — model directory (including per-model effort levels)
- `/model use <provider>/<model>` — switch model (applies from the next message)
- `/model effort <off|high|max>` — switch reasoning effort
- `/status` — session & bot status; `/stop` — stop the current turn; `/help` — command list
- Switches go through the host `apiProxy` (same channel as the Web UI) and are **session-persistent**: replayed automatically after a restart

### Connecting Feishu (when creating a session)
- Session-header chip: unbound → "连接飞书" (Connect Feishu); pending → "send the bot a message to bind"; bound → chat name shown (click to disconnect)
- Settings → **飞书机器人** (Feishu Bot) tab (dedicated page): status, output mode, "auto-connect new sessions" toggle, "new session and connect" button, binding/pending management, command reference

---

## Installation

Prerequisites: Node 22.19+, `dsh` CLI and `pnpm` installed (`npm i -g @deepseek-ai/dsh pnpm`).

```sh
# 1. Prepare the environment (.env holds path config only; credentials go to
#    the settings page after startup)
cp example.env .env      # adjust FSCHANNEL_REPO / FSCHANNEL_ENV_FILE as needed

# 2. Build the client (run after every source change)
npm install && npm run build

# 3. Install into the web profile (file: copies the package into the pnpm
#    store and installs its dependencies; the repo path can also be set in
#    FSCHANNEL_REPO in .env)
dsh plugin --profile web add file:<plugin-repo-path>

# 4. Restart dsh web to apply
dsh web
```

> On first install pnpm may report `ERR_PNPM_IGNORED_BUILDS` (protobufjs) due to build-script policy; the profile's `pnpm-workspace.yaml` already has `allowBuilds: { protobufjs: false }`.

---

## Configuration

The `feishu-bot` entry (from the bundled `cordis.patch.yml`, applied automatically as a bundle layer):

| Field | Default | Description |
|---|---|---|
| `envFile` | `<cwd>/.env` | Path-config file (FSCHANNEL_* keys); no longer carries credentials |
| `appId` / `appSecret` | credential store | Direct entry-config override; the settings page "连接凭据" saves into the DSH credential store |
| `requireMention` | `true` | Groups answer only when @-mentioned; single-member groups (1 user + bot) skip the @ check |
| `output` | `stream` | `stream` = streaming typewriter cards (plain fallback on failure); `plain` = one message per step |
| `modelCardTriggers` | `true` | Auto-pop the button card when model/effort is mentioned |
| `queueAck` | `true` | Reply with the queue position when the agent is busy |
| `ackInbound` | `false` | Reply "received, processing…" even when idle |
| `reactInbound` | `true` | Reaction feedback on inbound messages (👍→✅/☹️) |
| `reactReceived` / `reactDone` / `reactError` | `THUMBSUP` / `DONE` / `SAD` | Emoji per stage (Feishu standard emoji_type, customizable) |
| `holdImages` | `true` | Stage Feishu images and recognize them with the next text |
| `holdHint` | `true` | Reply "received N images…" to image-only messages |
| `maxHeldImages` | `10` | Staged-image cap per chat |
| `maxHeldImageBytes` | `10 MiB` | Per-image size cap |
| `holdTtlMs` | `0` | Staging expiry (ms, 0 = keep forever) |
| `imageDir` | `<cwd>/.dsh-fschannel-images` | Staging directory (must be inside the session workspace) |
| `hintUnbound` | `true` | Guidance reply to unbound chats |
| `hintText` | built-in | Custom guidance text |
| `bindingsFile` | `$DSH_HOME/feishu-bindings.json` | Binding persistence path |

Credential precedence: plugin config `appId/appSecret` > credential service (shell-exported env > DSH credential store `$DSH_HOME/.credentials.yaml` > project `.env` > `~/.dsh/.env`) > plugin `envFile`. **Recommended**: fill in appId/appSecret on the settings page "飞书机器人 → 连接凭据", saved to the credential store (appId shown masked, secret never echoed; don't put credentials in `.env`).

**Path config (in `.env`, not committed)**: `FSCHANNEL_REPO` (plugin repo root, used by scripts/restarts), `FSCHANNEL_ENV_FILE` (.env's own path, defaults to the working directory), `FSCHANNEL_BINDINGS_FILE` (binding data file, defaults to `$DSH_HOME/feishu-bindings.json`). `cordis.patch.yml`'s `envFile` resolution: `FSCHANNEL_ENV_FILE` env var (exported by `scripts/restart-web.ps1` from .env) → `<cwd>/.env`.

---

## Usage

### Bind a session to Feishu

1. Create a session in the Web UI (or open an existing one)
2. Click "连接飞书" (Connect Feishu) next to the session title (pending state), or:
   - Settings → Feishu Bot tab: enable "auto-connect new sessions" → every new session becomes pending automatically
   - Settings → Feishu Bot tab: "new session and connect" creates and marks pending in one step
3. Send the bot a direct message (or @ it in a group) → that chat binds to this session
4. Chat messages enter the session for processing: replies stream back, Web and Feishu interoperate; the session-header chip shows connected (click to disconnect)

> The "绑定管理" (bindings management) section on the settings page lets you manage: bound sessions can be "断开" (detached); **pending sessions can be "取消待绑定" (cancelled)** (e.g. sessions created but never used).

### Feishu-side commands and cards

| Input | Effect |
|---|---|
| "调整模型" "切换模型" "把 effort 调一下" etc. | Pops the **button card** (model Pro/Flash + effort off/high/max one-click switch) |
| `/model` | Pops the same card |
| `/model list` | Lists the model directory |
| `/model use <provider>/<model>` | Switches model |
| `/model effort <off\|high\|max>` | Switches reasoning effort |
| `/status` | Session & bot status |
| `/stop` | Stops the current turn |
| `/help` | Command list |

---

## Notes

- **File changes & restart**: the plugin source lives in the plugin repo (local path in `FSCHANNEL_REPO` in `.env`); after code changes run `npm run build` (when the client changed) → `dsh plugin --profile web add file:<plugin-repo-path>` (re-copy into the store) → restart `dsh web`.
- **Config is read once at startup**: changes to `cordis.patch.yml` need a restart.
- **Credential safety**: credentials live in `$DSH_HOME/.credentials.yaml` (0600, dsh credential store), never echoed by the settings page; `.env` holds path config only and is safe to commit (the repo `.env` is still gitignored; `example.env` is safe to commit).
- **HTTP API is loopback-only**: `/feishu/*` accepts only 127.0.0.1 (same origin as the Web GUI).
- **Streaming cards need card capability**: without card permission the SDK falls back to plain messages; `output: 'plain'` disables cards entirely.
- **Images are staged & recognized, files are not forwarded**: images are staged (`.dsh-fschannel-images/`) and recognized by the agent via vision-tools with the next text; other file types are normalized to text hints; streaming cards carry text and tool-activity lines only.
- **Multi-step turns**: one turn (including multiple tool calls) accumulates on the same streaming card.
- **One chat ↔ one session**: re-binding replaces the old binding (the old session is auto-unbound).
- **Unbound chats**: default is a guidance hint; no session is auto-created.
- **Trigger matching**: the model card only triggers on intent phrases like "调整/切换/查看 模型|effort"; the occasional word "模型" in a message does not misfire.
- **Reaction permission**: reactions depend on the `im:message` scope (the same one used to receive messages); failures are logged only and never break send/receive.
- **Final card layout**: at turn end the streaming card is replaced by a structured card (tables rendered with the card v2 table component); if the platform rejects structured cards it degrades to a plain markdown card — the final result is always visible.

### Relationship with dsh upgrades (update immunity)

| Layer | Location | After a dsh upgrade |
|---|---|---|
| Plugin itself | plugin repo (git repo, path in `FSCHANNEL_REPO` in `.env`) | retained |
| Registration entry | bundled `cordis.patch.yml` (bundle layer, reconciled by `dsh plugin`) | retained |
| Binding data | `$DSH_HOME/feishu-bindings.json` | retained |

No internal dsh package files are modified; no re-patching is needed after an upgrade.

---

## Development

```sh
npm test             # the gate: lint + build + all 10 offline smokes (run before committing)
npm run lint         # static check only (no-undef — the only thing that catches a missing import)
npm run build        # esbuild builds the client bundle (lib/client.js)
npm run watch        # rebuild on change

# Code changes do NOT take effect until the plugin is reinstalled: dsh COPIES it
# into ~/.dsh/profiles/web/node_modules/dsh-fschannel, so editing repo files alone
# does nothing. pnpm also keys its file: store entry on (path, version), so a lone
# `add` reuses the stale entry — remove + add is required.
# scripts/restart-dsh.ps1 chains all of this and compares lib/*.js hashes before
# launching, failing instead of logging UP. By hand it is:
#   npm run build
#   dsh plugin --profile web remove dsh-fschannel
#   dsh plugin --profile web add file:<plugin-repo-path>

# Individual suites (npm test runs them all):
node scripts/smoke-test.mjs     # server-side smoke (env/bindings/persistence)
node scripts/smoke-env-example.mjs      # example.env must not carry credentials
node scripts/smoke-locales.mjs  # zh/en dictionary key and placeholder parity
node scripts/smoke-client.mjs   # client bundle smoke
node scripts/smoke-settings-render.mjs  # settings-page render smoke (bindings table + layout)
node scripts/smoke-cards.mjs    # model card & trigger tests
node scripts/smoke-render.mjs   # markdown segmentation and result-card rendering
node scripts/smoke-stream.mjs   # streaming card buffering and failure fallback
node scripts/smoke-images.mjs   # image validation, staging and note composition
node scripts/smoke-repair.mjs   # session-log repair (feishu/image ignorable + seq conflicts)

# Need a real environment; excluded from npm test:
node scripts/audit-sessions.mjs # audit all session logs for seq continuity (needs a real $DSH_HOME)
node scripts/integration-test.mjs  # integration test (real Feishu connection + mock apiProxy)
```

---

## Structure

- `lib/index.js` — host plugin: transport, inbound/outbound bridge, command channel, card actions, /feishu HTTP API
- `lib/cards.js` — model/reasoning settings button card (build, triggers, action parsing)
- `lib/stream.js` — streaming cards (buffering + failure fallback)
- `lib/bindings.js` — binding store (atomic JSON writes, per-session model route)
- `lib/env.js` — .env parsing (path config) + layered credential resolution (credential service > envFile)
- `lib/images.js` — image type table, validation, hold buffer and note composition
- `lib/render.js` — markdown segmentation and final result-card rendering
- `lib/repair.js` — historical session-log repair (zstd frame decoding, foreign events, seq conflicts)
- `lib/locales.js` — Feishu-facing copy (zh/en, follows the host locale)
- `src/client/index.jsx` → `lib/client.js` — browser side: session-header chip + settings page

---

## Known limitations

- One streaming card per turn; card failures fall back to plain messages
- Bindings are read once at startup; config changes need a restart
- Images enter the model as recognition description text (raw bytes never enter the model)
- Feishu messages arriving while the harness is down are not replayed (no transport cursor)

---

## License

MIT License (see [LICENSE](LICENSE) in the repo root):

```text
Copyright (c) 2026 CersHuang
```

Any modification or derivative work (including code and documentation) must retain the above copyright and license notices.

---

## Appendix: creating and configuring the Feishu app (reference flow)

> The flow below walks through the full self-built app configuration, including two known pitfalls (personal accounts cannot create apps; configuring the long connection before publishing fails). The console UI may vary slightly between versions.

### Step 0: confirm the account can create a self-built app
1. Open https://open.feishu.cn/ in a browser and sign in with your Feishu account
2. Go to the developer console and click "**create an enterprise self-built app**"
3. If blocked (personal plan not supported / no enterprise): in the Feishu client → avatar → settings → "**upgrade to a team**", create a free team with only yourself, then redo step 1

### Step 1: create the app and grab credentials
1. Create an enterprise self-built app with any name (e.g. dsh-bot) and an avatar
2. Left sidebar "**Credentials & Basic Info**" → note the **App ID** (`cli_` prefix) and **App Secret** (hidden initially; click "reset" or "view" to get the full value)
3. Save them on the settings page: start `dsh web`, open Settings → "飞书机器人" → "连接凭据", fill in App ID and App Secret (saved to the DSH credential store; appId shown masked, secret never echoed).
   > Historically they lived in `.env` (`FEISHU_APP_ID=...` / `FEISHU_APP_SECRET=...`); since v0.1.5.1 `.env` no longer carries credentials — always use the settings page/credential store.

### Step 2: grant permissions
Left sidebar "**Permission Management**" → search and enable these 6 scopes:

| Scope | Purpose |
|---|---|
| `im:message` | Receive direct messages sent to the bot |
| `im:message:send_as_bot` | Send messages as the app (replies, cards) |
| `im:message.group_at_msg:readonly` | Receive group messages that @ the bot |
| `im:chat` | Fetch chat info (chat name shown after binding) |
| `im:chat.members:bot_access` | Fetch chat members (single-member-group @ exemption, chat name after binding) |
| `cardkit:card:write` | Send/update interactive cards (streaming cards, model settings card) |

### Step 2.5: restrict availability (security boundary, required)
Left sidebar "**Version Management & Release**" → when creating a version, under "**availability**" **select only your own member** — never "all members". This is the only barrier preventing others from taking control of your sessions.

### Step 3: enable the bot capability
Left sidebar "**App Capabilities**" → add the "**bot**" capability. Without this, direct messages never trigger any event.

### Step 4: publish the app (must be done BEFORE configuring the long connection)
1. Left sidebar "**Version Management & Release**" → "create version" → fill in version number and update notes → "apply for release"
2. Since you're the team admin, approve it yourself in the admin console

> ⚠️ Known pitfall: **without a published version, saving the long-connection config on the event subscription page errors with "the app has no long connection established"**. Publish first, then configure the long connection.

### Step 5: configure event subscription (long connection)
Left sidebar "**Events & Callbacks**":

1. "**Event config**" → subscription mode "**receive events via long connection**" — this plugin uses the long connection, **no public callback URL needed**
2. Note the **Encrypt Key** and **Verification Token** (usually unused with the long connection, keep them as backup)
3. "Add event" → enable **`im.message.receive_v1`** (message receipt)
4. "**Callback config**" → add **`card.action.trigger`** (card button callbacks; the model settings card clicks depend on it)
5. Save

> If saving the long-connection config errors, the local bridge is usually not up yet: start `dsh web` first (this plugin opens the long connection with dsh web), then save again.

### Verification
1. After the release takes effect, **search the app name** in Feishu and message the bot directly; or **add the bot to a group** (@ it in the group)
2. Send the bot a message: an unbound chat gets the guidance hint → event subscription and permissions work
3. Return to this plugin's flow and bind a session to send and receive

### FAQ
- **Not receiving messages**: check whether the permissions (step 2) shipped with the version, whether the subscription mode is "long connection", and whether `im.message.receive_v1` is subscribed.
- **Cannot send messages**: confirm `im:message:send_as_bot` is enabled and the version is published.
- **No response in groups**: you must @ the bot (`requireMention` is on by default) and enable `im:message.group_at_msg:readonly`.
- **Cards not shown / clicks do nothing**: confirm `cardkit:card:write` is enabled and the `card.action.trigger` callback is configured.
- **Saving the long connection reports "the app has no long connection established"**: finish step 4 (publish the app) first, then configure it.
- **Blocked when creating the app**: follow step 0 and upgrade the personal account to a team.
- **Connection failed**: check that the App Secret was copied completely (avoid stray spaces/newlines).
