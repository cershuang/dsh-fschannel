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
 * HTTP API (loopback only; state-changing methods additionally require a
 * same-origin request and a JSON content-type — see isSameOrigin):
 *   GET  /feishu/status   — bot connection + bindings + pending + settings
 *   POST /feishu/bind     — { sessionId, chatId? } bind (or queue pending)
 *   POST /feishu/unbind   — { sessionId }
 *   GET  /feishu/config   — settings + credential status (masked only)
 *   POST /feishu/config   — { appId?, appSecret?, output?, showImages?,
 *                            holdTtlSeconds?, maxHeldImages?, maxHeldImageBytes?,
 *                            autoBindNewSession?, locale? }
 *
 * Validation failures answer { ok: false, code, error }. `code` is a stable
 * identifier the client translates; `error` is an English fallback for curl and
 * logs. The server does NOT localize these: its `ui` dictionary is a single
 * process-wide value (the last locale any client reported), so translating here
 * would show one browser's language in another's UI. Feishu-facing copy has no
 * such alternative — a chat has no locale of its own — and is a deliberate
 * single-tenant assumption.
 *   GET  /feishu/images/<sessionId>       — staged image index for the gallery
 *   GET  /feishu/image/<sessionId>/<name> — staged Feishu image bytes
 *   POST /feishu/repair-logs — force a session-log repair pass. OPERATIONS
 *     ONLY: no UI calls it, it is rate-limited to one pass a minute, and the
 *     pass is fully synchronous — it blocks the entire harness process (every
 *     agent, the web server and the Feishu transport) for its duration.
 * @module dsh-fschannel
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { createLarkChannel } from '@larksuite/channel'
import { maskSecret, readEnvMap, resolveCredentials } from './env.js'
import { errText } from './errors.js'
import { dictFor, zh as zhCopy } from './locales.js'
import { BindingStore } from './bindings.js'
import { StreamHandle } from './stream.js'
import { buildModelCard, isBareKeyword, MODEL_CARD_INTENT, parseActionValue } from './cards.js'
import { renderFinalCard, renderPlainCard } from './render.js'
import { composeImageNote, contentTypeFor, extFor, HeldImageBuffer, STAGED_EXTENSIONS, textWithoutImageMarkup, validateImage } from './images.js'
import { collectForeignEvents, findLogFile, repairSessionLog } from './repair.js'

/** Cordis plugin name; keep stable after publishing. */
export const name = 'feishu-bot'

/** Services that must exist before the plugin is applied. */
export const inject = ['agents', 'webServer', 'apiProxy', 'credentials']

/** Staging directory for Feishu images, created inside the session workspace. */
const STAGE_DIR_NAME = '.dsh-fschannel-images'

/**
 * The plugin configuration from the loader entry.
 * @typedef {{ envFile?: string, appId?: string, appSecret?: string,
 *   requireMention?: boolean, ackInbound?: boolean, queueAck?: boolean,
 *   hintUnbound?: boolean, hintText?: string, bindingsFile?: string,
 *   output?: 'stream' | 'plain', showImages?: boolean, modelCardTriggers?: boolean,
 *   reactInbound?: boolean, reactReceived?: string, reactDone?: string, reactError?: string,
 *   holdImages?: boolean, holdHint?: boolean, maxHeldImages?: number,
 *   maxHeldImageBytes?: number, holdTtlMs?: number, imageDir?: string }} FeishuConfig
 */

/** @typedef {{ id: string, status: string, inbox: { nextTurn: unknown[], nextStep: unknown[] }, followup(message: object): void, cancel(cause: string): void }} HostAgent */

/**
 * The Cordis context as the DSH host actually presents it. `agents`,
 * `credentials`, `webServer` and `apiProxy` are host services declared by a
 * package this plugin does not depend on (they arrive through `inject`), and
 * the host also emits events outside cordis's own Events map. Declaring the
 * intersection here keeps every call site honest without pretending the whole
 * context is `any`.
 * @typedef {import('@deepseek-ai/cordis').Context & {
 *   agents: any,
 *   credentials: any,
 *   webServer: any,
 *   apiProxy: any,
 *   on(name: string, listener: (...args: any[]) => any): () => boolean,
 * }} DshContext
 */

/** @typedef {{ sessionId: string, chatId: string, chatName?: string, boundAt: number, lastInboundMessageId?: string, modelRoute?: { provider: string, model: string, reasoningEffort?: string } }} BindingRecord */

/**
 * One inbound Feishu message. This used to be a hand-written subset of the
 * SDK's shape, which drifted: it omitted `mentionAll` (read by the mention
 * policy) and could not satisfy ingestImages, which wants the real thing.
 * @typedef {import('@larksuite/channel').NormalizedMessage} InboundMessage
 */

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
 * The default hint sent to chats that have no bound session (locale-driven;
 * the entry-config hintText override still wins over it).
 * @param {import('./locales.js').LocaleDict} dict
 * @returns {string}
 */
function defaultHint(dict) {
  return dict.hintUnbound
}

/**
 * Help text for the Feishu command channel (locale-driven).
 * @param {import('./locales.js').LocaleDict} dict
 * @returns {string}
 */
function helpText(dict) {
  return [
    dict.helpTitle,
    dict.helpModel,
    dict.helpModelList,
    dict.helpModelUse,
    dict.helpModelEffort,
    dict.helpStatus,
    dict.helpStop,
    dict.helpHelp,
  ].join('\n')
}

/** @param {string} template @param {Record<string, string | number>} [params] */
function fill(template, params) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
}

/**
 * Apply the plugin to its Cordis context.
 * @param {DshContext} ctx - agents + webServer + apiProxy ready.
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
  // Runtime-adjustable settings: entry config provides the base values; the
  // bindings file (settings page) overrides them; POST /feishu/config mutates
  // both the persisted settings and these live values.
  let output = config.output === 'plain' ? 'plain' : 'stream'
  let showImages = config.showImages !== false
  let maxHeldImages = typeof config.maxHeldImages === 'number' && config.maxHeldImages > 0 ? config.maxHeldImages : 10
  let maxHeldImageBytes = typeof config.maxHeldImageBytes === 'number' && config.maxHeldImageBytes > 0 ? config.maxHeldImageBytes : 10 * 1024 * 1024
  let holdTtlMs = typeof config.holdTtlMs === 'number' && config.holdTtlMs >= 0 ? config.holdTtlMs : 0
  // Feishu-facing copy: follows the locale the client reports (host-driven);
  // defaults to zh (the plugin's historical language). `hintText` from the
  // entry config still overrides the locale default for unbound chats.
  /** @type {import('./locales.js').LocaleDict} */
  let ui = zhCopy
  const configuredHint = typeof config.hintText === 'string' && config.hintText !== '' ? config.hintText : undefined
  let hintText = configuredHint ?? defaultHint(ui)

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
        ctx.logger.warn('feishu: credential resolve %s failed: %s', name, errText(error))
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
  /**
   * Log a warning that must be visible even without a logger printer: the
   * default web profile composes none, so these would vanish otherwise.
   * @param {string} line
   */
  const warnLoud = (line) => {
    ctx.logger.warn(line)
    process.stderr.write(line + '\n')
  }

  const store = new BindingStore(bindingsFile, (line) => {
    ctx.logger.info(line)
    // Mirrored for the same reason as warnLoud, at info level.
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
    if (store.settingsHas('locale')) {
      ui = dictFor(persisted.locale)
      if (configuredHint === undefined) hintText = defaultHint(ui)
    }
  }

  /** Last forced repair pass, for the rate limit on POST /feishu/repair-logs. */
  let lastForcedRepairAt = 0
  const FORCED_REPAIR_COOLDOWN_MS = 60_000

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
   *
   * Incremental skip: the fingerprint of every scanned log is remembered in
   * `$DSH_HOME/feishu-repair-state.json`; a boot pass only re-decodes logs
   * whose mtime/size changed since the last pass (a full scan of a large
   * history on every boot is wasted work). A skipped log is not re-indexed
   * either — that would re-decode the artifact the fingerprint just declared
   * unchanged, which is exactly the work the skip exists to avoid. `force`
   * (the manual endpoint) bypasses both and is how an evicted image index is
   * rebuilt; it is rate-limited because the pass blocks the whole process.
   * @param {{ force?: boolean }} [options]
   */
  const repairHistoricalLogs = (options) => {
    const sessionsRoot = join(dshHome, 'sessions')
    // Every session directory under the sessions root, bound or not — an
    // unbound historical session can carry the same log defects (foreign
    // events, seq conflicts) and must be repaired too. Non-live only.
    const ids = new Set()
    try {
      for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!project.isDirectory()) continue
        for (const session of readdirSync(join(sessionsRoot, project.name), { withFileTypes: true })) {
          if (session.isDirectory()) ids.add(session.name)
        }
      }
    } catch {
      // sessions root unreadable: fall back to bound/pending sessions.
    }
    if (ids.size === 0) {
      const status = store.status()
      for (const record of status.bindings) ids.add(record.sessionId)
      for (const entry of status.pending) ids.add(entry.sessionId)
    }
    const force = options?.force === true
    const stateFile = join(dshHome, 'feishu-repair-state.json')
    /** @type {Record<string, { mtimeMs: number, size: number }>} */
    let known = {}
    try { known = JSON.parse(readFileSync(stateFile, 'utf8')) } catch { /* first run or unreadable */ }
    const next = {}
    let repaired = 0
    let failed = 0
    let skipped = 0
    for (const id of ids) {
      if (ctx.agents.get(id) !== undefined) continue // live: history reads from memory, log is being written
      const path = findLogFile(sessionsRoot, id)
      if (path === undefined) continue
      // Incremental skip: unchanged artifact -> no re-decode needed.
      let stat
      try { stat = statSync(path) } catch { continue }
      if (!force && known[id] !== undefined && known[id].mtimeMs === stat.mtimeMs && known[id].size === stat.size) {
        skipped += 1
        next[id] = known[id]
        // Do NOT re-index here: reindexHistoricalImages re-reads and decodes
        // the very artifact the fingerprint just declared unchanged, so the
        // "skip" saved nothing for bound sessions. An index rebuilt from an
        // unchanged log cannot have changed either; POST /feishu/repair-logs
        // (force) is the way to rebuild after an index eviction.
        continue
      }
      const result = repairSessionLog(sessionsRoot, id)
      next[id] = { mtimeMs: stat.mtimeMs, size: stat.size }
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
    try { writeFileSync(stateFile, JSON.stringify(next, null, 2), 'utf8') } catch { /* best effort */ }
    if (repaired > 0 || failed > 0 || skipped > 0) {
      ctx.logger.info('feishu: log repair pass finished (%d repaired, %d failed, %d unchanged)', repaired, failed, skipped)
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
      : cwd === undefined ? undefined : join(cwd, STAGE_DIR_NAME)
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
  // backend writer can race the repair's atomic rewrite). Cleared on teardown.
  const repairTimer = setTimeout(() => {
    try {
      repairHistoricalLogs()
    } catch (error) {
      ctx.logger.warn('feishu: boot log repair failed: %s', errText(error))
    }
  }, 3000)
  ctx.effect(() => () => clearTimeout(repairTimer), 'dsh-fschannel: boot repair timer')
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
    if (channel === undefined) return { note: ui.botNotConnected }
    try {
      const { buffer, contentType } = await channel.downloadResourceWithMeta(msg.messageId, resource.fileKey, 'image')
      const verdict = validateImage(buffer, contentType, resource.fileName, maxHeldImageBytes)
      if (verdict.ok !== true) return { note: verdict.reason }
      const name = `feishu-${randomUUID()}.${extFor(verdict.mediaType)}`
      const path = join(dir, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, buffer)
      return { file: { path, name: resource.fileName, bytes: buffer.byteLength, mediaType: verdict.mediaType } }
    } catch (error) {
      ctx.logger.warn('feishu: image download failed: %s', errText(error))
      return { note: ui.imageDownloadFailed }
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
    const dir = imageDirOverride !== undefined ? imageDirOverride : cwd === undefined ? undefined : join(cwd, STAGE_DIR_NAME)
    if (dir === undefined) {
      notes.push(ui.imageNoWorkspace)
      return { text: msg.content, held: 0, notes }
    }
    // Pruned files are in the durable index too, so de-index as well as
    // delete — otherwise the gallery lists entries whose bytes are gone and
    // nothing ever cleans those rows up.
    for (const pruned of heldImages.prune(holdTtlMs)) {
      try { rmSync(pruned.path, { force: true }) } catch { /* best effort */ }
      // The index key is the STAGED basename (see indexImage), not the
      // sender's original file name — which is what pruned.name carries, and
      // which Feishu usually omits entirely. Passing the wrong one made this
      // de-index a silent no-op for its whole existence.
      const owner = store.getByChat(pruned.chatId)
      if (owner !== undefined) store.removeImage(owner.sessionId, basename(pruned.path))
    }
    let held = 0
    for (const resource of images) {
      if (heldImages.list(record.chatId).length + held >= maxHeldImages) {
        notes.push(fill(ui.imageTooMany, { max: maxHeldImages }))
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
  /** @type {Map<string, { chatId: string, feishuMessageId: string, at: number }>} dsh message id -> chat + Feishu message */
  const pendingReactions = new Map()
  /** How long an unanswered pending reaction is kept before it is swept. */
  const PENDING_REACTION_TTL_MS = 60 * 60 * 1000
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
      warnLoud(`feishu: addReaction(${messageId}, ${emoji}) failed: ${errText(error)}`)
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
      warnLoud(`feishu: swapReaction(${messageId}, ${from}->${to}) failed: ${errText(error)}`)
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
      ctx.logger.warn('feishu: card send failed (retrying plain): %s', errText(error))
      try {
        await channel.send(chatId, { card }, {})
      } catch (retryError) {
        ctx.logger.warn('feishu: card send failed: %s', errText(retryError))
      }
    }
  }

  /**
   * A port for when the transport is not connected. send() and sendCard()
   * both guard on `channel === undefined`; openStream did not, so a turn
   * streaming while disconnected threw out of the session-event handler
   * instead of degrading. Rejecting here routes it into StreamHandle's
   * existing failure arm, which falls back to a plain message — the same path
   * a missing cardkit permission takes.
   */
  const CLOSED_PORT = { stream: () => Promise.reject(new Error('feishu: transport not connected')) }

  /** @param {string} chatId @param {object | undefined} opts @param {(err: unknown) => void} onFailure */
  const openStream = (chatId, opts, onFailure) =>
    new StreamHandle(channel ?? CLOSED_PORT, chatId, opts, onFailure, ui.streamPlaceholder)

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
      ctx.logger.warn('feishu: cannot resume session %s: %s', sessionId, errText(error))
      return undefined
    }
  }

  /**
   * Replay a persisted model route onto a live agent (per-session durability).
   * @param {BindingRecord | undefined} record
   * @returns {Promise<void>}
   */
  const replayModelRoute = async (record) => {
    if (record === undefined || api === undefined) return
    const route = record.modelRoute
    if (route === undefined) return
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

  /**
   * Read the model directory for a session.
   * A rejection here used to propagate to the top-level inbound catch, which
   * logs and drops it — the user's /model got no reply at all. Report the
   * transport failure instead, distinct from "the session is gone".
   * @param {string} sessionId
   */
  const readModels = async (sessionId) => {
    if (api === undefined) return undefined
    try {
      const res = await api.sessions.models({ rpcId: `feishu-${randomUUID()}`, payload: { sessionId } })
      return res.result?.ok === true ? res.result.value : undefined
    } catch (error) {
      ctx.logger.warn('feishu: model directory read failed for %s: %s', sessionId, errText(error))
      return undefined
    }
  }

  /** @param {{ provider: string, model: string, reasoningEffort?: string }} selection */
  const applySelection = async (record, selection) => {
    if (api === undefined) return ui.modelServiceUnavailable
    let res
    try {
      res = await api.sessions.selectModel({
        rpcId: `feishu-${randomUUID()}`,
        payload: {
          sessionId: record.sessionId,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        },
      })
    } catch (error) {
      // Without this the rejection reaches the inbound catch, which logs and
      // drops it, and the user's /model use never gets an answer.
      const message = errText(error)
      ctx.logger.warn('feishu: model switch failed for %s: %s', record.sessionId, message)
      return fill(ui.modelSwitchFailed, { message })
    }
    if (res.result?.ok !== true) {
      // A template carrying its own {message} placeholder must never be used
      // as the fallback for that placeholder — it double-prefixes.
      const message = res.result?.error?.message ?? ui.modelSwitchUnknownError
      return fill(ui.modelSwitchFailed, { message })
    }
    const selected = res.result.value.selected
    const saved = {
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
    store.setModelRoute(record.sessionId, saved)
    const effort = saved.reasoningEffort === undefined ? ui.effortDefault : saved.reasoningEffort
    return fill(ui.modelSwitched, { provider: saved.provider, model: saved.model, effort })
  }

  /** @param {BindingRecord} record @param {string[]} args @param {string} replyTo */
  const handleModelCommand = async (record, args, replyTo) => {
    const sessionId = record.sessionId
    const sub = args[0]
    if (sub === 'list' || sub === 'ls') {
      const directory = await readModels(sessionId)
      if (directory === undefined) {
        await send(record.chatId, ui.modelUnavailable, replyTo)
        return
      }
      const lines = [ui.modelDirectoryTitle]
      for (const group of directory.groups ?? []) {
        const modelRows = (group.models ?? []).map((model) => {
          const efforts = model.reasoning?.efforts?.map((e) => e.id).join('/') ?? ''
          return `  · ${group.id}/${model.id}${efforts === '' ? '' : fill(ui.modelEffortList, { efforts })}`
        })
        lines.push(fill(ui.groupLabel, { name: group.name, id: group.id }), ...modelRows)
      }
      await send(record.chatId, lines.join('\n'), replyTo)
      return
    }
    if (sub === 'use') {
      const raw = (args[1] ?? '').trim()
      if (raw === '') {
        await send(record.chatId, ui.modelUseUsage, replyTo)
        return
      }
      const directory = await readModels(sessionId)
      const currentProvider = directory?.current?.provider
      const separator = raw.indexOf('/')
      const provider = separator > 0 ? raw.slice(0, separator) : currentProvider
      const model = separator > 0 ? raw.slice(separator + 1) : raw
      if (provider === undefined || provider === '') {
        await send(record.chatId, ui.modelUnknownProvider, replyTo)
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
        await send(record.chatId, ui.modelUnavailable, replyTo)
        return
      }
      const current = directory.current
      if (level === '') {
        const model = (directory.groups ?? []).flatMap((g) => g.models ?? []).find((m) => m.id === current.model)
        const efforts = model?.reasoning?.efforts?.map((e) => e.id).join('/') ?? 'off/high/max'
        await send(record.chatId, fill(ui.modelEffortUsage, { efforts, current: current.reasoningEffort ?? ui.effortDefault }), replyTo)
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
      await send(record.chatId, ui.modelUnavailable, replyTo)
      return
    }
    const current = directory.current
    const effort = current.reasoningEffort === undefined ? ui.effortDefault : current.reasoningEffort
    await send(record.chatId, fill(ui.modelCurrent, { provider: current.provider, model: current.model, effort }), replyTo)
  }

  /**
   * Publish (or refresh) the interactive model settings card for a bound session.
   * @param {BindingRecord} record
   * @param {object} [fresh] - already-known directory value, to avoid a refetch.
   * @returns {Promise<Record<string, unknown> | undefined>} the card object, or undefined when the session is unusable.
   */
  const buildSettingsCard = async (record, fresh) => {
    if (fresh === undefined) await getLiveAgent(record.sessionId)
    const directory = fresh ?? (await readModels(record.sessionId))
    if (directory === undefined || directory.current === undefined) return undefined
    return buildModelCard({
      sessionId: record.sessionId,
      current: directory.current,
      groups: directory.groups ?? [],
      dict: ui,
    })
  }

  /**
   * Publish the settings card, or explain why it is unavailable. Both trigger
   * paths (`/model` with no args, and the natural-language intent) need the
   * same two branches.
   * @param {BindingRecord} record
   * @param {string} chatId
   * @param {string} [replyTo] - trigger message id for reply placement.
   */
  const sendSettingsCard = async (record, chatId, replyTo) => {
    const card = await buildSettingsCard(record)
    if (card === undefined) await send(chatId, ui.modelUnavailable, replyTo)
    else await sendCard(chatId, card, replyTo)
  }

  /** @param {BindingRecord} record @param {string} replyTo */
  const handleStatusCommand = async (record, replyTo) => {
    const directory = await readModels(record.sessionId)
    const effort = directory?.current?.reasoningEffort ?? ui.effortDefault
    const modelLine = directory?.current === undefined
      ? ui.statusModelUnknown
      : fill(ui.statusModel, {
        model: `${directory.current.provider}/${directory.current.model}` + fill(ui.effortSuffix, { effort }),
      })
    const lines = [
      ui.statusTitle,
      fill(ui.statusBot, { state: status.connected ? ui.statusBotConnected : ui.statusBotDisconnected }),
      fill(ui.statusSession, {
        session: record.sessionId.slice(0, 8) + '…',
        chat: record.chatName === undefined ? '' : fill(ui.chatSuffix, { chat: record.chatName }),
      }),
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
      await send(record.chatId, ui.sessionUnavailable, replyTo)
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
      // Entries are normally removed by turn/end, but a turn that never ends
      // (agent crash, process-level cancel, session removed mid-turn) would
      // leak its entry for good — and a stale one used to be handed to the
      // FIFO fallback and misapplied to an unrelated turn. Sweep on insert.
      const staleBefore = Date.now() - PENDING_REACTION_TTL_MS
      for (const [id, info] of pendingReactions) {
        if (info.at < staleBefore) pendingReactions.delete(id)
      }
      for (const [turn, id] of claimedByTurn) {
        if (!pendingReactions.has(id)) claimedByTurn.delete(turn)
      }
      // Keyed by the DSH message id (what agent/inbox/claimed reports); the
      // Feishu message id is what reactions actually target.
      pendingReactions.set(dshMessageId, { chatId: record.chatId, feishuMessageId: replyTo, at: Date.now() })
      void addReaction(replyTo, reactReceived)
    }
    if (wasRunning || pendingBefore > 0) {
      if (queueAck) {
        await send(record.chatId, fill(ui.queueAck, { n: pendingBefore }), replyTo)
      }
    } else if (ackInbound) {
      await send(record.chatId, ui.ackInbound, replyTo)
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
          await send(msg.chatId, helpText(ui), msg.messageId)
        } else if (command === 'model') {
          if (args.length === 0) {
            await sendSettingsCard(record, msg.chatId, msg.messageId)
          } else {
            await handleModelCommand(record, args, msg.messageId)
          }
        } else if (command === 'status') {
          await handleStatusCommand(record, msg.messageId)
        } else if (command === 'stop') {
          const agent = ctx.agents.get(record.sessionId)
          if (agent !== undefined) {
            agent.cancel('user')
            await send(msg.chatId, ui.stopped, msg.messageId)
          } else {
            await send(msg.chatId, ui.notRunning, msg.messageId)
          }
        } else {
          await send(msg.chatId, fill(ui.unknownCommand, { command, help: helpText(ui) }), msg.messageId)
        }
        return
      }
      if (modelCardTriggers && (MODEL_CARD_INTENT.test(line) || isBareKeyword(line))) {
        await sendSettingsCard(record, msg.chatId, msg.messageId)
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
        const note = fill(ui.noteWrap, { notes: ingested.notes.join(ui.noteSeparator) })
        await send(msg.chatId, note, msg.messageId)
      }
      const hasText = textWithoutImageMarkup(ingested.text) !== ''
      if (hasText) {
        const held = heldImages.take(record.chatId)
        const combined = held.length > 0
          ? `${ingested.text}\n\n${composeImageNote(held, ui)}`
          : ingested.text
        await deliver(record, combined, msg.messageId)
        return
      }
      // Image-only: hold and acknowledge; processing waits for the text.
      if (holdHint && ingested.held > 0) {
        await send(msg.chatId, fill(ui.imageHeld, { n: ingested.held }), msg.messageId)
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
        fill(ui.boundTo, { session: pendingSessionId.slice(0, 8), help: helpText(ui) }),
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
      // The SDK's generated types for chat.get describe neither this params
      // shape nor `data.chat`, though both are what the API takes and returns.
      const response = await /** @type {any} */ (raw).im.chat.get({ params: { chat_id: chatId } })
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
    // The TTL was only consulted on read, so an entry was never removed: one
    // per group chat ever seen, kept for the process lifetime. Sweep expired
    // entries on each miss — this map is small and touched rarely.
    const now = Date.now()
    for (const [key, value] of singleMemberCache) {
      if (now - value.at >= SINGLE_MEMBER_TTL_MS) singleMemberCache.delete(key)
    }
    const cached = singleMemberCache.get(chatId)
    if (cached !== undefined && now - cached.at < SINGLE_MEMBER_TTL_MS) return cached.single
    let single = false
    if (channel !== undefined) {
      try {
        const members = await channel.getChatMembers(chatId)
        single = members.length <= 1
      } catch (error) {
        ctx.logger.warn('feishu: member lookup failed for %s: %s', chatId, errText(error))
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
      warnLoud(`feishu: outbound failed for ${record.chatId}: ${errText(error)}`)
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
        const line = name === '' ? '> ' + ui.toolCallingUnknown : '> ' + fill(ui.toolCalling, { name })
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
            // FIFO fallback, but only when it cannot misattribute: with more
            // than one pending reaction in this chat, a turn driven from the
            // Web UI (which emits no agent/inbox/claimed for a Feishu message)
            // would consume and swap an unrelated message's reaction.
            const candidates = []
            for (const [id, info] of pendingReactions) {
              if (info.chatId === record.chatId) candidates.push(id)
              if (candidates.length > 1) break
            }
            if (candidates.length === 1) claimedId = candidates[0]
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
            const failed = fill(ui.taskFailed, { detail: detail === '' ? '' : fill(ui.detailSuffix, { detail }) })
            finalText = finalText === '' ? failed : `${finalText}\n\n${failed}`
          } else if (finalText === '') {
            finalText = ui.noOutput
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
              ctx.logger.warn('feishu: structured final card rejected, falling back: %s', errText(error))
              try {
                await channel.updateCard(messageId, renderPlainCard(finalText))
              } catch (secondError) {
                ctx.logger.warn('feishu: final card update failed: %s', errText(secondError))
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
          void send(record.chatId, fill(ui.taskFailed, { detail: detail === '' ? '' : fill(ui.detailSuffix, { detail }) }), replyTo).catch(fail)
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
   * @returns {Promise<Record<string, unknown> | undefined>} the callback response (toast + card).
   */
  const handleCardAction = async (evt) => {
    const value = parseActionValue(evt.action.value)
    if (value === undefined) return undefined
    const record = store.getBySession(value.sessionId)
    if (record === undefined || record.chatId !== evt.chatId) {
      return { toast: { type: 'info', content: ui.cardUnbound } }
    }
    if (api === undefined) {
      return { toast: { type: 'error', content: ui.modelServiceUnavailable } }
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
        const message = res.result?.error?.message ?? ui.modelSwitchUnknownError
        return { toast: { type: 'error', content: fill(ui.modelSwitchFailed, { message }).slice(0, 200) } }
      }
      const selected = res.result.value.selected
      const saved = {
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
      }
      store.setModelRoute(value.sessionId, saved)
      const switched = fill(ui.cardSwitched, { model: saved.model, effort: saved.reasoningEffort ?? ui.effortDefault })
      // Rebuild the card with the fresh selection; the current model row and
      // effort row highlight the active choices.
      const card = await buildSettingsCard(record)
      if (card === undefined) {
        return {
          toast: { type: 'success', content: switched },
        }
      }
      return {
        toast: { type: 'success', content: switched },
        card: { type: 'raw', data: card },
      }
    } catch (error) {
      ctx.logger.warn('feishu: card action failed: %s', errText(error))
      return { toast: { type: 'error', content: ui.cardFailed } }
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
    // Clear the last failure too. It was only cleared on a successful connect,
    // so after an explicit disconnect /feishu/status kept serving a reason that
    // no longer applied alongside connected:false.
    status.reason = undefined
    if (old === undefined) return
    try {
      await old.disconnect()
    } catch (error) {
      ctx.logger.warn('feishu: disconnect failed: %s', errText(error))
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
        ctx.logger.error('feishu: inbound handling failed: %s', errText(error))
      }) })
      channel.on('cardAction', (evt) => handleCardAction(evt))
      channel.on('error', (error) => {
        status.connected = false
        ctx.logger.error('feishu: transport error: %s', errText(error))
      })
      channel.on('reconnecting', () => { status.connected = false })
      channel.on('reconnected', () => { status.connected = true })
      try {
        await channel.connect()
        if (active) status.connected = true
        status.reason = undefined
        // Masked like every other appId on the HTTP surface: this line lands
        // in web.stdout.log, which is not a secret store.
        ctx.logger.info('feishu: bot connected (app %s, output %s, source %s)', maskSecret(credentials.appId), output, credentials.source)
      } catch (error) {
        status.connected = false
        status.reason = errText(error)
        ctx.logger.error('feishu: connect failed: %s', status.reason)
      }
    }
    // Serialize through a promise chain; a rejected run must not break the
    // chain for later calls (both arms forward to run).
    connectChain = connectChain.then(run, run)
    return connectChain
  }

  void connect()

  // Teardown on plugin unload. Registered here, after every long-lived
  // structure exists, so one disposer covers the whole runtime state.
  //
  // The transport half matters most: without it the old WebSocket and its
  // message/cardAction listeners outlive the reload, and the reloaded
  // instance opens a SECOND channel with the same appId. Feishu then delivers
  // every inbound message to both, and the SDK's dedup is per-channel so it
  // cannot collapse them.
  ctx.effect(() => () => {
    void disconnect()
    for (const entry of streams.values()) {
      void entry.handle.finish().catch(() => { /* teardown is best effort */ })
    }
    streams.clear()
    pendingReactions.clear()
    claimedByTurn.clear()
    singleMemberCache.clear()
  }, 'dsh-fschannel: teardown')

  // ── HTTP API (loopback only) ────────────────────────────────────────────

  const isLoopback = (req) => {
    const address = req.socket?.remoteAddress ?? ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  /** Methods that cannot change state, so they need no CSRF guard. */
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

  /**
   * Whether a state-changing request may proceed.
   *
   * The loopback check blocks remote callers, but any page in any browser can
   * still issue a CORS *simple request* to 127.0.0.1 — no preflight, response
   * unreadable to the attacker, yet the write lands. The writable state here
   * includes the Feishu credentials (POST /feishu/config), so a drive-by page
   * could repoint the bot at an attacker-controlled app. Enforce the
   * same-origin property the module docstring already claims: the request must
   * either carry no Origin (curl, scripts, the ops endpoints) or one whose host
   * is this server. `Origin: null` — sandboxed iframes, file:// pages — is not
   * a same origin and is rejected.
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  const isSameOrigin = (req) => {
    const origin = req.headers.origin
    if (origin === undefined || origin === '') return true
    if (origin === 'null') return false
    let host
    try { host = new URL(origin).host } catch { return false }
    if (host === req.headers.host) return true
    // The GUI may address the server as 127.0.0.1 while Host reads localhost
    // (or vice versa); both are this machine, so accept either spelling.
    const hostname = host.replace(/:\d+$/, '')
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
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
        // Bounded: an upstream message can be arbitrarily long and may carry
        // backend context that has no business in an HTTP response body.
        ctx.logger.warn('feishu: credential describe %s failed: %s', ref, errText(error))
        return { configured: false, writable: true, error: errText(error).slice(0, 200) }
      }
    }
    const appId = await describe('FEISHU_APP_ID')
    const appSecret = await describe('FEISHU_APP_SECRET')
    return {
      appId: { ...appId, ...(credentials.appId === '' ? {} : { masked: maskSecret(credentials.appId) }) },
      appSecret: { ...appSecret },
    }
  }

  /**
   * Staged image names: feishu-<uuid>.<ext>. The extension set is derived from
   * the image type table rather than repeated, so it cannot drift from what
   * extFor() actually writes to disk.
   */
  const STAGED_NAME = new RegExp(`^feishu-[0-9a-f-]+\\.(${STAGED_EXTENSIONS.join('|')})$`, 'i')
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
      // Confine the indexed path too. It comes from the bindings file, which
      // any local process can replace wholesale; without this an edited index
      // turns this route into an arbitrary local file read.
      const parent = dirname(indexed)
      const confined = imageDirOverride !== undefined
        ? relative(imageDirOverride, parent) === ''
        : basename(parent) === STAGE_DIR_NAME
      if (!confined) return undefined
      return existsSync(indexed) ? indexed : undefined
    }
    const agent = ctx.agents.get(sessionId)
    const cwd = agent?.session?.header?.cwd
    const dir = imageDirOverride !== undefined
      ? imageDirOverride
      : typeof cwd === 'string' && cwd !== '' ? join(cwd, STAGE_DIR_NAME) : undefined
    if (dir === undefined) return undefined
    const file = join(dir, name)
    const rel = relative(dir, file)
    if (rel === '' || rel.startsWith('..') || rel.includes('..\\') || rel.includes('../')) return undefined
    return existsSync(file) ? file : undefined
  }

  /**
   * The settings view shared by GET and POST /feishu/config. It used to be the
   * same object literal written twice, and the two copies had already drifted
   * in lockstep: both omitted `locale`, so the client could write the language
   * but never read back what the host believed.
   * @returns {Promise<object>}
   */
  const configPayload = async () => ({
    autoBindNewSession: store.settings.autoBindNewSession,
    output,
    showImages,
    holdTtlSeconds: Math.round(holdTtlMs / 1000),
    maxHeldImages,
    maxHeldImageBytes: Math.round(maxHeldImageBytes / (1024 * 1024) * 10) / 10,
    locale: store.settings.locale,
    credentials: await credentialStatus(),
  })

  const handleRoute = async (req, res) => {
    if (!isLoopback(req)) {
      json(res, 403, { ok: false, error: 'loopback only' })
      return
    }
    const method = req.method ?? 'GET'
    if (!SAFE_METHODS.has(method)) {
      if (!isSameOrigin(req)) {
        json(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
      // A CORS simple request cannot set application/json without a preflight,
      // so this is a second, independent barrier. Only bodies are checked: the
      // ops endpoints accept an empty POST.
      const hasBody = (req.headers['content-length'] ?? '0') !== '0' || req.headers['transfer-encoding'] !== undefined
      const contentType = req.headers['content-type'] ?? ''
      if (hasBody && !contentType.toLowerCase().startsWith('application/json')) {
        json(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    try {
      if (path === '/feishu/status' && req.method === 'GET') {
        json(res, 200, {
          ok: true,
          connected: status.connected,
          // Was a hard-coded `true`, so the row reported "configured" even
          // when both credentials were empty and the log had already said
          // "no app credentials".
          configured: credentials.appId !== '' && credentials.appSecret !== '',
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
        json(res, 200, { ok: true, ...(await configPayload()) })
        return
      }
      if (path === '/feishu/config' && req.method === 'POST') {
        const body = await readBody(req)
        // Validate everything first, collect one patch, persist once. Seven
        // separate setSettings calls meant seven full-document rewrites per
        // request — seven chances for a concurrent writer to interleave — and
        // a request that failed validation halfway had already persisted the
        // fields before it.
        /** @type {Record<string, unknown>} */
        const patch = {}
        if (typeof body.autoBindNewSession === 'boolean') {
          patch.autoBindNewSession = body.autoBindNewSession
        }
        if (body.output !== undefined) {
          if (body.output !== 'stream' && body.output !== 'plain') {
            json(res, 400, { ok: false, code: 'invalidOutput', error: 'output must be stream or plain' })
            return
          }
          patch.output = body.output
        }
        if (body.showImages !== undefined) {
          if (typeof body.showImages !== 'boolean') {
            json(res, 400, { ok: false, code: 'invalidShowImages', error: 'showImages must be a boolean' })
            return
          }
          patch.showImages = body.showImages
        }
        if (body.holdTtlSeconds !== undefined) {
          const seconds = Number(body.holdTtlSeconds)
          if (!Number.isInteger(seconds) || seconds < 0) {
            json(res, 400, { ok: false, code: 'invalidHoldTtl', error: 'holdTtlSeconds must be an integer >= 0 (seconds)' })
            return
          }
          patch.holdTtlSeconds = seconds
        }
        if (body.maxHeldImages !== undefined) {
          const count = Number(body.maxHeldImages)
          if (!Number.isInteger(count) || count < 1) {
            json(res, 400, { ok: false, code: 'invalidMaxHeldImages', error: 'maxHeldImages must be an integer >= 1' })
            return
          }
          patch.maxHeldImages = count
        }
        if (body.maxHeldImageBytes !== undefined) {
          const mb = Number(body.maxHeldImageBytes)
          if (!Number.isFinite(mb) || mb < 0.001 || mb > 1024) {
            json(res, 400, { ok: false, code: 'invalidMaxHeldImageBytes', error: 'maxHeldImageBytes must be between 0.001 and 1024 MB' })
            return
          }
          patch.maxHeldImageBytes = mb
        }
        // Locale: the client reports the host's active language; the transport
        // copy follows it (zh default when absent/unknown).
        if (body.locale !== undefined) {
          if (body.locale !== 'zh' && body.locale !== 'en') {
            json(res, 400, { ok: false, code: 'invalidLocale', error: 'locale must be zh or en' })
            return
          }
          patch.locale = body.locale
        }
        if (Object.keys(patch).length > 0) store.setSettings(patch)
        // Mirror the accepted values into the live closure copies the running
        // transport actually reads.
        if (patch.output !== undefined) output = /** @type {string} */ (patch.output)
        if (patch.showImages !== undefined) showImages = /** @type {boolean} */ (patch.showImages)
        if (patch.holdTtlSeconds !== undefined) holdTtlMs = /** @type {number} */ (patch.holdTtlSeconds) * 1000
        if (patch.maxHeldImages !== undefined) maxHeldImages = /** @type {number} */ (patch.maxHeldImages)
        if (patch.maxHeldImageBytes !== undefined) maxHeldImageBytes = Math.round(/** @type {number} */ (patch.maxHeldImageBytes) * 1024 * 1024)
        if (patch.locale !== undefined) {
          ui = dictFor(/** @type {string} */ (patch.locale))
          if (configuredHint === undefined) hintText = defaultHint(ui)
        }
        // Credentials: blank/absent means no change; the secret is never echoed.
        let credentialChanged = false
        if (typeof body.appId === 'string' && body.appId.trim() !== '') {
          try {
            await ctx.credentials.set('FEISHU_APP_ID', body.appId.trim())
            credentialChanged = true
          } catch (error) {
            json(res, 400, { ok: false, code: 'appIdSaveFailed', detail: errText(error), error: `appId save failed: ${errText(error)}` })
            return
          }
        }
        if (typeof body.appSecret === 'string' && body.appSecret.trim() !== '') {
          try {
            await ctx.credentials.set('FEISHU_APP_SECRET', body.appSecret.trim())
            credentialChanged = true
          } catch (error) {
            json(res, 400, { ok: false, code: 'appSecretSaveFailed', detail: errText(error), error: `appSecret save failed: ${errText(error)}` })
            return
          }
        }
        if (credentialChanged) {
          const before = credentials
          await refreshCredentials()
          if (credentials.appId !== before.appId || credentials.appSecret !== before.appSecret) {
            void connect().catch((error) => {
              ctx.logger.warn('feishu: reconnect after credential change failed: %s', errText(error))
            })
          }
        }
        json(res, 200, { ok: true, ...(await configPayload()) })
        return
      }
      if (path.startsWith('/feishu/images/') && req.method === 'GET') {
        const sessionId = decodeURIComponent(path.slice('/feishu/images/'.length))
        if (!SESSION_ID.test(sessionId)) {
          json(res, 400, { ok: false, error: 'sessionId required' })
          return
        }
        const images = store.imagesList(sessionId)
        json(res, 200, { ok: true, sessionId, images })
        return
      }
      if (path.startsWith('/feishu/image/') && req.method === 'GET') {
        // Split first, decode after: the client percent-encodes each segment,
        // so decoding the whole tail up front turns an encoded %2F inside a
        // name back into a real separator and yields three parts (a 404 on a
        // legitimate request). The strict regexes in resolveImageFile are what
        // stop traversal; this order is about correctness.
        const parts = path.slice('/feishu/image/'.length).split('/').map((part) => {
          try { return decodeURIComponent(part) } catch { return part }
        })
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
            'content-type': contentTypeFor(parts[1]),
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
        // Dropping the map entry is not enough: an unfinished StreamHandle
        // parks its producer on a `wake` promise nobody will ever resolve, so
        // port.stream() never settles and the frame leaks for the process
        // lifetime. The turn/end path already finishes; this one did not.
        const live = streams.get(sessionId)
        if (live !== undefined) {
          streams.delete(sessionId)
          void live.handle.finish().catch(() => { /* teardown is best effort */ })
        }
        json(res, 200, { ok: true, removed })
        return
      }
      if (path === '/feishu/repair-logs' && req.method === 'POST') {
        // Manual re-run of the boot repair (e.g. after upgrading the plugin
        // while the harness stayed up). Only non-live sessions are touched.
        //
        // A forced pass is fully synchronous and re-decodes EVERY session log,
        // which blocks the whole harness — agents, web server and the Feishu
        // transport all stall for its duration. Rate-limit it so repeated
        // POSTs cannot stack into an arbitrarily long freeze.
        const sinceLast = Date.now() - lastForcedRepairAt
        if (sinceLast < FORCED_REPAIR_COOLDOWN_MS) {
          const retryAfterMs = FORCED_REPAIR_COOLDOWN_MS - sinceLast
          res.setHeader('retry-after', String(Math.ceil(retryAfterMs / 1000)))
          json(res, 429, { ok: false, error: 'a forced repair ran recently', retryAfterMs })
          return
        }
        lastForcedRepairAt = Date.now()
        try {
          repairHistoricalLogs({ force: true })
        } catch (error) {
          json(res, 500, { ok: false, error: errText(error) })
          return
        }
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      json(res, 400, { ok: false, error: errText(error) })
    }
  }

  const unregister = ctx.webServer.register({ kind: 'prefix', path: '/feishu', handler: handleRoute })
  ctx.effect(() => unregister, 'dsh-fschannel: /feishu routes')
}
