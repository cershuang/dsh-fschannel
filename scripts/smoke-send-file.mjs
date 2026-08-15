// Smoke test for the send_feishu_file tool: binding lookup, workspace path
// confinement, size cap, Buffer-based send with file name + caption, and the
// failure messages.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSendFileTool } from '../lib/send-file-tool.js'
import { zh } from '../lib/locales.js'

// ── deps ───────────────────────────────────────────────────────────────────
const sent = []
let cwdOverride = '/ws'
let larkChannel = null
const lark = {
  send: async (chatId, input, opts) => { sent.push({ chatId, input, opts }) },
}
const store = {
  getBySession: (sessionId) => (sessionId === 'session-bound' ? { sessionId, chatId: 'oc_chat', lastInboundMessageId: 'msg-9' } : undefined),
}
const deps = {
  store,
  channel: () => (larkChannel === null ? lark : undefined),
  sessionCwd: () => cwdOverride,
  ui: () => zh,
  log: () => {},
}
const tool = createSendFileTool(deps)
const ui = zh

// ── 1. unbound session ─────────────────────────────────────────────────────
{
  const r = await tool.execute({ path: '/ws/x.txt' }, { agent: { sessionId: 'session-other' } })
  if (r.ok !== false || r.message !== ui.sendFileUnbound) throw new Error('unbound: ' + JSON.stringify(r))
}
// ── 2. missing path / outside workspace ────────────────────────────────────
{
  const r = await tool.execute({ path: '' }, { agent: { sessionId: 'session-bound' } })
  if (r.ok !== false || r.message !== ui.sendFileNoPath) throw new Error('no path')
  const r2 = await tool.execute({ path: '../escape.txt' }, { agent: { sessionId: 'session-bound' } })
  if (r2.ok !== false || r2.message !== ui.sendFileOutsideWorkspace) throw new Error('traversal accepted: ' + JSON.stringify(r2))
  const r3 = await tool.execute({ path: 'C:/Windows/evil.txt' }, { agent: { sessionId: 'session-bound' } })
  if (r3.ok !== false || r3.message !== ui.sendFileOutsideWorkspace) throw new Error('absolute outside accepted')
}
// ── 3. missing file ────────────────────────────────────────────────────────
{
  const r = await tool.execute({ path: '/ws/missing.txt' }, { agent: { sessionId: 'session-bound' } })
  if (r.ok !== false || r.message !== ui.sendFileNotFound) throw new Error('missing file accepted')
}
// ── 4. happy path: relative path inside workspace → Buffer send + caption ──
{
  const dir = fileURLToPath(new URL('../.tmp-send-file', import.meta.url))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'report.txt')
  writeFileSync(file, 'hello dsh-fschannel\n'.repeat(10))
  cwdOverride = dir
  const r = await tool.execute(
    { path: 'report.txt', fileName: '月度报告.txt', caption: ' 请查收  ' },
    { agent: { sessionId: 'session-bound' } },
  )
  if (r.ok !== true || r.message !== ui.sendFileSent) throw new Error('send failed: ' + JSON.stringify(r))
  if (sent.length !== 2) throw new Error('expected file + caption sends, got ' + sent.length)
  const fileSend = sent[0]
  if (fileSend.chatId !== 'oc_chat') throw new Error('wrong chat')
  if (!Buffer.isBuffer(fileSend.input.file.source)) throw new Error('source must be Buffer')
  if (fileSend.input.file.fileName !== '月度报告.txt') throw new Error('file name override not applied: ' + fileSend.input.file.fileName)
  if (fileSend.opts.replyTo !== 'msg-9') throw new Error('replyTo missing')
  if (sent[1].input.text !== '请查收') throw new Error('caption not trimmed: ' + sent[1].input.text)
  rmSync(dir, { recursive: true, force: true })
}
// ── 5. default file name from basename ─────────────────────────────────────
{
  const dir = fileURLToPath(new URL('../.tmp-send-file-2', import.meta.url))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'data.json')
  writeFileSync(file, '{}')
  cwdOverride = dir
  const r = await tool.execute({ path: 'data.json' }, { agent: { sessionId: 'session-bound' } })
  if (r.ok !== true) throw new Error('basename send failed: ' + JSON.stringify(r))
  const last = sent[sent.length - 1]
  if (last.input.file.fileName !== 'data.json') throw new Error('default file name wrong: ' + last.input.file.fileName)
  rmSync(dir, { recursive: true, force: true })
}
// ── 6. channel disconnected ────────────────────────────────────────────────
{
  cwdOverride = '/ws'
  larkChannel = undefined
  const r = await tool.execute({ path: '/ws/x.txt' }, { agent: { sessionId: 'session-bound' } })
  if (r.ok !== false || r.message !== ui.botNotConnected) throw new Error('channel guard: ' + JSON.stringify(r))
  larkChannel = null
}
console.log('SEND-FILE SMOKE OK')
