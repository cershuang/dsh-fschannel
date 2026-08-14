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
    /** @type {{ autoBindNewSession: boolean }} plugin settings */
    this.settings = { autoBindNewSession: false }
    this.load()
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
        const auto = data.settings.autoBindNewSession
        if (typeof auto === 'boolean') this.settings.autoBindNewSession = auto
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
   * @returns {{ bindings: BindingRecord[], pending: string[], autoBindNewSession: boolean }} a status snapshot.
   */
  status() {
    return {
      bindings: [...this.bySession.values()].sort((a, b) => a.boundAt - b.boundAt),
      pending: [...this.pending],
    }
  }
}
