// @ts-check
/**
 * Server-side UI copy for Feishu-facing messages. The client reports the
 * host's active locale (POST /feishu/config { locale }); the transport layer
 * picks the matching dictionary here. The default is zh — the plugin's
 * historical language — and any missing en key falls back to zh.
 * @module dsh-fschannel/locales
 */

/**
 * Chinese copy (default), and the source of the dictionary type — every other
 * dictionary is checked against these keys. Placeholders use {name} syntax.
 */
export const zh = {
  // unbound chat guidance
  hintUnbound: '这个聊天还没有绑定 DSH 会话。\n请在 DSH Web 新建会话并点击「连接飞书」（或在设置里打开「新会话默认连接飞书」），然后回到这里发一条消息完成绑定。',
  // command help
  helpTitle: '可用命令：',
  helpModel: '/model — 查看当前模型与 reasoning effort',
  helpModelList: '/model list — 列出可用模型目录',
  helpModelUse: '/model use <provider>/<model> — 切换模型（从下一条消息生效）',
  helpModelEffort: '/model effort <off|high|max> — 切换思考强度',
  helpStatus: '/status — 会话与机器人状态',
  helpStop: '/stop — 停止当前回合',
  helpHelp: '/help — 本清单',
  // model commands
  modelDirectoryTitle: '模型目录：',
  modelEffortList: '（effort: {efforts}）',
  modelUnavailable: '无法读取模型目录（会话不可用）',
  modelUseUsage: '用法：/model use <provider>/<model>（或仅 <model>，沿用当前提供方）',
  modelUnknownProvider: '无法确定提供方，请用完整路径：/model use <provider>/<model>',
  modelEffortUsage: '用法：/model effort <{efforts}>\n当前 effort：{current}',
  modelCurrent: '当前模型：{provider}/{model}\nreasoning effort：{effort}\n\n/model list 查看目录 · /model use <provider>/<model> 切换 · /model effort <off|high|max> 调整强度',
  modelSwitched: '已切换：{provider}/{model}（effort {effort}）\n下一条消息起生效。',
  modelServiceUnavailable: '模型服务不可用',
  modelSwitchFailed: '切换失败：{message}',
  modelSwitchUnknownError: '未知错误',
  effortDefault: '默认',
  // session / inbound
  sessionUnavailable: '会话不可用，请检查该会话是否仍存在。',
  queueAck: '已收到，前面还有 {n} 条消息在排队，处理完会依次回复。',
  ackInbound: '收到，处理中…',
  stopped: '已停止当前回合。',
  notRunning: '当前没有运行中的回合。',
  unknownCommand: '未知命令「{command}」。\n\n{help}',
  boundTo: '已绑定到 DSH 会话（{session}…）。之后在这里发的消息都会进入该会话，回复也会发到这里。\n\n{help}',
  // images
  botNotConnected: '机器人未连接',
  imageDownloadFailed: '图片下载失败',
  imageTooMany: '图片数量超过上限（{max}），后续图片已忽略',
  imageHeld: '已收到 {n} 张图片，发送文字说明后将一起识别处理。',
  imageNoWorkspace: '无法确定会话工作目录，图片未暂存',
  imageNoteTitle: '—— 飞书图片附件 ——',
  imageNoteIntro: '用户通过飞书发送了 {n} 张图片，已保存为：',
  imageNoteInstruction: '请先通过 skill 工具加载 vision-tools 技能（若尚未加载），然后使用视觉识别工具（如 vision_glance、vision_ocr 等）逐一查看这些图片文件；\n结合识别结果与上面的文字信息，给出完整回答。若视觉工具不可用，请明确说明你无法查看图片。',
  // status command
  statusTitle: '状态',
  statusBot: '机器人：{state}',
  statusBotConnected: '已连接',
  statusBotDisconnected: '未连接',
  statusSession: '会话：{session}{chat}',
  statusModel: '模型：{model}',
  statusModelUnknown: '模型：未知（会话不可用）',
  // streaming / turn copy
  toolCalling: '正在调用工具：{name}…',
  toolCallingUnknown: '正在调用工具…',
  taskFailed: '**任务失败**{detail}',
  noOutput: '（本轮没有产生输出）',
  // card action toasts
  cardUnbound: '该会话已解除绑定，设置已失效',
  cardSwitched: '已切换：{model}（effort {effort}）',
  cardFailed: '设置失败，请稍后再试',
  // settings card (cards.js)
  cardTitle: '模型与推理设置',
  cardCurrent: '**当前**：`{model}` · effort `{effort}`',
  cardHint: '点击按钮立即生效，下一条消息起使用。',
  // streaming placeholder, shown until the first real content arrives
  streamPlaceholder: '正在处理…',
  // punctuation-bearing fragments: these wrap other values, so the brackets
  // and separators belong to the language and cannot be hard-coded at the
  // call site (full-width forms would leak into English output).
  groupLabel: '{name}（{id}）',
  effortSuffix: '（effort {effort}）',
  chatSuffix: '（{chat}）',
  noteWrap: '（{notes}）',
  noteSeparator: '；',
  detailSuffix: '：{detail}',
  // send_feishu_image tool
  sendImageNoSession: '无法确定当前会话，图片未发送',
  sendImageUnbound: '当前会话未绑定飞书聊天，图片未发送',
  sendImageNoPath: '请提供图片文件路径',
  sendImageOutsideWorkspace: '图片路径必须在会话工作区内',
  sendImageInvalidType: '不支持的图片类型（仅支持 PNG/JPEG/WebP/GIF）',
  sendImageNotFound: '图片文件不存在或为空',
  sendImageSent: '图片已发送到飞书聊天',
  sendImageFailed: '图片发送失败，请稍后重试',
}

/**
 * The dictionary shape, derived from {@link zh} rather than declared as a bare
 * `{ [key: string]: string }`.
 *
 * What this buys: `en` below is checked key-for-key against zh, so adding a zh
 * key and forgetting the translation is a compile error rather than something
 * smoke-locales.mjs catches later. It also satisfies parameters that name the
 * keys they need — composeImageNote asks for three specific ones, which a bare
 * index signature does not structurally satisfy.
 *
 * What it does NOT buy: typo detection at call sites. TypeScript treats object
 * literals declared in .js files as open for property access (JS code adds
 * properties dynamically), so `dict.cardTitel` still typechecks. Verified, not
 * assumed — an explicitly annotated object type does flag it, an inferred one
 * in a .js file does not.
 * @typedef {typeof zh} LocaleDict
 */

/**
 * English copy. Keys mirror {@link zh}; any key missing here falls back to zh.
 * @type {LocaleDict}
 */
export const en = {
  hintUnbound: 'This chat is not bound to a DSH session yet.\nCreate a session in DSH Web and click "Connect Feishu" (or enable "Auto-connect new sessions to Feishu" in settings), then send a message here to finish binding.',
  helpTitle: 'Available commands:',
  helpModel: '/model — show current model & reasoning effort',
  helpModelList: '/model list — list the model directory',
  helpModelUse: '/model use <provider>/<model> — switch model (applies from the next message)',
  helpModelEffort: '/model effort <off|high|max> — switch reasoning effort',
  helpStatus: '/status — session & bot status',
  helpStop: '/stop — stop the current turn',
  helpHelp: '/help — this list',
  modelDirectoryTitle: 'Model directory:',
  modelEffortList: ' (effort: {efforts})',
  modelUnavailable: 'Cannot read the model directory (session unavailable)',
  modelUseUsage: 'Usage: /model use <provider>/<model> (or just <model>, keeping the current provider)',
  modelUnknownProvider: 'Cannot determine the provider; use the full path: /model use <provider>/<model>',
  modelEffortUsage: 'Usage: /model effort <{efforts}>\nCurrent effort: {current}',
  modelCurrent: 'Current model: {provider}/{model}\nreasoning effort: {effort}\n\n/model list to browse · /model use <provider>/<model> to switch · /model effort <off|high|max> to adjust',
  modelSwitched: 'Switched to: {provider}/{model} (effort {effort})\nApplies from the next message.',
  modelServiceUnavailable: 'Model service unavailable',
  modelSwitchFailed: 'Switch failed: {message}',
  modelSwitchUnknownError: 'unknown error',
  effortDefault: 'default',
  sessionUnavailable: 'Session unavailable — check that the session still exists.',
  queueAck: 'Received; {n} message(s) ahead in the queue, replies will follow in order.',
  ackInbound: 'Received, processing…',
  stopped: 'Current turn stopped.',
  notRunning: 'No turn is currently running.',
  unknownCommand: 'Unknown command "{command}".\n\n{help}',
  boundTo: 'Bound to DSH session ({session}…). Messages sent here will go into that session, and replies come back here.\n\n{help}',
  botNotConnected: 'Bot not connected',
  imageDownloadFailed: 'Image download failed',
  imageTooMany: 'Image count exceeds the limit ({max}); further images were ignored',
  imageHeld: 'Received {n} image(s); send a text description and they will be recognized together.',
  imageNoWorkspace: 'Cannot determine the session workspace; image not staged',
  imageNoteTitle: '—— Feishu image attachment ——',
  imageNoteIntro: 'The user sent {n} image(s) via Feishu, saved as:',
  imageNoteInstruction: 'First load the vision-tools skill via the skill tool (if not loaded yet), then use the vision recognition tools (e.g. vision_glance, vision_ocr) to look at these image files one by one;\ncombine the recognition results with the text above and give a complete answer. If the vision tools are unavailable, state clearly that you cannot view the images.',
  statusTitle: 'Status',
  statusBot: 'Bot: {state}',
  statusBotConnected: 'connected',
  statusBotDisconnected: 'disconnected',
  statusSession: 'Session: {session}{chat}',
  statusModel: 'Model: {model}',
  statusModelUnknown: 'Model: unknown (session unavailable)',
  toolCalling: 'Calling tool: {name}…',
  toolCallingUnknown: 'Calling tool…',
  taskFailed: '**Task failed**{detail}',
  noOutput: '(no output this turn)',
  cardUnbound: 'This session has been unbound; the setting is no longer valid',
  cardSwitched: 'Switched to: {model} (effort {effort})',
  cardFailed: 'Setting failed; please try again later',
  cardTitle: 'Model & reasoning settings',
  cardCurrent: '**Current**: `{model}` · effort `{effort}`',
  cardHint: 'A click applies immediately and takes effect from the next message.',
  streamPlaceholder: 'Working…',
  groupLabel: '{name} ({id})',
  effortSuffix: ' (effort {effort})',
  chatSuffix: ' ({chat})',
  noteWrap: '({notes})',
  noteSeparator: '; ',
  detailSuffix: ': {detail}',
  sendImageNoSession: 'Cannot determine the current session; the image was not sent',
  sendImageUnbound: 'The current session is not bound to a Feishu chat; the image was not sent',
  sendImageNoPath: 'Provide the image file path',
  sendImageOutsideWorkspace: 'The image path must stay inside the session workspace',
  sendImageInvalidType: 'Unsupported image type (PNG/JPEG/WebP/GIF only)',
  sendImageNotFound: 'Image file does not exist or is empty',
  sendImageSent: 'Image sent to the Feishu chat',
  sendImageFailed: 'Image send failed; please try again later',
}

/**
 * The en dictionary layered over zh, so a key that exists in zh but not in en
 * resolves to the zh copy instead of `undefined` — `fill(undefined, …)` would
 * throw a TypeError inside a message handler. Built once at module load.
 * @type {LocaleDict}
 */
const enWithFallback = { ...zh, ...en }

/**
 * Resolve the dictionary for a stored locale id, falling back to zh.
 * @param {string | undefined} locale - 'zh' | 'en' (anything else -> zh).
 * @returns {LocaleDict}
 */
export function dictFor(locale) {
  return locale === 'en' ? enWithFallback : zh
}
