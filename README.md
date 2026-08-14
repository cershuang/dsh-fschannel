# dsh-fschannel

让 DeepSeek Harness Web 会话连接到飞书机器人：**新建会话时选择「连接飞书」**，之后在飞书里给机器人发消息，消息进入该 DSH 会话由 Agent 处理，回复自动发回飞书聊天。Web 与飞书可同时驱动同一个会话。

传输层使用飞书官方 [@larksuite/channel](https://github.com/larksuite/channel-sdk-node) SDK —— **WebSocket 长连接，无需公网回调地址**。

---

## 功能

### 会话 ↔ 飞书聊天桥接
- 一对一绑定（一个会话对应一个聊天，双向替换），绑定持久化在 `$DSH_HOME/feishu-bindings.json`
- **待绑定机制**：会话进入待绑定状态后，你在飞书里给机器人发的**下一条消息**所在聊天即完成绑定（FIFO）
- 会话 Agent 不在线时自动 `resume` 恢复；重启后绑定关系保留

### 消息收发
- **流式卡片**（默认 `output: 'stream'`）：**回合开始即开卡**（先显示「正在处理…」），回复以打字机卡片逐字呈现；工具调用显示「正在调用工具：{name}」引用行；**回合结束时卡片保留最终结果**，并自动排版为结构化卡片（段落/表格/代码块按 markdown 渲染，无输出或失败也留在卡片内）；无卡片权限时自动回退普通消息
- `output: 'plain'` 可切换为「每步一条 markdown 消息」
- **队列处理**：SDK 级去重（30s）+ 按聊天串行投递；Agent 忙碌时回复「前面还有 N 条消息在排队」
- **表情反馈**：收到消息时在消息上自动加 👍，该回合完成变 ✅、失败变 ☹️（可配置 emoji 与开关；仅在你自己的消息上生效，Web 触发的回合不会误换）
- 群聊默认仅响应 @ 机器人（`requireMention`）；未绑定聊天收到引导提示（可关）

### 飞书侧模型控制
- 提到「调整/切换/查看 模型/effort」时自动弹出**按钮卡片**，展示当前模型与推理等级，可一键切换
- `/model` — 弹出同一张卡片（查询当前模型与 effort）
- `/model list` — 模型目录（含各模型支持的 effort 级别）
- `/model use <provider>/<model>` — 切换模型（下一条消息起生效）
- `/model effort <off|high|max>` — 切换思考强度
- `/status` — 会话与机器人状态；`/stop` — 停止当前回合；`/help` — 命令清单
- 切换走宿主 `apiProxy`（与 Web UI 同一通道），**会话级持久**：重启后自动重放

### 连接飞书（创建新会话时）
- 会话头 chip：未连接 →「连接飞书」；待绑定 → 提示「给机器人发一条消息完成绑定」；已连接 → 显示聊天名（点击断开）
- 设置 → 常规 → 飞书机器人：**「新会话默认连接飞书」**开关（每个新会话自动待绑定）+ **「新建会话并连接飞书」**一键按钮

---

## 安装方式

前置：Node 22+，已安装 `dsh` CLI 与 `pnpm`（`npm i -g @deepseek-ai/dsh pnpm`）。

```sh
# 1. 准备凭据（见附录「飞书机器人申请与配置」）
cp example.env .env      # 然后填入真实的 FEISHU_APP_ID / FEISHU_APP_SECRET

# 2. 构建客户端（每次修改源码后执行）
npm install && npm run build

# 3. 安装进 web profile（file: 协议会把包复制进 pnpm store 并安装其依赖；
#    <插件仓库路径> 也可写在 .env 的 FSCHANNEL_REPO 中）
dsh plugin --profile web add file:<插件仓库路径>

# 4. 重启 dsh web 生效
dsh web
```

> 首次安装时 pnpm 可能因构建脚本策略报 `ERR_PNPM_IGNORED_BUILDS`（protobufjs），
> 已在 profile 的 `pnpm-workspace.yaml` 中配置 `allowBuilds: { protobufjs: false }`。

---

## 配置

注册行 `feishu-bot`（来自包内 `cordis.patch.yml`，作为 bundle 层自动叠加）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `envFile` | `<cwd>/.env` | 凭据文件（标准 KEY=VALUE 格式；兼容旧 `appid/secrect` 空格格式） |
| `appId` / `appSecret` | 读 envFile | 直接覆盖 |
| `requireMention` | `true` | 群聊仅响应 @ 机器人 |
| `output` | `stream` | `stream`=流式打字机卡片（失败回退普通消息）；`plain`=每步一条消息 |
| `modelCardTriggers` | `true` | 提到模型/effort 时自动弹出按钮卡片 |
| `queueAck` | `true` | Agent 忙碌时回复排队位置提示 |
| `ackInbound` | `false` | 空闲时也回复「收到，处理中…」 |
| `reactInbound` | `true` | 收到消息时加表情反馈（👍→✅/☹️） |
| `reactReceived` / `reactDone` / `reactError` | `THUMBSUP` / `DONE` / `SAD` | 各阶段表情（飞书标准 emoji_type，可自定义） |
| `hintUnbound` | `true` | 未绑定聊天回复引导提示 |
| `hintText` | 内置 | 自定义引导文案 |
| `bindingsFile` | `$DSH_HOME/feishu-bindings.json` | 绑定持久化路径 |

凭据解析优先级：插件配置 `appId/appSecret` > `envFile` 内的 FEISHU_APP_ID / FEISHU_APP_SECRET > appid/secrect > APP_ID/APP_SECRET > LARK_APP_ID/LARK_APP_SECRET。示例见 `example.env`。

**路径配置（放 `.env`，不入库）**：`FSCHANNEL_REPO`（插件仓库根目录，脚本/重启用）、`FSCHANNEL_ENV_FILE`（.env 自身路径，默认取工作目录）、`FSCHANNEL_BINDINGS_FILE`（绑定数据文件，默认 `$DSH_HOME/feishu-bindings.json`）。`cordis.patch.yml` 的 `envFile` 解析顺序：`FSCHANNEL_ENV_FILE` 环境变量（由 `scripts/restart-web.ps1` 从 .env 导出）→ `<cwd>/.env`。

---

## 使用方式

### 绑定一个会话到飞书

1. 在 Web 界面新建会话（或打开已有会话）
2. 点击会话标题旁的「连接飞书」（待绑定状态），或：
   - 设置 → 常规 → 飞书机器人：打开「新会话默认连接飞书」→ 之后每个新会话自动待绑定
   - 设置 → 常规 → 飞书机器人：「新建会话并连接飞书」一键新建并待绑定
3. 在飞书里私聊机器人 / 群里 @ 机器人发一条消息 → 该聊天即绑定此会话
4. 聊天消息进入会话处理：回复流式呈现，Web 与飞书互通；会话头 chip 显示已连接（点击断开）

### 飞书侧命令与卡片

| 输入 | 效果 |
|---|---|
| 「调整模型」「切换模型」「把 effort 调一下」等 | 弹出**按钮卡片**（模型 Pro/Flash + effort off/high/max 一键切换） |
| `/model` | 弹出同一张卡片 |
| `/model list` | 列出模型目录 |
| `/model use <provider>/<model>` | 切换模型 |
| `/model effort <off\|high\|max>` | 切换推理等级 |
| `/status` | 会话与机器人状态 |
| `/stop` | 停止当前回合 |
| `/help` | 命令清单 |

---

## 注意事项

- **文件修改与重启**：插件源码在插件仓库（本机路径见 `.env` 的 `FSCHANNEL_REPO`），改代码后需 `npm run build`（改了客户端时）→ `dsh plugin --profile web add file:<插件仓库路径>`（重新复制进 store）→ 重启 `dsh web` 才生效。
- **配置启动时读取一次**：改 `cordis.patch.yml` 里的配置需重启生效。
- **凭据安全**：`.env` 含密钥，已加入 `.gitignore`，不要提交；`example.env` 可安全提交。
- **HTTP API 仅本机回环**：`/feishu/*` 只接受 127.0.0.1 访问（与 Web 同源）。
- **流式卡片依赖卡片能力**：若飞书侧无卡片权限，SDK 自动回退普通消息；`output: 'plain'` 可整体关闭。
- **图片/文件不转发**：文本之外的内容归一化为文本提示；流式卡片只含文本与工具活动行。
- **多步回合**：一个回合（含多次工具调用）在同一张流式卡片内叠加。
- **一聊天一会话**：重复绑定会替换旧绑定（旧会话自动解绑）。
- **未绑定聊天**：默认回引导提示语，不自动创建会话。
- **触发词匹配**：模型卡片仅对「调整/切换/查看 模型|effort」等意图短语触发，正文里偶尔出现「模型」二字不会误触发。
- **表情反馈权限**：消息表情依赖 `im:message` 权限（与收消息同一权限）；表情操作失败仅记日志，不影响收发。
- **最终卡片排版**：回合结束时用结构化卡片替换流式卡（表格用卡片 v2 table 组件渲染）；若平台拒绝结构化卡片，自动降级为纯 markdown 卡片，最终结果始终可见。

### 与 dsh 升级的关系（更新免疫）

| 层 | 位置 | dsh 升级后 |
|---|---|---|
| 插件本体 | 插件仓库（git 仓库，路径见 `.env` 的 `FSCHANNEL_REPO`） | 保留 |
| 注册行 | 包内 `cordis.patch.yml`（bundle 层，`dsh plugin` 自动 reconcile） | 保留 |
| 绑定数据 | `$DSH_HOME/feishu-bindings.json` | 保留 |

无任何对 dsh 包内部文件的修改，升级后无需重打补丁。

---

## 开发

```sh
npm run build        # esbuild 构建客户端 bundle (lib/client.js)
npm run watch        # 监听重建
node scripts/smoke-test.mjs     # 服务端冒烟（env/绑定/持久化）
node scripts/smoke-client.mjs   # 客户端 bundle 冒烟
node scripts/smoke-cards.mjs    # 模型卡片与触发词测试
node scripts/integration-test.mjs  # 集成测试（真实连接飞书 + mock apiProxy）
```

---

## 结构

- `lib/index.js` — 宿主插件：传输、入向/出向桥接、命令通道、卡片动作、/feishu HTTP API
- `lib/cards.js` — 模型/推理设置按钮卡片（构建、触发词、动作解析）
- `lib/stream.js` — 流式卡片（缓冲 + 失败回退）
- `lib/bindings.js` — 绑定存储（JSON 原子写，含会话级模型路由）
- `lib/env.js` — .env 解析（标准 KEY=VALUE，兼容旧拼写）
- `src/client/index.jsx` → `lib/client.js` — 浏览器端：会话头 chip + 设置行

---

## 已知限制

- 流式卡片为整回合一张卡；卡片失败自动回退普通消息
- 绑定在启动时读取一次；改配置需重启
- 图片/文件不入模型（仅文本）
- 停机期间到达的飞书消息不会重放（传输层无 cursor）

---

## 许可证

本项目基于 **MIT License** 发布（见仓库根目录 [LICENSE](LICENSE)）：

```text
Copyright (c) 2026 CersHuang
```

允许任何修改、使用、复制、合并、发布与商用（包括闭源衍生），**唯一要求**：任何修改或衍生作品（含代码与文档）必须**保留上述版权声明与本许可声明**（开发者信息）。

---

## 附录：飞书机器人申请与配置（参考流程）

> 以下流程参照飞书自建应用的完整配置路径，含两个已知的坑（个人版建不了应用、未发布就配长连接会报错）。控制台界面可能随版本微调。

### 步骤 0：确认账号能建自建应用
1. 浏览器打开 https://open.feishu.cn/ ，用你的飞书账号登录
2. 进入「开发者后台」，点「**创建企业自建应用**」
3. 如果被拦住（提示个人版不支持 / 没有企业）：回到飞书客户端 → 头像 → 设置 →「**升级为团队**」，免费创建一个只有你自己的团队，然后重来第 1 步

### 步骤 1：创建应用并拿凭证
1. 创建企业自建应用，名字随便（如 dsh-bot），传个头像
2. 左侧「**凭证与基础信息**」→ 记下 **App ID**（`cli_` 开头）和 **App Secret**（Secret 首次不可见，点「重置」或「查看」获取完整值）
3. 填入 `.env`：
   ```
   FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxxxxxx
   FEISHU_APP_SECRET=your_app_secret_here
   ```

### 步骤 2：开通权限
左侧「**权限管理**」→ 逐个搜索并开通以下 6 个权限：

| 权限标识 | 用途 |
|---|---|
| `im:message` | 接收用户发给机器人的单聊消息 |
| `im:message:send_as_bot` | 以应用身份发消息（回复、卡片） |
| `im:message.group_at_msg:readonly` | 接收群组中 @ 机器人的消息 |
| `im:chat` | 获取群信息（绑定后显示群名） |
| `im:chat.members:bot_access` | 机器人获取群成员信息 |
| `cardkit:card:write` | 发送/更新交互卡片（流式卡片、模型设置卡片） |

### 步骤 2.5：限定可用范围（安全边界，必做）
左侧「**版本管理与发布**」→ 创建版本时的「**可用范围**」→ **只勾选你自己这一个成员**，不要选「全部成员」。这是防止别人拿到你会话控制权的唯一屏障。

### 步骤 3：开启机器人能力
左侧「**应用能力**」→ 添加「**机器人**」能力。没有这一步，私聊发消息不会触发任何事件。

### 步骤 4：发布应用（必须在配置长连接之前做）
1. 左侧「**版本管理与发布**」→「创建版本」→ 填写版本号与更新说明 →「申请发布」
2. 因为你是这个团队的管理员，去管理后台自己审批通过

> ⚠️ 已知的坑：**没有已发布版本时，事件订阅页保存长连接配置会报「应用未建立长连接」**。先发布，再配长连接。

### 步骤 5：配置事件订阅（长连接）
左侧「**事件与回调**」：

1. 「**事件配置**」→ 订阅方式选「**使用长连接接收事件**」—— 本插件用长连接，**不需要**公网回调地址
2. 记下 **Encrypt Key** 和 **Verification Token**（长连接方式一般用不到，先记下备用）
3. 「添加事件」→ 勾选 **`im.message.receive_v1`**（接收消息）
4. 「**回调配置**」→ 添加 **`card.action.trigger`**（卡片按钮回调，模型设置卡片点击依赖它）
5. 保存

> 保存长连接配置时若报错，通常是本地桥接还没起来：先把 dsh web 跑起来（本插件随 dsh web 启动长连接），再回来保存。

### 验证
1. 发布生效后，在飞书里**搜索应用名**，私聊机器人；或把机器人**拉进群**（群里 @ 机器人）
2. 给机器人发一条消息：未绑定聊天会回引导提示 → 说明事件订阅与权限已通
3. 回到本插件的流程绑定会话，即可收发消息

### 常见问题
- **收不到消息**：检查权限（步骤 2）是否已随版本发布、事件订阅方式是否选的「长连接」、是否订阅了 `im.message.receive_v1`。
- **发不出消息**：确认已开通 `im:message:send_as_bot` 且版本已发布。
- **群里不响应**：需 @ 机器人（`requireMention` 默认开启），并开通 `im:message.group_at_msg:readonly`。
- **卡片不显示 / 点击没反应**：确认已开通 `cardkit:card:write` 并配置了 `card.action.trigger` 回调。
- **保存长连接配置报「应用未建立长连接」**：先完成步骤 4（发布应用），再回来配置。
- **创建应用被拦住**：按步骤 0 把个人账号升级为团队。
- **连接失败**：核对 App Secret 是否完整复制（避免多余空格/换行）。
