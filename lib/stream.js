// @ts-check
/**
 * Streaming typewriter cards for one chat turn.
 *
 * The Feishu channel SDK opens a streaming card through
 * `channel.stream(chatId, { markdown: producer }, opts)`; the producer drains
 * buffered operations through `controller.append` / `controller.setContent`.
 * Ops are buffered here so event handlers never block; when the transport
 * rejects the stream (a deployment without card permissions, for example) the
 * accumulated text is sent once as a plain markdown message instead, so the
 * answer still arrives.
 *
 * The card opens with an initial placeholder ("正在处理…") so the user sees
 * output from the very first moment of the turn; real content replaces it.
 * The resolved `messageId` is kept so the owner can replace the card with a
 * structured final result once the turn settles.
 * @module dsh-fschannel/stream
 */

/** One queued controller operation, applied in arrival order by the producer. */
/** @typedef {{ kind: 'append', text: string } | { kind: 'set', text: string }} StreamOp */

/** A live streaming card: buffered operations plus its settlement. */
export class StreamHandle {
  /**
   * @param {object} port - the outbound transport ({@code send}, {@code stream}).
   * @param {string} chatId - the bound chat.
   * @param {object} [opts] - send options fixed when the card opens (replyTo...).
   * @param {(error: unknown) => void} onFailure - report a stream failure.
   * @param {string} [initialText] - placeholder shown until the first real content.
   */
  constructor(port, chatId, opts, onFailure, initialText = '正在处理…') {
    this.port = port
    this.chatId = chatId
    this.opts = opts
    this.onFailure = onFailure
    /** @type {StreamOp[]} */
    this.ops = []
    // The placeholder is queued BEFORE the producer starts, so the card shows
    // it immediately. It never enters `full` (the fallback/result text).
    if (initialText !== '') this.ops.push({ kind: 'set', text: initialText })
    /** Everything the card should hold, for the plain-message fallback. */
    this.full = ''
    this.done = false
    /** @type {(() => void) | undefined} */
    this.wake = undefined
    /** @type {string | undefined} the head card's message id once the stream settles. */
    this.messageId = undefined
    /** @type {Promise<boolean>} whether the card stream settled successfully. */
    this.settled = this.open()
  }

  /** Start the stream producer; resolves when the card settles (or falls back). */
  open() {
    return this.port.stream(this.chatId, {
      markdown: async (controller) => {
        for (;;) {
          const op = this.ops.shift()
          if (op === undefined) {
            if (this.done) return
            await new Promise((resolve) => { this.wake = resolve })
            continue
          }
          if (op.kind === 'append') await controller.append(op.text)
          else await controller.setContent(op.text)
        }
      },
    }, this.opts).then((result) => {
      this.messageId = result?.messageId
      return true
    }, (error) => {
      this.onFailure(error)
      return false
    })
  }

  /** Queue a typewriter append. */
  append(text) {
    if (text === '') return
    this.full += text
    this.ops.push({ kind: 'append', text })
    this.wake?.()
    this.wake = undefined
  }

  /** Queue a whole-content replacement, correcting what already streamed. */
  set(text) {
    this.full = text
    this.ops.push({ kind: 'set', text })
    this.wake?.()
    this.wake = undefined
  }

  /**
   * Close the producer and await the stream's settlement. The OWNER decides
   * what happens when the stream failed (messageId stays undefined): it may
   * deliver the accumulated text as a static card or a plain message.
   * @returns {Promise<void>}
   */
  async finish() {
    this.done = true
    this.wake?.()
    this.wake = undefined
    await this.settled
  }
}
