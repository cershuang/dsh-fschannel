// @ts-check
/**
 * dsh-fschannel — host half.
 *
 * A Feishu/Lark bot bridge for DeepSeek Harness. Sessions created in the Web
 * GUI can be connected to the bot (session header, or automatically for new
 * sessions): messages sent to the bot in the bound chat are delivered into
 * that session via `agent.followup()`, and replies return to the chat.
 *
 * Capabilities:
 *   - streaming typewriter cards (`output: 'stream'`, default) with plain
 *     markdown fallback; `output: 'plain'` sends one message per step
 *   - queue processing: SDK dedup + per-chat serialization, plus queue
 *     position acknowledgements while the agent is busy
 *   - slash commands from Feishu: /model (query), /model use <provider/model>,
 *     /model effort <level>, /model list, /status, /stop, /help — model
 *     switches go through the host apiProxy (the same path the Web UI uses)
 *     and persist per session (replayed when its agent is re-acquired)
 *   - bindings persist in a JSON document next to the harness home
 *
 * HTTP API (loopback-only, same origin as the Web GUI):
 *   GET  /feishu/status   — bot connection + bindings + pending + settings
 *   POST /feishu/bind     — { sessionId, chatId? } bind (or queue pending)
 *   POST /feishu/unbind   — { sessionId }
 *   GET  /feishu/config   — settings + credential status (masked only)
 *   POST /feishu/config   — { appId?, appSecret?, output?, showImages?,
 *                            holdTtlSeconds?, maxHeldImages?, maxHeldImageBytes?,
 *                            autoBindNewSession? }
 *   GET  /feishu/image/<sessionId>/<name> — staged Feishu image bytes
 * @module dsh-fschannel
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { createLarkChannel } from '@larksuite/channel'
import { maskSecret, readEnvMap, resolveCredentials } from './env.js'
import { BindingStore } from './bindings.js'
import { StreamHandle } from './stream.js'
import { buildModelCard, isBareKeyword, MODEL_CARD_ACTION, MODEL_CARD_INTENT, parseActionValue } from './cards.js'
import { renderFinalCard, renderPlainCard } from './render.js'
import { composeImageNote, extFor, HeldImageBuffer, textWithoutImageMarkup, validateImage } from './images.js'
import { collectForeignEvents, repairSessionLog } from './repair.js'

/** Cordis plugin name; keep stable after publishing. */
export const name = 'feishu-bot'

/** Services that must exist before the plugin is applied. */
export const inject = ['agents', 'webServer', 'apiProxy', 'credentials']

/**
 * The plugin configuration from the loader entry.
 * @typedef {{ envFile?: string, appId?: string, appSecret?: string,
 *   requireMention?: boolean, ackInbound?: boolean, queueAck?: boolean,
 *   hintUnbound?: boolean, hintText?: string, bindingsFile?: string,
 *   output?: 'stream' | 'plain', showImages?: boolean, modelCardTriggers?: boolean,
 *   holdImages?: boolean, holdHint?: boolean, maxHeldImages?: number,
 *   maxHeldImageBytes?: number, holdTtlMs?: number, imageDir?: string }} FeishuConfig
 */

/** @typedef {{ id: string, status: string, inbox: { nextTurn: unknown[], nextStep: unknown[] }, followup(message: object): void, cancel(cause: string): void }} HostAgent */

/** @typedef {{ sessionId: string, chatId: string, chatName?: string, boundAt: number, lastInboundMessageId?: string, modelRoute?: { provider: string, model: string, reasoningEffort?: string } }} BindingRecord */

/** @typedef {{ messageId: string, chatId: string, chatType: string, senderId: string, senderIsBot?: boolean, mentionedBot: boolean, content: string }} InboundMessage */

/**
 * Extract the plain-text content of an assistant message.
 * @param {{ content?: Array<{ type?: string, text?: string }> }} message
 * @returns {string} joined text blocks.
 */
function extractText(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * The default hint sent to chats that have no bound session.
 * @returns {string}
 */
function defaultHint() {
  return '这个聊天还没有绑定 DSH 会话。\n请在 DSH Web 新建会话并点击「连接飞书」（或在设置里打开「新会话默认连接飞书」），然后回到这里发一条消息完成绑定。'
}

/** Help text for the Feishu command channel. */
function helpText() {
  return [
    '可用命令：',
    '/model — 查看当前模型与 reasoning effort',
    '/model list — 列出可用模型目录',
    '/model use <provider>/<model> — 切换模型（从下一条消息生效）',
    '/model effort <off|high|max> — 切换思考强度',
    '/status — 会话与机器人状态',
    '/stop — 停止当前回合',
    '/help — 本清单',
  ].join('\n')
}

/**
 * Apply the plugin to its Cordis context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - agents + webServer + apiProxy ready.
 * @param {FeishuConfig} config - resolved entry configuration.
 */
export function apply(ctx, config) {
  const requireMention = config.requireMention !== false
  const queueAck = config.queueAck !== false
  const ackInbound = config.ackInbound === true
  const hintUnbound = config.hintUnbound !== false
  const modelCardTriggers = config.modelCardTriggers !== false
  const reactInbound = config.reactInbound !== false
  const reactReceived = typeof config.reactReceived === 'string' && config.reactReceived !== '' ? config.reactReceived : 'THUMBSUP'
  const reactDone = typeof config.reactDone === 'string' && config.reactDone !== '' ? config.reactDone : 'DONE'
  const reactError = typeof config.reactError === 'string' && config.reactError !== '' ? config.reactError : 'SAD'
  const holdImages = config.holdImages !== false
  const holdHint = config.holdHint !== false
  const imageDirOverride = typeof config.imageDir === 'string' && config.imageDir !== '' ? config.imageDir : undefined
  const hintText = typeof config.hintText === 'string' && config.hintText !== '' ? config.hintText : defaultHint()
  // Runtime-adjustable settings: entry config provides the base values; the
  // bindings file (settings page) overrides them; POST /feishu/config mutates
  // both the persisted settings and these live values.
  let output = config.output === 'plain' ? 'plain' : 'stream'
  let showImages = config.showImages !== false
  let maxHeldImages = typeof config.maxHeldImages === 'number' && config.maxHeldImages > 0 ? config.maxHeldImages : 10
  let maxHeldImageBytes = typeof config.maxHeldImageBytes === 'number' && config.maxHeldImageBytes > 0 ? config.maxHeldImageBytes : 10 * 1024 * 1024
  let holdTtlMs = typeof config.holdTtlMs === 'number' && config.holdTtlMs >= 0 ? config.holdTtlMs : 0

  const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  // Machine-specific paths are configured in the env file (FSCHANNEL_*)
  // or the process environment; the entry config overrides both.
  const envFile = typeof config.envFile === 'string' && config.envFile !== ''
    ? config.envFile
    : process.env.FSCHANNEL_ENV_FILE !== undefined && process.env.FSCHANNEL_ENV_FILE !== ''
      ? process.env.FSCHANNEL_ENV_FILE
      : join(process.cwd(), '.env')

  /**
   * Effective app credentials (layered: entry config > credential service > env file).
   * @type {{ appId: string, appSecret: string, source: string }}
   */
  let credentials = { appId: '', appSecret: '', source: '' }
  /**
   * Re-resolve credentials through the layered credential service. The store
   * service ranks: shell-exported env (read-only) > dsh credential store > .env.
   * @returns {Promise<{ appId: string, appSecret: string, source: string }>}
   */
  const refreshCredentials = async () => {
    const resolved = await resolveCredentials(envFile, config, async (name) => {
      try {
        return (await ctx.credentials.resolve(name))?.value
      } catch (error) {
        ctx.logger.warn('feishu: credential resolve %s failed: %s', name, error instanceof Error ? error.message : String(error))
        return undefined
      }
    })
    credentials = resolved
    return resolved
  }
  // Bindings file: entry config > env file key > $DSH_HOME default.
  const envMap = readEnvMap(envFile)
  const bindingsFile = typeof config.bindingsFile === 'string' && config.bindingsFile !== ''
    ? config.bindingsFile
    : typeof envMap.fschannel_bindings_file === 'string' && envMap.fschannel_bindings_file !== ''
      ? envMap.fschannel_bindings_file
      : join(dshHome, 'feishu-bindings.json')
  const store = new BindingStore(bindingsFile, (line) => {
    ctx.logger.info(line)
    // The default web profile composes no logger printer; mirror to stderr so
    // binding-store failures are visible in web.stderr.log.
    process.stderr.write(line + '\n')
  })
  // Persisted settings (from the settings page) override the entry config.
  {
    const persisted = store.settings
    if (store.settingsHas('output') && persisted.output === 'plain') output = 'plain'
    if (store.settingsHas('showImages') && persisted.showImages === false) showImages = false
    if (store.settingsHas('holdTtlSeconds')) holdTtlMs = Math.round(persisted.holdTtlSeconds * 1000)
    if (store.settingsHas('maxHeldImages')) maxHeldImages = persisted.maxHeldImages
    if (store.settingsHas('maxHeldImageBytes')) maxHeldImageBytes = Math.round(persisted.maxHeldImageBytes * 1024 * 1024)
  }

  /**
   * Repair historical session logs written by older builds: any `feishu/image`
   * event without the envelope's `ignorable` marker makes the harness refuse
   * the whole log (unknown event type). Only sessions whose agent is NOT live
   * are touched — the persistence backend writes a log only while its session
   * is live, so a non-live artifact is byte-stable and the temp+rename publish
   * cannot race a writer. Also re-indexes staged image files referenced by
   * historical events (older index entries may have been evicted). Runs once
   * after boot has settled (all sessions are cold then) and again on demand
   * via POST /feishu/repair-logs.
   */
  const repairHistoricalLogs = () => {
    const sessionsRoot = join(dshHome, 'sessions')
    const status = store.status()
    const ids = new Set([
      ...status.bindings.map((record) => record.sessionId),
      ...status.pending.map((entry) => entry.sessionId),
    ])
    let repaired = 0
    let failed = 0
    for (const id of ids) {
      if (ctx.agents.get(id) !== undefined) continue // live: history reads from memory, log is being written
      const result = repairSessionLog(sessionsRoot, id)
      if (result.ok) {
        if (result.detail !== 'no log artifact' && result.detail !== 'patched 0 event(s)') {
          ctx.logger.info('feishu: repaired session log %s (%s)', id, result.detail)
          repaired += 1
        }
      } else {
        ctx.logger.warn('feishu: session log repair skipped for %s: %s', id, result.detail)
        failed += 1
      }
      const record = store.getBySession(id)
      if (record !== undefined) reindexHistoricalImages(record, sessionsRoot)
    }
    if (repaired > 0 || failed > 0) {
      ctx.logger.info('feishu: log repair pass finished (%d repaired, %d skipped)', repaired, failed)
    }
  }

  /**
   * Re-index staged image files referenced by historical `feishu/image` events
   * so the gallery and inline event nodes can serve them after a bindings
   * eviction or an upgrade. Missing files are skipped silently.
   * @param {BindingRecord} record
   * @param {string} sessionsRoot - `$DSH_HOME/sessions`.
   */
  const reindexHistoricalImages = (record, sessionsRoot) => {
    const { cwd, events } = collectForeignEvents(sessionsRoot, record.sessionId)
    if (events.length === 0) return
    const dir = imageDirOverride !== undefined
      ? imageDirOverride
      : cwd === undefined ? undefined : join(cwd, '.dsh-fschannel-images')
    if (dir === undefined) return
    for (const event of events) {
      if (store.imagePath(record.sessionId, event.name) !== undefined) continue
      const path = join(dir, event.name)
      if (!existsSync(path)) continue
      const evicted = store.setImage(record.sessionId, event.name, path, {
        mediaType: event.mediaType,
        bytes: event.bytes,
        fileName: event.fileName,
      })
      for (const evictedPath of evicted) {
        try { rmSync(evictedPath, { force: true }) } catch { /* best effort */ }
      }
      ctx.logger.info('feishu: re-indexed historical image %s for %s', event.name, record.sessionId)
    }
  }
  // Deferred until harness boot settles (no bound session is live then, so no
  // backend writer can race the repair's atomic rewrite).
  const repairTimer = setTimeout(() => {
    try {
      repairHistoricalLogs()
    } catch (error) {
      ctx.logger.warn('feishu: boot log repair failed: %s', error instanceof Error ? error.message : String(error))
    }
  }, 3000)
  /** @type {{ connected: boolean, reason?: string, started: boolean }} */
  const status = { connected: false, started: false }
  /** @type {ReturnType<typeof createLarkChannel> | undefined} */
  let channel
  /** Live streaming card per session id. */
  /** @type {Map<string, { handle: StreamHandle, empty: boolean }>} */
  const streams = new Map()
  /** Held Feishu images per chat (combined with the next text message). */
  const heldImages = new HeldImageBuffer()

  /**
   * The session's workspace directory, when knowable, for image staging.
   * @param {BindingRecord} record
   * @returns {string | undefined}
   */
  const sessionCwdFor = (record) => {
    const agent = ctx.agents.get(record.sessionId)
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  }

  /**
   * Download one image resource and stage it in the session workspace.
   * @param {import('@larksuite/channel').NormalizedMessage} msg
   * @param {import('@larksuite/channel').ResourceDescriptor} resource
   * @param {string} dir - staging directory inside the session workspace.
   * @returns {Promise<{ file?: import('./images.js').HeldImageFile, note?: string }>}
   */
  const stageImage = async (msg, resource, dir) => {
    if (channel === undefined) return { note: '机器人未连接' }
    try {
      const { buffer, contentType } = await channel.downloadResourceWithMeta(msg.messageId, resource.fileKey, 'image')
      const verdict = validateImage(buffer, contentType, resource.fileName, maxHeldImageBytes)
      if (!verdict.ok) return { note: verdict.reason }
      const name = `feishu-${randomUUID()}.${extFor(verdict.mediaType)}`
      const path = join(dir, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, buffer)
      return { file: { path, name: resource.fileName, bytes: buffer.byteLength, mediaType: verdict.mediaType } }
    } catch (error) {
      ctx.logger.warn('feishu: image download failed: %s', error instanceof Error ? error.message : String(error))
      return { note: '图片下载失败' }
    }
  }

  /**
   * Stage a message's images into the chat buffer. Returns the combined text
   * when the message also carried text, else undefined (hold only).
   * @param {import('@larksuite/channel').NormalizedMessage} msg
   * @param {BindingRecord} record
   * @returns {Promise<{ text: string, held: number, notes: string[] }>}
   */
  const ingestImages = async (msg, record) => {
    const images = (msg.resources ?? []).filter((resource) => resource.type === 'image')
    const notes = []
    if (images.length === 0) return { text: msg.content, held: 0, notes }
    if (!holdImages) return { text: msg.content, held: 0, notes }
    const cwd = sessionCwdFor(record)
    const dir = imageDirOverride !== undefined ? imageDirOverride : cwd === undefined ? undefined : join(cwd, '.dsh-fschannel-images')
    if (dir === undefined) {
      notes.push('无法确定会话工作目录，图片未暂存')
      return { text: msg.content, held: 0, notes }
    }
    heldImages.prune(holdTtlMs)
    let held = 0
    for (const resource of images) {
      if (heldImages.list(record.chatId).length + held >= maxHeldImages) {
        notes.push(`图片数量超过上限（${maxHeldImages}），后续图片已忽略`)
        break
      }
      const result = await stageImage(msg, resource, dir)
      if (result.file !== undefined) {
        heldImages.add(record.chatId, result.file)
        held += 1
        indexImage(record, result.file)
      } else if (result.note !== undefined) {
        notes.push(result.note)
      }
    }
    return { text: msg.content, held, notes }
  }

  /**
   * Index one staged image for the Web gallery. The image file lives in the
   * session workspace (`.dsh-fschannel-images/`); this store entry lets the
   * loopback image route resolve it even when the session's agent is not
   * live, and the gallery surface list it. NOTE: image events are NOT
   * appended to the session log anymore — the harness read path refuses logs
   * containing event types it does not know, which made any session with an
   * image unloadable. Rendering is API-driven instead (`GET /feishu/images`).
   * @param {BindingRecord} record
   * @param {import('./images.js').HeldImageFile} file
   */
  const indexImage = (record, file) => {
    if (!showImages) return
    const evicted = store.setImage(record.sessionId, basename(file.path), file.path, {
      mediaType: file.mediaType,
      bytes: file.bytes,
      fileName: file.name ?? '',
    })
    for (const path of evicted) {
      try { rmSync(path, { force: true }) } catch { /* best effort */ }
    }
  }

  /** Inbound message ids awaiting their turn's completion, for reactions. */
  /** @type {Map<string, string>} messageId -> chatId */
  const pendingReactions = new Map()
  /** The Feishu-originated message claimed by each turn (from agent/inbox/claimed). */
  /** @type {Map<number, string>} turn -> messageId */
  const claimedByTurn = new Map()

  /**
   * Add a reaction to a message (best effort).
   * @param {string} messageId @param {string} emoji
   */
  const addReaction = async (messageId, emoji) => {
    if (channel === undefined || !reactInbound) return
    try {
      await channel.addReaction(messageId, emoji)
    } catch (error) {
      const line = `feishu: addReaction(${messageId}, ${emoji}) failed: ${error instanceof Error ? error.message : String(error)}`
      ctx.logger.warn(line)
      process.stderr.write(line + '\n')
    }
  }

  /**
   * Swap one reaction for another on a message (best effort).
   * @param {string} messageId @param {string} from @param {string} to
   */
  const swapReaction = async (messageId, from, to) => {
    if (channel === undefined || !reactInbound) return
    try {
      const removed = await channel.removeReactionByEmoji(messageId, from)
      if (removed && to !== '') await channel.addReaction(messageId, to)
    } catch (error) {
      const line = `feishu: swapReaction(${messageId}, ${from}->${to}) failed: ${error instanceof Error ? error.message : String(error)}`
      ctx.logger.warn(line)
      process.stderr.write(line + '\n')
    }
  }

  // Correlate completed turns with the Feishu message they answered, so a
  // web-driven turn never swaps a Feishu message's reaction.
  ctx.on('agent/inbox/claimed', (payload) => {
    const messageId = payload?.message?.id
    if (typeof messageId === 'string' && pendingReactions.has(messageId)) {
      claimedByTurn.set(payload.turn, messageId)
    }
  })

  let active = true
  ctx.effect(() => () => { active = false }, 'dsh-fschannel: lifetime')

  const api = ctx.get('apiProxy')

  // ── outbound helpers ────────────────────────────────────────────────────

  /** @param {string} chatId @param {string} markdown @param {string} [replyTo] */
  const send = (chatId, markdown, replyTo) => {
    if (channel === undefined) return Promise.resolve()
    return channel.send(chatId, { markdown }, replyTo === undefined ? {} : { replyTo })
  }

  /**
   * Send an interactive card, preferring reply placement with a plain retry.
   * @param {string} chatId
   * @param {object} card
   * @param {string} [replyTo]
   */
  const sendCard = async (chatId, card, replyTo) => {
    if (channel === undefined) return
    try {
      await channel.send(chatId, { card }, replyTo === undefined ? {} : { replyTo })
    } catch (error) {
      ctx.logger.warn('feishu: card send failed (retrying plain): %s', error instanceof Error ? error.message : String(error))
      try {
        await channel.send(chatId, { card }, {})
      } catch (retryError) {
        ctx.logger.warn('feishu: card send failed: %s', retryError instanceof Error ? retryError.message : String(retryError))
      }
    }
  }

  /** @param {string} chatId @param {object} [opts] @param {(err: unknown) => void} onFailure */
  const openStream = (chatId, opts, onFailure) => {
    const handle = new StreamHandle(channel, chatId, opts, onFailure)
    return handle
  }

  // ── agent acquisition + model replay ────────────────────────────────────

  /**
   * Return the live agent for a session, resuming it first when needed.
   * @param {string} sessionId
   * @returns {Promise<HostAgent | undefined>}
   */
  const getLiveAgent = async (sessionId) => {
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return live
    try {
      const handle = await ctx.agents.resume({ resumeSessionId: sessionId })
      return handle.agent
    } catch (error) {
      ctx.logger.warn('feishu: cannot resume session %s: %s', sessionId, error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /**
   * Replay a persisted model route onto a live agent (per-session durability).
   * @param {BindingRecord | undefined} record
   * @returns {Promise<void>}
   */
  const replayModelRoute = async (record) => {
    const route = record?.modelRoute
    if (route === undefined || api === undefined) return
    const res = await api.sessions.selectModel({
      rpcId: `feishu-${randomUUID()}`,
      payload: {
        sessionId: record.sessionId,
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      },
    })
    if (!res.result?.ok) {
      ctx.logger.warn('feishu: model route replay failed for %s: %s', record.sessionId,
        res.result?.error?.message ?? 'unknown')
    }
  }

  // ── model commands (through the host apiProxy, same path as the Web UI) ──

  /** @param {string} sessionId */
  const readModels = async (sessionId) => {
    if (api === undefined) return undefined
    const res = await api.sessions.models({ rpcId: `feishu-${randomUUID()}`, payload: { sessionId } })
    return res.result?.ok === true ? res.result.value : undefined
  }

  /** @param {{ provider: string, model: string, reasoningEffort?: string }} selection */
  const applySelection = async (record, selection) => {
    if (api === undefined) return '模型服务不可用'
    const res = await api.sessions.selectModel({
      rpcId: `feishu-${randomUUID()}`,
      payload: {
        sessionId: record.sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      },
    })
    if (res.result?.ok !== true) {
      const message = res.result?.error?.message ?? '切换失败'
      return `切换失败：${message}`
    }
    const selected = res.result.value.selected
    const saved = {
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
    store.setModelRoute(record.sessionId, saved)
    const effort = saved.reasoningEffort === undefined ? '默认' : saved.reasoningEffort
    return `已切换：${saved.provider}/${saved.model}（effort ${effort}）\n下一条消息起生效。`
  }

  /** @param {BindingRecord} record @param {string[]} args @param {string} replyTo */
  const handleModelCommand = async (record, args, replyTo) => {
    const sessionId = record.sessionId
    const sub = args[0]
    if (sub === 'list' || sub === 'ls') {
      const directory = await readModels(sessionId)
      if (directory === undefined) {
        await send(record.chatId, '无法读取模型目录（会话不可用）', replyTo)
        return
      }
      const lines = ['模型目录：']
      for (const group of directory.groups ?? []) {
        const modelRows = (group.models ?? []).map((model) => {
          const efforts = model.reasoning?.efforts?.map((e) => e.id).join('/') ?? ''
          return `  · ${group.id}/${model.id}${efforts === '' ? '' : `（effort: ${efforts}）`}`
        })
        lines.push(`${group.name}（${group.id}）`, ...modelRows)
      }
      await send(record.chatId, lines.join('\n'), replyTo)
      return
    }
    if (sub === 'use') {
      const raw = (args[1] ?? '').trim()
      if (raw === '') {
        await send(record.chatId, '用法：/model use <provider>/<model>（或仅 <model>，沿用当前提供方）', replyTo)
        return
      }
      const directory = await readModels(sessionId)
      const currentProvider = directory?.current?.provider
      const separator = raw.indexOf('/')
      const provider = separator > 0 ? raw.slice(0, separator) : currentProvider
      const model = separator > 0 ? raw.slice(separator + 1) : raw
      if (provider === undefined || provider === '') {
        await send(record.chatId, '无法确定提供方，请用完整路径：/model use <provider>/<model>', replyTo)
        return
      }
      const reply = await applySelection(record, { provider, model })
      await send(record.chatId, reply, replyTo)
      return
    }
    if (sub === 'effort') {
      const level = (args[1] ?? '').trim().toLowerCase()
      const directory = await readModels(sessionId)
      if (directory === undefined || directory.current === undefined) {
        await send(record.chatId, '无法读取当前模型（会话不可用）', replyTo)
        return
      }
      const current = directory.current
      if (level === '') {
        const model = (directory.groups ?? []).flatMap((g) => g.models ?? []).find((m) => m.id === current.model)
        const efforts = model?.reasoning?.efforts?.map((e) => e.id).join('/') ?? 'off/high/max'
        await send(record.chatId, `用法：/model effort <${efforts}>\n当前 effort：${current.reasoningEffort ?? '默认'}`, replyTo)
        return
      }
      const reply = await applySelection(record, {
        provider: current.provider,
        model: current.model,
        reasoningEffort: level,
      })
      await send(record.chatId, reply, replyTo)
      return
    }
    // plain /model: show the current selection.
    const directory = await readModels(sessionId)
    if (directory === undefined || directory.current === undefined) {
      await send(record.chatId, '无法读取当前模型（会话不可用）', replyTo)
      return
    }
    const current = directory.current
    const effort = current.reasoningEffort === undefined ? '默认' : current.reasoningEffort
    await send(record.chatId, `当前模型：${current.provider}/${current.model}\nreasoning effort：${effort}\n\n/model list 查看目录 · /model use <provider>/<model> 切换 · /model effort <off|high|max> 调整强度`, replyTo)
  }

  /**
   * Publish (or refresh) the interactive model settings card for a bound session.
   * @param {BindingRecord} record
   * @param {string} [replyTo] - trigger message id for reply placement.
   * @param {object} [fresh] - already-known directory value, to avoid a refetch.
   * @returns {Promise<object | undefined>} the card object, or undefined when the session is unusable.
   */
  const buildSettingsCard = async (record, fresh) => {
    if (fresh === undefined) await getLiveAgent(record.sessionId)
    const directory = fresh ?? (await readModels(record.sessionId))
    if (directory === undefined || directory.current === undefined) return undefined
    return buildModelCard({
      sessionId: record.sessionId,
      current: directory.current,
      groups: directory.groups ?? [],
    })
  }

  /** @param {BindingRecord} record @param {string} replyTo */
  const handleStatusCommand = async (record, replyTo) => {
    const directory = await readModels(record.sessionId)
    const modelLine = directory?.current === undefined
      ? '模型：未知（会话不可用）'
      : `模型：${directory.current.provider}/${directory.current.model}（effort ${directory.current.reasoningEffort ?? '默认'}）`
    const lines = [
      '状态',
      `机器人：${status.connected ? '已连接' : '未连接'}`,
      `会话：${record.sessionId.slice(0, 8)}…${record.chatName === undefined ? '' : `（${record.chatName}）`}`,
      modelLine,
    ]
    await send(record.chatId, lines.join('\n'), replyTo)
  }

  // ── inbound ─────────────────────────────────────────────────────────────

  /**
   * Deliver one inbound message into a session.
   * @param {BindingRecord} record @param {string} text @param {string} replyTo
   */
  const deliver = async (record, text, replyTo) => {
    const wasLive = ctx.agents.get(record.sessionId) !== undefined
    const agent = await getLiveAgent(record.sessionId)
    if (agent === undefined || !active) {
      await send(record.chatId, '会话不可用，请检查该会话是否仍存在。', replyTo)
      return
    }
    // A freshly resumed agent must run under its persisted route.
    if (!wasLive) await replayModelRoute(record)
    const pendingBefore = agent.inbox.nextTurn.length + agent.inbox.nextStep.length
    const wasRunning = agent.status === 'running'
    const dshMessageId = randomUUID()
    agent.followup({
      id: dshMessageId,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    if (reactInbound) {
      // Keyed by the DSH message id (what agent/inbox/claimed reports); the
      // Feishu message id is what reactions actually target.
      pendingReactions.set(dshMessageId, { chatId: record.chatId, feishuMessageId: replyTo })
      void addReaction(replyTo, reactReceived)
    }
    if (wasRunning || pendingBefore > 0) {
      if (queueAck) {
        await send(record.chatId, `已收到，前面还有 ${pendingBefore} 条消息在排队，处理完会依次回复。`, replyTo)
      }
    } else if (ackInbound) {
      await send(record.chatId, '收到，处理中…', replyTo)
    }
  }

  /** @param {InboundMessage} msg */
  const handleMessage = async (msg) => {
    if (msg.senderIsBot === true || !active) return
    // @all never answers (matches the SDK's respondToMentionAll: false default).
    if (msg.mentionAll === true) return
    if (msg.chatType === 'group' && requireMention && !msg.mentionedBot) {
      // A group whose only human member is the sender counts as direct
      // conversation: no @ needed (the member list excludes the bot itself).
      if (!(await isSingleMemberChat(msg.chatId))) return
      ctx.logger.info('feishu: single-member group %s bypasses the mention requirement', msg.chatId)
    }

    const record = store.getByChat(msg.chatId)
    if (record !== undefined) {
      store.touchInbound(msg.chatId, msg.messageId)
      const line = msg.content.trim()
      if (line.startsWith('/')) {
        const parts = line.slice(1).trim().split(/\s+/)
        const command = (parts[0] ?? '').toLowerCase()
        const args = parts.slice(1)
        if (command === 'help') {
          await send(msg.chatId, helpText(), msg.messageId)
        } else if (command === 'model') {
          if (args.length === 0) {
            const card = await buildSettingsCard(record)
            if (card === undefined) {
              await send(msg.chatId, '无法读取当前模型（会话不可用）', msg.messageId)
            } else {
              await sendCard(msg.chatId, card, msg.messageId)
            }
          } else {
            await handleModelCommand(record, args, msg.messageId)
          }
        } else if (command === 'status') {
          await handleStatusCommand(record, msg.messageId)
        } else if (command === 'stop') {
          const agent = ctx.agents.get(record.sessionId)
          if (agent !== undefined) {
            agent.cancel('user')
            await send(msg.chatId, '已停止当前回合。', msg.messageId)
          } else {
            await send(msg.chatId, '当前没有运行中的回合。', msg.messageId)
          }
        } else {
          await send(msg.chatId, `未知命令「${command}」。\n\n${helpText()}`, msg.messageId)
        }
        return
      }
      if (modelCardTriggers && (MODEL_CARD_INTENT.test(line) || isBareKeyword(line))) {
        const card = await buildSettingsCard(record)
        if (card === undefined) {
          await send(msg.chatId, '无法读取当前模型（会话不可用）', msg.messageId)
        } else {
          await sendCard(msg.chatId, card, msg.messageId)
        }
        return
      }
      // Images: stage them now. Only a REAL text message consumes the held
      // images; image-only messages (SDK content is a `![image](...)` placeholder)
      // are acknowledged and never wake the agent.
      const ingested = await ingestImages(msg, record)
      if (ingested.held > 0) {
        store.touchInbound(msg.chatId, msg.messageId)
      }
      if (ingested.notes.length > 0) {
        const note = '（' + ingested.notes.join('；') + '）'
        await send(msg.chatId, note, msg.messageId)
      }
      const hasText = textWithoutImageMarkup(ingested.text) !== ''
      if (hasText) {
        const held = heldImages.take(record.chatId)
        const combined = held.length > 0
          ? `${ingested.text}\n\n${composeImageNote(held)}`
          : ingested.text
        await deliver(record, combined, msg.messageId)
        return
      }
      // Image-only: hold and acknowledge; processing waits for the text.
      if (holdHint && ingested.held > 0) {
        await send(msg.chatId, `已收到 ${ingested.held} 张图片，发送文字说明后将一起识别处理。`, msg.messageId)
      }
      return
    }

    const pendingSessionId = store.shiftPending()
    if (pendingSessionId !== undefined) {
      const chatName = await resolveChatName(msg.chatId)
      const bound = store.bind(pendingSessionId, msg.chatId, chatName, msg.messageId)
      await replayModelRoute(bound)
      await send(
        msg.chatId,
        `已绑定到 DSH 会话（${pendingSessionId.slice(0, 8)}…）。之后在这里发的消息都会进入该会话，回复也会发到这里。\n\n${helpText()}`,
        msg.messageId,
      )
      return
    }

    if (hintUnbound) {
      await send(msg.chatId, hintText, msg.messageId)
    }
  }

  /**
   * Resolve a chat's display name (best effort; failures are silent).
   * @param {string} chatId
   * @returns {Promise<string | undefined>}
   */
  const resolveChatName = async (chatId) => {
    if (channel === undefined) return undefined
    try {
      const raw = channel.rawClient
      const response = await raw.im.chat.get({ params: { chat_id: chatId } })
      const chat = response?.data?.chat
      if (typeof chat?.name === 'string' && chat.name !== '') return chat.name
    } catch {
      // Best effort only.
    }
    return undefined
  }

  /** Single-member chat cache: chatId -> { single, at }. */
  /** @type {Map<string, { single: boolean, at: number }>} */
  const singleMemberCache = new Map()
  const SINGLE_MEMBER_TTL_MS = 10 * 60 * 1000

  /**
   * Whether a group chat contains at most one human member beside the bot
   * (the SDK's getChatMembers returns users only — bots are filtered out).
   * Cached 10 minutes; any lookup failure falls back to false (mention still
   * required).
   * @param {string} chatId
   * @returns {Promise<boolean>}
   */
  const isSingleMemberChat = async (chatId) => {
    const cached = singleMemberCache.get(chatId)
    if (cached !== undefined && Date.now() - cached.at < SINGLE_MEMBER_TTL_MS) return cached.single
    let single = false
    if (channel !== undefined) {
      try {
        const members = await channel.getChatMembers(chatId)
        single = members.length <= 1
      } catch (error) {
        ctx.logger.warn('feishu: member lookup failed for %s: %s', chatId, error instanceof Error ? error.message : String(error))
      }
    }
    singleMemberCache.set(chatId, { single, at: Date.now() })
    return single
  }

  // ── outbound: session events → bound chats ──────────────────────────────

  ctx.on('session/event', (session, event) => {
    if (channel === undefined) return
    const record = store.getBySession(session.id)
    if (record === undefined) return
    const replyTo = record.lastInboundMessageId
    const opts = replyTo === undefined ? undefined : { replyTo }
    const fail = (error) => {
      const line = `feishu: outbound failed for ${record.chatId}: ${error instanceof Error ? error.message : String(error)}`
      ctx.logger.warn(line)
      process.stderr.write(line + '\n')
    }

    const ensureStream = () => {
      const existing = streams.get(session.id)
      if (existing !== undefined) return existing
      const entry = { handle: openStream(record.chatId, opts, fail), empty: true }
      streams.set(session.id, entry)
      return entry
    }

    switch (event?.type) {
      case 'turn/start': {
        // Open the card the moment work begins; the placeholder text shows
        // until the first real content replaces it.
        if (output !== 'stream') break
        ensureStream()
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data?.chunk
        if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') break
        if (output !== 'stream') break
        const entry = ensureStream()
        if (entry.empty) entry.handle.set(chunk.text)
        else entry.handle.append(chunk.text)
        entry.empty = false
        break
      }
      case 'tool/call': {
        if (output !== 'stream') break
        const name = typeof event.data?.name === 'string' ? event.data.name : ''
        const line = name === '' ? '> 正在调用工具…' : `> 正在调用工具：${name}…`
        const entry = ensureStream()
        if (entry.empty) entry.handle.set(line)
        else entry.handle.append('\n' + line)
        break
      }
      case 'assistant/message': {
        const text = extractText(event.data?.message)
        if (text === '') break
        if (output === 'stream') {
          const entry = ensureStream()
          entry.empty = false
          entry.handle.set(text)
        } else {
          void send(record.chatId, text, replyTo).catch(fail)
        }
        break
      }
      case 'turn/end': {
        // Reaction: the claimed Feishu message moves from received to done/error.
        // Exact correlation via agent/inbox/claimed; FIFO fallback (oldest
        // pending reaction in this chat) when that event is unreachable.
        const turn = event.data?.turn
        if (typeof turn === 'number') {
          let claimedId = claimedByTurn.get(turn)
          if (claimedId === undefined) {
            for (const [id, info] of pendingReactions) {
              if (info.chatId === record.chatId) { claimedId = id; break }
            }
          }
          if (claimedId !== undefined) {
            claimedByTurn.delete(turn)
            const info = pendingReactions.get(claimedId)
            pendingReactions.delete(claimedId)
            if (info !== undefined) {
              const reasonKind = event.data?.reason?.kind
              if (reasonKind === 'error') void swapReaction(info.feishuMessageId, reactReceived, reactError)
              else if (reasonKind === 'cancelled') void swapReaction(info.feishuMessageId, reactReceived, '')
              else void swapReaction(info.feishuMessageId, reactReceived, reactDone)
            }
          }
        }
        // Final card: keep the settled content, formatted.
        const entry = streams.get(session.id)
        if (entry !== undefined) {
          streams.delete(session.id)
          const reasonKind = event.data?.reason?.kind
          const detail = event.data?.reason?.message ?? event.data?.reason?.code ?? ''
          let finalText = entry.handle.full
          if (reasonKind === 'error') {
            finalText = finalText === ''
              ? `**任务失败**${detail === '' ? '' : `：${detail}`}`
              : `${finalText}\n\n**任务失败**${detail === '' ? '' : `：${detail}`}`
          } else if (finalText === '') {
            finalText = '（本轮没有产生输出）'
          }
          void entry.handle.finish().then(async () => {
            const messageId = entry.handle.messageId
            if (messageId === undefined) {
              // The streaming card failed (e.g. missing cardkit permission):
              // deliver the final result as a static structured card instead
              // of plain markdown, with a plain message as the last resort.
              const card = renderFinalCard(finalText)
              if (card !== undefined) {
                try {
                  await sendCard(record.chatId, card, replyTo)
                  return
                } catch { /* fall through */ }
              }
              await send(record.chatId, finalText, replyTo).catch(fail)
              return
            }
            if (channel === undefined) return
            try {
              const card = renderFinalCard(finalText)
              if (card !== undefined) await channel.updateCard(messageId, card)
            } catch (error) {
              // Structured card rejected: fall back to one markdown element so
              // the final result stays visible.
              ctx.logger.warn('feishu: structured final card rejected, falling back: %s', error instanceof Error ? error.message : String(error))
              try {
                await channel.updateCard(messageId, renderPlainCard(finalText))
              } catch (secondError) {
                ctx.logger.warn('feishu: final card update failed: %s', secondError instanceof Error ? secondError.message : String(secondError))
                // Last resort: the result as a new structured card message.
                const fallbackCard = renderFinalCard(finalText)
                if (fallbackCard !== undefined) {
                  try { await sendCard(record.chatId, fallbackCard, replyTo) } catch { /* best effort */ }
                }
              }
            }
          }).catch(fail)
        } else if (event.data?.reason?.kind === 'error') {
          const detail = event.data?.reason?.message ?? event.data?.reason?.code ?? ''
          void send(record.chatId, `**任务失败**${detail === '' ? '' : `：${detail}`}`, replyTo).catch(fail)
        }
        break
      }
      default:
        break
    }
  })

  // ── card actions: model / effort buttons ─────────────────────────────────

  /**
   * Apply one model-settings card button press and update the card in place.
   * @param {import('@larksuite/channel').CardActionEvent} evt
   * @returns {Promise<object | undefined>} the callback response (toast + card).
   */
  const handleCardAction = async (evt) => {
    const value = parseActionValue(evt.action.value)
    if (value === undefined) return undefined
    const record = store.getBySession(value.sessionId)
    if (record === undefined || record.chatId !== evt.chatId) {
      return { toast: { type: 'info', content: '该会话已解除绑定，设置已失效' } }
    }
    if (api === undefined) {
      return { toast: { type: 'error', content: '模型服务不可用' } }
    }
    const selection = {
      provider: value.provider,
      model: value.model,
      ...(value.effort === undefined ? {} : { reasoningEffort: value.effort }),
    }
    try {
      const res = await api.sessions.selectModel({
        rpcId: `feishu-${randomUUID()}`,
        payload: { sessionId: value.sessionId, ...selection },
      })
      if (res.result?.ok !== true) {
        const message = res.result?.error?.message ?? '切换失败'
        return { toast: { type: 'error', content: message.slice(0, 200) } }
      }
      const selected = res.result.value.selected
      const saved = {
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
      }
      store.setModelRoute(value.sessionId, saved)
      // Rebuild the card with the fresh selection; the current model row and
      // effort row highlight the active choices.
      const card = await buildSettingsCard(record)
      if (card === undefined) {
        return {
          toast: { type: 'success', content: `已切换：${saved.model}（effort ${saved.reasoningEffort ?? '默认'}）` },
        }
      }
      return {
        toast: { type: 'success', content: `已切换：${saved.model}（effort ${saved.reasoningEffort ?? '默认'}）` },
        card: { type: 'raw', data: card },
      }
    } catch (error) {
      ctx.logger.warn('feishu: card action failed: %s', error instanceof Error ? error.message : String(error))
      return { toast: { type: 'error', content: '设置失败，请稍后再试' } }
    }
  }

  // ── transport ───────────────────────────────────────────────────────────

  /**
   * Tear down the current channel, if any. Safe to call when none exists.
   * @returns {Promise<void>}
   */
  const disconnect = async () => {
    const old = channel
    channel = undefined
    status.connected = false
    if (old === undefined) return
    try {
      await old.disconnect()
    } catch (error) {
      ctx.logger.warn('feishu: disconnect failed: %s', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * (Re)connect the bot with the current credentials. Re-entrant: an existing
   * channel is torn down first, so credential changes reconnect cleanly.
   * Concurrent calls are serialized through a promise chain: each call runs
   * only after the previous one settles, so teardown + rebuild never overlap.
   * @returns {Promise<void>}
   */
  let connectChain = Promise.resolve()
  const connect = () => {
    const run = async () => {
      if (!active) return
      status.started = true
      await disconnect()
      await refreshCredentials()
      if (credentials.appId === '' || credentials.appSecret === '') {
        status.reason = 'credentials missing — set appId/appSecret in the settings page'
        ctx.logger.warn('feishu: no app credentials (entry config, credential store or %s); bot transport disabled', envFile)
        return
      }
      const next = createLarkChannel({
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        // The SDK's PolicyGate drops unmentioned group messages BEFORE handlers
        // run, so single-member-group exemption could never apply. Disable the
        // SDK gate and enforce mention policy here (handleMessage), where the
        // single-member exemption lives.
        policy: { requireMention: false },
        safety: {
          dedup: { ttl: 30000 },
          chatQueue: { enabled: true, mergeWhileBusy: false },
        },
        source: 'dsh-fschannel',
      })
      channel = next
      channel.on('message', (msg) => { void handleMessage(msg).catch((error) => {
        ctx.logger.error('feishu: inbound handling failed: %s', error instanceof Error ? error.message : String(error))
      }) })
      channel.on('cardAction', (evt) => handleCardAction(evt))
      channel.on('error', (error) => {
        status.connected = false
        ctx.logger.error('feishu: transport error: %s', error instanceof Error ? error.message : String(error))
      })
      channel.on('reconnecting', () => { status.connected = false })
      channel.on('reconnected', () => { status.connected = true })
      try {
        await channel.connect()
        if (active) status.connected = true
        status.reason = undefined
        ctx.logger.info('feishu: bot connected (app %s, output %s, source %s)', credentials.appId, output, credentials.source)
      } catch (error) {
        status.connected = false
        status.reason = error instanceof Error ? error.message : String(error)
        ctx.logger.error('feishu: connect failed: %s', status.reason)
      }
    }
    // Serialize through a promise chain; a rejected run must not break the
    // chain for later calls (both arms forward to run).
    connectChain = connectChain.then(run, run)
    return connectChain
  }

  void connect()

  // ── HTTP API (loopback only) ────────────────────────────────────────────

  const isLoopback = (req) => {
    const address = req.socket?.remoteAddress ?? ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  /** @param {import('node:http').ServerResponse} res */
  const json = (res, code, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(payload)
  }

  /** @param {import('node:http').IncomingMessage} req */
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_048_576) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })

  /**
   * Describe both credential refs without ever exposing the secret value.
   * @returns {Promise<{ appId: object, appSecret: object }>}
   */
  const credentialStatus = async () => {
    const describe = async (ref) => {
      try {
        return (await ctx.credentials.describe(ref)) ?? { configured: false, writable: true }
      } catch (error) {
        return { configured: false, writable: true, error: String(error) }
      }
    }
    const appId = await describe('FEISHU_APP_ID')
    const appSecret = await describe('FEISHU_APP_SECRET')
    return {
      appId: { ...appId, ...(credentials.appId === '' ? {} : { masked: maskSecret(credentials.appId) }) },
      appSecret: { ...appSecret },
    }
  }

  /** Staged image names: feishu-<uuid>.<ext>. */
  const STAGED_NAME = /^feishu-[0-9a-f-]+\.(png|jpe?g|webp|gif)$/i
  /**
   * DSH session ids: `session-<uuid>` (web GUI) or `session-<n>` (headless
   * counters). Strict charset + shape so the value can never smuggle path
   * separators; the authoritative confinement is the relative() check below.
   */
  const SESSION_ID = /^(?:session-)?(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i

  /**
   * Resolve a staged image file for the loopback image route. The persisted
   * image index (bindings store) is authoritative — it works even when the
   * session's agent is not live. The agent-header cwd derivation is the
   * fallback for images staged before the index existed. Both name and session
   * id are strictly validated and the result is confined to the staging
   * directory (belt and braces against path traversal).
   * @param {string} sessionId @param {string} name
   * @returns {string | undefined} absolute file path, when present.
   */
  const resolveImageFile = (sessionId, name) => {
    if (!SESSION_ID.test(sessionId) || !STAGED_NAME.test(name)) return undefined
    const indexed = store.imagePath(sessionId, name)
    if (indexed !== undefined && basename(indexed) === name) {
      return existsSync(indexed) ? indexed : undefined
    }
    const agent = ctx.agents.get(sessionId)
    const cwd = agent?.session?.header?.cwd
    const dir = imageDirOverride !== undefined
      ? imageDirOverride
      : typeof cwd === 'string' && cwd !== '' ? join(cwd, '.dsh-fschannel-images') : undefined
    if (dir === undefined) return undefined
    const file = join(dir, name)
    const rel = relative(dir, file)
    if (rel === '' || rel.startsWith('..') || rel.includes('..\\') || rel.includes('../')) return undefined
    return existsSync(file) ? file : undefined
  }

  /** @param {string} name - staged file name. @returns {string} image content type. */
  const imageContentType = (name) => {
    const ext = name.toLowerCase().split('.').pop()
    if (ext === 'png') return 'image/png'
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'webp') return 'image/webp'
    if (ext === 'gif') return 'image/gif'
    return 'application/octet-stream'
  }

  const handleRoute = async (req, res) => {
    if (!isLoopback(req)) {
      json(res, 403, { ok: false, error: 'loopback only' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    try {
      if (path === '/feishu/status' && req.method === 'GET') {
        json(res, 200, {
          ok: true,
          connected: status.connected,
          configured: true,
          appId: maskSecret(credentials.appId),
          output,
          showImages,
          credentialSource: credentials.source,
          envFile,
          bindingsFile,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
          ...store.status(),
        })
        return
      }
      if (path === '/feishu/config' && req.method === 'GET') {
        json(res, 200, {
          ok: true,
          autoBindNewSession: store.settings.autoBindNewSession,
          output,
          showImages,
          holdTtlSeconds: Math.round(holdTtlMs / 1000),
          maxHeldImages,
          maxHeldImageBytes: Math.round(maxHeldImageBytes / (1024 * 1024) * 10) / 10,
          credentials: await credentialStatus(),
        })
        return
      }
      if (path === '/feishu/config' && req.method === 'POST') {
        const body = await readBody(req)
        if (typeof body.autoBindNewSession === 'boolean') {
          store.setSettings({ autoBindNewSession: body.autoBindNewSession })
        }
        if (body.output !== undefined) {
          if (body.output !== 'stream' && body.output !== 'plain') {
            json(res, 400, { ok: false, error: 'output 必须是 stream 或 plain' })
            return
          }
          store.setSettings({ output: body.output })
          output = body.output
        }
        if (body.showImages !== undefined) {
          if (typeof body.showImages !== 'boolean') {
            json(res, 400, { ok: false, error: 'showImages 必须是布尔值' })
            return
          }
          store.setSettings({ showImages: body.showImages })
          showImages = body.showImages
        }
        if (body.holdTtlSeconds !== undefined) {
          const seconds = Number(body.holdTtlSeconds)
          if (!Number.isInteger(seconds) || seconds < 0) {
            json(res, 400, { ok: false, error: 'holdTtlSeconds 必须是不小于 0 的整数（秒）' })
            return
          }
          store.setSettings({ holdTtlSeconds: seconds })
          holdTtlMs = seconds * 1000
        }
        if (body.maxHeldImages !== undefined) {
          const count = Number(body.maxHeldImages)
          if (!Number.isInteger(count) || count < 1) {
            json(res, 400, { ok: false, error: 'maxHeldImages 必须是大于等于 1 的整数' })
            return
          }
          store.setSettings({ maxHeldImages: count })
          maxHeldImages = count
        }
        if (body.maxHeldImageBytes !== undefined) {
          const mb = Number(body.maxHeldImageBytes)
          if (!Number.isFinite(mb) || mb < 0.001 || mb > 1024) {
            json(res, 400, { ok: false, error: 'maxHeldImageBytes 必须在 0.001 到 1024 MB 之间' })
            return
          }
          store.setSettings({ maxHeldImageBytes: mb })
          maxHeldImageBytes = Math.round(mb * 1024 * 1024)
        }
        // Credentials: blank/absent means no change; the secret is never echoed.
        let credentialChanged = false
        if (typeof body.appId === 'string' && body.appId.trim() !== '') {
          try {
            await ctx.credentials.set('FEISHU_APP_ID', body.appId.trim())
            credentialChanged = true
          } catch (error) {
            json(res, 400, { ok: false, error: `appId 保存失败：${error instanceof Error ? error.message : String(error)}` })
            return
          }
        }
        if (typeof body.appSecret === 'string' && body.appSecret.trim() !== '') {
          try {
            await ctx.credentials.set('FEISHU_APP_SECRET', body.appSecret.trim())
            credentialChanged = true
          } catch (error) {
            json(res, 400, { ok: false, error: `appSecret 保存失败：${error instanceof Error ? error.message : String(error)}` })
            return
          }
        }
        if (credentialChanged) {
          const before = credentials
          await refreshCredentials()
          if (credentials.appId !== before.appId || credentials.appSecret !== before.appSecret) {
            void connect().catch((error) => {
              ctx.logger.warn('feishu: reconnect after credential change failed: %s', error instanceof Error ? error.message : String(error))
            })
          }
        }
        json(res, 200, {
          ok: true,
          autoBindNewSession: store.settings.autoBindNewSession,
          output,
          showImages,
          holdTtlSeconds: Math.round(holdTtlMs / 1000),
          maxHeldImages,
          maxHeldImageBytes: Math.round(maxHeldImageBytes / (1024 * 1024) * 10) / 10,
          credentials: await credentialStatus(),
        })
        return
      }
      if (path.startsWith('/feishu/images/') && req.method === 'GET') {
        const sessionId = decodeURIComponent(path.slice('/feishu/images/'.length))
        if (sessionId === '' || sessionId.includes('/')) {
          json(res, 400, { ok: false, error: 'sessionId required' })
          return
        }
        const images = store.imagesList(sessionId)
        json(res, 200, { ok: true, sessionId, images })
        return
      }
      if (path.startsWith('/feishu/image/') && req.method === 'GET') {
        const rest = decodeURIComponent(path.slice('/feishu/image/'.length))
        const parts = rest.split('/')
        if (parts.length !== 2) {
          json(res, 404, { ok: false, error: 'not found' })
          return
        }
        const file = resolveImageFile(parts[0], parts[1])
        if (file === undefined) {
          json(res, 404, { ok: false, error: 'image not found' })
          return
        }
        try {
          const bytes = readFileSync(file)
          res.writeHead(200, {
            'content-type': imageContentType(parts[1]),
            'cache-control': 'private, max-age=3600',
            'content-length': String(bytes.length),
          })
          res.end(bytes)
        } catch {
          json(res, 404, { ok: false, error: 'image not found' })
        }
        return
      }
      if (path === '/feishu/bind' && req.method === 'POST') {
        const body = await readBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') {
          json(res, 400, { ok: false, error: 'sessionId required' })
          return
        }
        const chatId = typeof body.chatId === 'string' && body.chatId !== '' ? body.chatId : undefined
        if (chatId === undefined) {
          store.addPending(sessionId)
          json(res, 200, { ok: true, state: 'pending', sessionId })
          return
        }
        const chatName = await resolveChatName(chatId)
        const record = store.bind(sessionId, chatId, chatName)
        heldImages.clear(chatId)
        await replayModelRoute(record)
        json(res, 200, { ok: true, state: 'bound', sessionId, chatId })
        return
      }
      if (path === '/feishu/unbind' && req.method === 'POST') {
        const body = await readBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') {
          json(res, 400, { ok: false, error: 'sessionId required' })
          return
        }
        const before = store.getBySession(sessionId)
        store.removePending(sessionId)
        const removed = store.unbind(sessionId)
        if (removed && before !== undefined) heldImages.clear(before.chatId)
        streams.delete(sessionId)
        json(res, 200, { ok: true, removed })
        return
      }
      if (path === '/feishu/repair-logs' && req.method === 'POST') {
        // Manual re-run of the boot repair (e.g. after upgrading the plugin
        // while the harness stayed up). Only non-live sessions are touched.
        try {
          repairHistoricalLogs()
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const unregister = ctx.webServer.register({ kind: 'prefix', path: '/feishu', handler: handleRoute })
  ctx.effect(() => unregister, 'dsh-fschannel: /feishu routes')
}
