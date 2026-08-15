// @ts-check
/**
 * `send_feishu_file` — host tool that lets the agent send a file to the
 * Feishu chat bound to the calling session. The file is typically generated
 * by the agent during the turn (reports, exports, logs) and lives inside the
 * session workspace.
 *
 * Transport: the Lark channel SDK sends `{ file: { source, fileName } }` by
 * uploading the bytes itself. A `Buffer` source needs no
 * `outbound.allowedFileDirs` config (the local-file path branch does), so we
 * always read the file and pass a Buffer — minimal configuration surface,
 * same result.
 *
 * Security: the path is resolved against the calling session's workspace and
 * confined to it (relative() check incl. Windows cross-drive, same as the
 * loopback image route). The sent file is NOT indexed into the image gallery
 * (that surface holds staged/sent images only).
 * @module dsh-fschannel/send-file-tool
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/** @typedef {import('./locales.js').LocaleDict} LocaleDict */

/** Feishu file-message size cap (30 MiB, generous but bounded). */
const MAX_FILE_BYTES = 30 * 1024 * 1024

/**
 * Build the tool definition bound to one plugin instance. The definition is a
 * plain object matching the host's `ToolDefinition` shape — the plugin does
 * not depend on the `@deepseek-ai/dsh-tools` package, which lives in the host
 * bundle; the registry validates the object at registration.
 * @param {{
 *   store: import('./bindings.js').BindingStore,
 *   channel: () => import('@larksuite/channel').LarkChannel | undefined,
 *   sessionCwd: (sessionId: string) => string | undefined,
 *   ui: () => LocaleDict,
 *   log: (line: string) => void,
 * }} deps - plugin-owned accessors (functions so the live values are read at
 *   call time, not at registration time).
 * @returns {{
 *   name: string, description: string, parameters: Record<string, unknown>,
 *   output: { schema: Record<string, unknown>, render: (args: unknown, value: { ok: boolean, message: string }) => Array<{ type: string, text: string }> },
 *   execute: (args: { path?: string, fileName?: string, caption?: string }, exec: { agent?: { sessionId?: string } }) => Promise<{ ok: boolean, message: string }>,
 * }} registry-ready definition.
 */
export function createSendFileTool({ store, channel, sessionCwd, ui, log }) {
  return {
    name: 'send_feishu_file',
    description: 'Send a file (any type, up to 30 MiB) to the Feishu chat bound to the current session. The file must be a real file inside the session workspace — e.g. one you generated earlier in this turn. Optionally override the file name and attach a short caption. Returns whether the file was delivered.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path to the file: absolute, or relative to the session workspace.' },
        fileName: { type: 'string', description: 'Optional file name shown in Feishu (defaults to the path\'s basename).' },
        caption: { type: 'string', description: 'Optional short text sent together with the file.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        // Requiredness belongs on the object, never on the property. A
        // per-property `required: true` is draft-03 syntax; dsh-tools rejects
        // it outright ("required is not supported on type ..."), and the whole
        // plugin tree then fails to load.
        required: ['ok', 'message'],
        properties: {
          ok: { type: 'boolean', description: 'Whether the file was delivered.' },
          message: { type: 'string', description: 'Human-readable result, shown to the agent.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: async ({ path, fileName, caption }, exec) => {
      const dict = ui()
      const fail = (message) => ({ ok: false, message })

      const sessionId = exec.agent?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        return fail(dict.sendFileNoSession)
      }
      const record = store.getBySession(sessionId)
      if (record === undefined) {
        return fail(dict.sendFileUnbound)
      }
      const lark = channel()
      if (lark === undefined) {
        return fail(dict.botNotConnected)
      }

      // Resolve the file path against the session workspace and confine it.
      const raw = typeof path === 'string' && path !== '' ? path : ''
      if (raw === '') return fail(dict.sendFileNoPath)
      const cwd = sessionCwd(sessionId)
      const abs = isAbsolute(raw) ? raw : cwd === undefined ? undefined : resolve(cwd, raw)
      if (abs === undefined) {
        return fail(dict.sendFileOutsideWorkspace)
      }
      if (cwd !== undefined) {
        const rel = relative(cwd, abs)
        // Confine to the workspace: `..` traversal, and Windows cross-drive
        // paths (relative() returns the absolute target for a different root).
        if (rel === '' || rel.startsWith('..') || rel.includes('..\\') || rel.includes('../') || isAbsolute(rel)) {
          return fail(dict.sendFileOutsideWorkspace)
        }
      }

      let buffer
      try {
        buffer = readFileSync(abs)
      } catch {
        return fail(dict.sendFileNotFound)
      }
      if (buffer.byteLength === 0) return fail(dict.sendFileNotFound)
      if (buffer.byteLength > MAX_FILE_BYTES) {
        return fail(dict.sendFileTooLarge)
      }

      const displayName = typeof fileName === 'string' && fileName.trim() !== '' ? fileName.trim() : basenameOf(abs)

      try {
        await lark.send(record.chatId, {
          file: { source: buffer, fileName: displayName },
        }, { replyTo: record.lastInboundMessageId })
      } catch (error) {
        log(`feishu: send_feishu_file failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        return fail(dict.sendFileFailed)
      }

      const captionText = typeof caption === 'string' && caption !== '' ? caption.trim() : ''
      if (captionText !== '') {
        try {
          await lark.send(record.chatId, { text: captionText }, { replyTo: record.lastInboundMessageId })
        } catch (error) {
          log(`feishu: send_feishu_file caption failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return { ok: true, message: dict.sendFileSent }
    },
  }
}

/** @param {string} path */
function basenameOf(path) {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}
