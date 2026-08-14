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
 *   GET  /feishu/status   — bot connection + bindings + pending
 *   POST /feishu/bind     — { sessionId, chatId? } bind (or queue pending)
 *   POST /feishu/unbind   — { sessionId }
 *   GET  /feishu/config   — { autoBindNewSession }
 *   POST /feishu/config   — { autoBindNewSession }
 * @module dsh-fschannel
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLarkChannel } from '@larksuite/channel'
import { readEnvMap, resolveCredentials } from './env.js'
import { BindingStore } from './bindings.js'
import { StreamHandle } from './stream.js'
import { buildModelCard, isBareKeyword, MODEL_CARD_ACTION, MODEL_CARD_INTENT, parseActionValue } from './cards.js'
import { renderFinalCard, renderPlainCard } from './render.js'

/** Cordis plugin name; keep stable after publishing. */
export const name = 'feishu-bot'

/** Services that must exist before the plugin is applied. */
export const inject = ['agents', 'webServer', 'apiProxy']

/**
 * The plugin configuration from the loader entry.
 * @typedef {{ envFile?: string, appId?: string, appSecret?: string,
 *   requireMention?: boolean, ackInbound?: boolean, queueAck?: boolean,
 *   hintUnbound?: boolean, hintText?: string, bindingsFile?: string,
 *   output?: 'stream' | 'plain', modelCardTriggers?: boolean }} FeishuConfig
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
  const output = config.output === 'plain' ? 'plain' : 'stream'
  const queueAck = config.queueAck !== false
  const ackInbound = config.ackInbound === true
  const hintUnbound = config.hintUnbound !== false
  const modelCardTriggers = config.modelCardTriggers !== false
  const reactInbound = config.reactInbound !== false
  const reactReceived = typeof config.reactReceived === 'string' && config.reactReceived !== '' ? config.reactReceived : 'THUMBSUP'
  const reactDone = typeof config.reactDone === 'string' && config.reactDone !== '' ? config.reactDone : 'DONE'
  const reactError = typeof config.reactError === 'string' && config.reactError !== '' ? config.reactError : 'SAD'
  const hintText = typeof config.hintText === 'string' && config.hintText !== '' ? config.hintText : defaultHint()

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

  const credentials = resolveCredentials(envFile, config)
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
  /** @type {{ connected: boolean, reason?: string, started: boolean }} */
  const status = { connected: false, started: false }
  /** @type {ReturnType<typeof createLarkChannel> | undefined} */
  let channel
  /** Live streaming card per session id. */
  /** @type {Map<string, { handle: StreamHandle, empty: boolean }>} */
  const streams = new Map()
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
      ctx.logger.warn('feishu: addReaction(%s, %s) failed: %s', messageId, emoji, error instanceof Error ? error.message : String(error))
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
      ctx.logger.warn('feishu: swapReaction(%s, %s->%s) failed: %s', messageId, from, to, error instanceof Error ? error.message : String(error))
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

  if (credentials.appId === '' || credentials.appSecret === '') {
    ctx.logger.warn('feishu: no app credentials (entry config or %s); bot transport disabled', envFile)
    status.reason = 'credentials missing — set appId/appSecret or envFile'
    return
  }

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
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    if (reactInbound) {
      pendingReactions.set(replyTo, record.chatId)
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
    if (msg.chatType === 'group' && requireMention && !msg.mentionedBot) return

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
      await deliver(record, msg.content, msg.messageId)
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

  // ── outbound: session events → bound chats ──────────────────────────────

  ctx.on('session/event', (session, event) => {
    if (channel === undefined) return
    const record = store.getBySession(session.id)
    if (record === undefined) return
    const replyTo = record.lastInboundMessageId
    const opts = replyTo === undefined ? undefined : { replyTo }
    const fail = (error) => {
      ctx.logger.warn('feishu: outbound failed for %s: %s', record.chatId, error instanceof Error ? error.message : String(error))
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
        const turn = event.data?.turn
        if (typeof turn === 'number') {
          const claimedId = claimedByTurn.get(turn)
          if (claimedId !== undefined) {
            claimedByTurn.delete(turn)
            pendingReactions.delete(claimedId)
            const reasonKind = event.data?.reason?.kind
            if (reasonKind === 'error') void swapReaction(claimedId, reactReceived, reactError)
            else if (reasonKind === 'cancelled') void swapReaction(claimedId, reactReceived, '')
            else void swapReaction(claimedId, reactReceived, reactDone)
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
            if (messageId === undefined || channel === undefined) return
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

  const connect = async () => {
    if (!active || status.started) return
    status.started = true
    channel = createLarkChannel({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      policy: { requireMention },
      safety: {
        dedup: { ttl: 30000 },
        chatQueue: { enabled: true, mergeWhileBusy: false },
      },
      source: 'dsh-fschannel',
    })
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
      ctx.logger.info('feishu: bot connected (app %s, output %s)', credentials.appId, output)
    } catch (error) {
      status.connected = false
      status.reason = error instanceof Error ? error.message : String(error)
      ctx.logger.error('feishu: connect failed: %s', status.reason)
    }
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
          appId: credentials.appId,
          output,
          envFile,
          bindingsFile,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
          ...store.status(),
        })
        return
      }
      if (path === '/feishu/config' && req.method === 'GET') {
        json(res, 200, { ok: true, autoBindNewSession: store.settings.autoBindNewSession })
        return
      }
      if (path === '/feishu/config' && req.method === 'POST') {
        const body = await readBody(req)
        if (typeof body.autoBindNewSession === 'boolean') {
          store.setAutoBindNewSession(body.autoBindNewSession)
        }
        json(res, 200, { ok: true, autoBindNewSession: store.settings.autoBindNewSession })
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
        store.removePending(sessionId)
        const removed = store.unbind(sessionId)
        streams.delete(sessionId)
        json(res, 200, { ok: true, removed })
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
