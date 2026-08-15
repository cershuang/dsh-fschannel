// @ts-check
/**
 * Durable chat↔session binding store. One session binds at most one chat and
 * one chat binds at most one session: a new bind on either side replaces the
 * previous one. Pending sessions (chosen "connect Feishu" but not yet bound to
 * a chat) are served FIFO by the next inbound message.
 *
 * Persistence is a single JSON document, written atomically (tmp + rename) on
 * every mutation. The file is owned by this plugin; nothing else reads it.
 * @module dsh-fschannel/bindings
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * One live binding record.
 * @typedef {{
 *   sessionId: string
 *   chatId: string
 *   chatName?: string
 *   boundAt: number
 *   lastInboundMessageId?: string
 *   modelRoute?: { provider: string, model: string, reasoningEffort?: string }
 * }} BindingRecord
 */

/**
 * The binding store.
 */
export class BindingStore {
  /**
   * @param {string} file - JSON document path.
   * @param {(line: string) => void} log - operator log sink.
   */
  constructor(file, log) {
    this.file = file
    this.log = log
    /** @type {Map<string, BindingRecord>} sessionId -> record */
    this.bySession = new Map()
    /** @type {Map<string, string>} chatId -> sessionId */
    this.byChat = new Map()
    /** @type {Array<{ sessionId: string, at: number }>} pending session ids, FIFO */
    this.pending = []
    /**
     * Plugin settings. `output` is 'stream' | 'plain'; `showImages` toggles
     * in-session image nodes; `holdTtlSeconds` is the staged-image expiry in
     * seconds (0 = never); `maxHeldImages` is the per-chat cap; `maxHeldImageBytes`
     * is the per-image cap in MB.
     * @type {{ autoBindNewSession: boolean, output: string, showImages: boolean,
     *          holdTtlSeconds: number, maxHeldImages: number, maxHeldImageBytes: number }}
     */
    this.settings = {
      autoBindNewSession: false,
      output: 'stream',
      showImages: true,
      holdTtlSeconds: 0,
      maxHeldImages: 10,
      maxHeldImageBytes: 10,
    }
    /** Keys present in the persisted document (distinguishes explicit values from defaults). */
    /** @type {Set<string>} */
    this.persistedKeys = new Set()
    /**
     * Staged image index: sessionId -> [{ name, path, at }]. Lets the loopback
     * image route resolve a staged file WITHOUT the agent being live (the
     * session workspace is only reachable through the live agent header).
     * @type {Map<string, Array<{ name: string, path: string, at: number }>>}
     */
    this.images = new Map()
    this.load()
  }

  /** Per-session cap on indexed staged-image entries (oldest dropped first). */
  get maxImagesPerSession() {
    return 50
  }

  /** Read the JSON document if present. */
  load() {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const data = JSON.parse(raw)
      if (data && Array.isArray(data.bindings)) {
        for (const record of data.bindings) {
          if (typeof record?.sessionId === 'string' && typeof record?.chatId === 'string') {
            this.bySession.set(record.sessionId, record)
            this.byChat.set(record.chatId, record.sessionId)
          }
        }
      }
      if (data && Array.isArray(data.pending)) {
        // Accept both the legacy string form and the current { sessionId, at } shape.
        this.pending = []
        for (const entry of data.pending) {
          if (typeof entry === 'string') this.pending.push({ sessionId: entry, at: 0 })
          else if (entry !== null && typeof entry === 'object' && typeof entry.sessionId === 'string') {
            this.pending.push({ sessionId: entry.sessionId, at: typeof entry.at === 'number' ? entry.at : 0 })
          }
        }
      }
      if (data && typeof data.settings === 'object' && data.settings !== null) {
        const s = data.settings
        if (typeof s.autoBindNewSession === 'boolean') {
          this.settings.autoBindNewSession = s.autoBindNewSession
          this.persistedKeys.add('autoBindNewSession')
        }
        if (s.output === 'stream' || s.output === 'plain') {
          this.settings.output = s.output
          this.persistedKeys.add('output')
        }
        if (typeof s.showImages === 'boolean') {
          this.settings.showImages = s.showImages
          this.persistedKeys.add('showImages')
        }
        if (typeof s.holdTtlSeconds === 'number' && Number.isFinite(s.holdTtlSeconds) && s.holdTtlSeconds >= 0) {
          this.settings.holdTtlSeconds = s.holdTtlSeconds
          this.persistedKeys.add('holdTtlSeconds')
        }
        if (typeof s.maxHeldImages === 'number' && Number.isInteger(s.maxHeldImages) && s.maxHeldImages >= 1) {
          this.settings.maxHeldImages = s.maxHeldImages
          this.persistedKeys.add('maxHeldImages')
        }
        if (typeof s.maxHeldImageBytes === 'number' && Number.isFinite(s.maxHeldImageBytes) && s.maxHeldImageBytes >= 0.001) {
          this.settings.maxHeldImageBytes = s.maxHeldImageBytes
          this.persistedKeys.add('maxHeldImageBytes')
        }
      }
      if (data && typeof data.images === 'object' && data.images !== null) {
        for (const [sessionId, files] of Object.entries(data.images)) {
          if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(files)) continue
          const kept = files
            .filter((file) => file !== null && typeof file === 'object'
              && typeof file.name === 'string' && typeof file.path === 'string')
            .slice(-this.maxImagesPerSession)
          if (kept.length > 0) this.images.set(sessionId, kept)
        }
      }
    } catch {
      // First boot or a corrupt file: start empty. A corrupt file is reported
      // once so an operator can inspect it, then overwritten on next save.
      this.log(`feishu: no readable binding store at ${this.file}`)
    }
  }

  /** Persist the document atomically. */
  save() {
    const document = {
      bindings: [...this.bySession.values()],
      pending: this.pending,
      settings: this.settings,
      images: Object.fromEntries(this.images),
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(document, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.log(`feishu: failed to persist bindings: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Bind (or re-bind) a session to a chat. Replaces any existing binding on
   * either side and drops the session from pending.
   * @param {string} sessionId - the DSH session id.
   * @param {string} chatId - the Feishu chat id.
   * @param {string} [chatName] - display name when known.
   * @param {string} [lastInboundMessageId] - the message that triggered the bind.
   * @returns {BindingRecord} the new record.
   */
  bind(sessionId, chatId, chatName, lastInboundMessageId) {
    const previous = this.bySession.get(sessionId)
    if (previous !== undefined) {
      this.byChat.delete(previous.chatId)
    }
    const replaced = this.byChat.get(chatId)
    if (replaced !== undefined && replaced !== sessionId) {
      this.bySession.delete(replaced)
    }
    const record = {
      sessionId,
      chatId,
      boundAt: Date.now(),
      ...(typeof chatName === 'string' && chatName !== '' ? { chatName } : {}),
      ...(typeof lastInboundMessageId === 'string' ? { lastInboundMessageId } : {}),
    }
    this.bySession.set(sessionId, record)
    this.byChat.set(chatId, sessionId)
    this.pending = this.pending.filter((entry) => entry.sessionId !== sessionId)
    this.save()
    return record
  }

  /**
   * Remove the binding for one session (and its chat).
   * @param {string} sessionId - the session to unbind.
   * @returns {boolean} whether a binding was removed.
   */
  unbind(sessionId) {
    const record = this.bySession.get(sessionId)
    if (record === undefined) return false
    this.bySession.delete(sessionId)
    this.byChat.delete(record.chatId)
    this.pending = this.pending.filter((entry) => entry.sessionId !== sessionId)
    this.save()
    return true
  }

  /**
   * @param {string} chatId - the chat to look up.
   * @returns {BindingRecord | undefined} the record bound to that chat.
   */
  getByChat(chatId) {
    const sessionId = this.byChat.get(chatId)
    return sessionId === undefined ? undefined : this.bySession.get(sessionId)
  }

  /**
   * @param {string} sessionId - the session to look up.
   * @returns {BindingRecord | undefined} the record bound to that session.
   */
  getBySession(sessionId) {
    return this.bySession.get(sessionId)
  }

  /**
   * Record the latest inbound message id for reply threading.
   * @param {string} chatId - the chat the message arrived in.
   * @param {string} messageId - the inbound message id.
   */
  touchInbound(chatId, messageId) {
    const record = this.getByChat(chatId)
    if (record === undefined || record.lastInboundMessageId === messageId) return
    record.lastInboundMessageId = messageId
    this.save()
  }

  /**
   * Persist the session's model route (replayed when its agent is re-acquired).
   * @param {string} sessionId - the bound session.
   * @param {{ provider: string, model: string, reasoningEffort?: string }} route - the selection.
   */
  setModelRoute(sessionId, route) {
    const record = this.bySession.get(sessionId)
    if (record === undefined) return
    record.modelRoute = route
    this.save()
  }

  /**
   * Index one staged image so the loopback image route can serve it even when
   * the session's agent is not live (no workspace header reachable). The
   * newest entries win; the oldest are dropped past the per-session cap.
   * @param {string} sessionId - the session that owns the staging directory.
   * @param {string} name - staged file name (basename).
   * @param {string} path - absolute staged file path.
   * @param {{ mediaType?: string, bytes?: number, fileName?: string }} [meta] -
   *   display metadata recorded for the gallery surface.
   * @returns {string[]} paths of evicted entries (caller may delete the files).
   */
  setImage(sessionId, name, path, meta) {
    if (typeof sessionId !== 'string' || sessionId === '' || typeof name !== 'string' || name === '') return []
    const files = this.images.get(sessionId) ?? []
    const filtered = files.filter((file) => file.name !== name)
    filtered.push({
      name,
      path,
      at: Date.now(),
      ...(meta !== undefined && typeof meta.mediaType === 'string' ? { mediaType: meta.mediaType } : {}),
      ...(meta !== undefined && typeof meta.bytes === 'number' && Number.isFinite(meta.bytes) && meta.bytes > 0 ? { bytes: meta.bytes } : {}),
      ...(meta !== undefined && typeof meta.fileName === 'string' && meta.fileName !== '' ? { fileName: meta.fileName } : {}),
    })
    const kept = filtered.slice(-this.maxImagesPerSession)
    const evicted = filtered.slice(0, filtered.length - kept.length)
    this.images.set(sessionId, kept)
    this.save()
    return evicted.map((file) => file.path)
  }

  /**
   * List the indexed images of one session (newest first) for the gallery
   * surface. Entries persisted by older builds may lack display metadata;
   * those fields are omitted rather than fabricated.
   * @param {string} sessionId - the owning session.
   * @returns {Array<{ name: string, mediaType?: string, bytes?: number, fileName?: string, at: number }>}
   */
  imagesList(sessionId) {
    const files = this.images.get(sessionId) ?? []
    return [...files].reverse().map((file) => ({
      name: file.name,
      ...(typeof file.mediaType === 'string' && file.mediaType !== '' ? { mediaType: file.mediaType } : {}),
      ...(typeof file.bytes === 'number' && Number.isFinite(file.bytes) && file.bytes > 0 ? { bytes: file.bytes } : {}),
      ...(typeof file.fileName === 'string' && file.fileName !== '' ? { fileName: file.fileName } : {}),
      at: typeof file.at === 'number' ? file.at : 0,
    }))
  }

  /**
   * Resolve a staged image's absolute path from the index.
   * @param {string} sessionId - the owning session.
   * @param {string} name - staged file name.
   * @returns {string | undefined} the indexed path, when present.
   */
  imagePath(sessionId, name) {
    const file = this.images.get(sessionId)?.find((entry) => entry.name === name)
    return file?.path
  }

  /** Drop every indexed image entry for one session (unbind cleanup). */
  clearImages(sessionId) {
    if (this.images.delete(sessionId)) this.save()
  }

  /**
   * Mark a session as awaiting its first inbound message.
   * @param {string} sessionId - the session to queue.
   * @returns {boolean} false when the session is already bound or already pending.
   */
  addPending(sessionId) {
    if (this.bySession.has(sessionId) || this.pending.some((entry) => entry.sessionId === sessionId)) return false
    this.pending.push({ sessionId, at: Date.now() })
    this.save()
    return true
  }

  /**
   * @param {string} sessionId - the session to dequeue.
   * @returns {boolean} whether it was pending.
   */
  removePending(sessionId) {
    const index = this.pending.findIndex((entry) => entry.sessionId === sessionId)
    if (index === -1) return false
    this.pending.splice(index, 1)
    this.save()
    return true
  }

  /**
   * Take the oldest pending session (FIFO).
   * @returns {string | undefined} the session id, removed from the queue.
   */
  shiftPending() {
    const entry = this.pending.shift()
    if (entry !== undefined) this.save()
    return entry?.sessionId
  }

  /**
   * @param {boolean} value - whether new sessions auto-connect.
   */
  setAutoBindNewSession(value) {
    if (this.settings.autoBindNewSession === value) return
    this.settings.autoBindNewSession = value
    this.save()
  }

  /**
   * Whether a settings key was persisted in the document (vs a constructor default).
   * @param {string} key - settings key.
   * @returns {boolean}
   */
  settingsHas(key) {
    return this.persistedKeys.has(key)
  }

  /**
   * Merge-apply validated settings; persisted when anything changed.
   * @param {Partial<import('./bindings.js').BindingStore['settings']>} patch - validated values only.
   */
  setSettings(patch) {
    let changed = false
    for (const [key, value] of Object.entries(patch)) {
      if (Object.prototype.hasOwnProperty.call(this.settings, key) && this.settings[key] !== value) {
        this.settings[key] = value
        changed = true
      }
    }
    if (changed) this.save()
  }

  /**
   * @returns {{ bindings: BindingRecord[], pending: Array<{ sessionId: string, at: number }>,
   *             settings: import('./bindings.js').BindingStore['settings'] }} a status snapshot.
   */
  status() {
    return {
      bindings: [...this.bySession.values()].sort((a, b) => a.boundAt - b.boundAt),
      pending: [...this.pending],
      settings: { ...this.settings },
    }
  }
}
