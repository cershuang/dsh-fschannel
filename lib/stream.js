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
   */
  constructor(port, chatId, opts, onFailure) {
    this.port = port
    this.chatId = chatId
    this.opts = opts
    this.onFailure = onFailure
    /** @type {StreamOp[]} */
    this.ops = []
    /** Everything the card should hold, for the plain-message fallback. */
    this.full = ''
    this.done = false
    /** @type {(() => void) | undefined} */
    this.wake = undefined
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
    }, this.opts).then(() => true, (error) => {
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
   * Close the producer and await the stream's settlement. When the transport
   * rejected the card, send the accumulated text once as a plain message.
   * @returns {Promise<void>}
   */
  async finish() {
    this.done = true
    this.wake?.()
    this.wake = undefined
    const ok = await this.settled
    if (!ok && this.full !== '') {
      try {
        await this.port.send(this.chatId, { markdown: this.full }, this.opts)
      } catch (error) {
        this.onFailure(error)
      }
    }
  }
}
