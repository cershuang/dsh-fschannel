// Smoke test for the send_feishu_image tool: binding lookup, workspace path
// confinement, type validation, Buffer-based send, gallery indexing, and the
// failure messages.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSendImageTool } from '../lib/send-image-tool.js'
import { zh } from '../lib/locales.js'

// ── deps ───────────────────────────────────────────────────────────────────
const sent = []
const indexed = []
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
  indexImage: (record, file) => { indexed.push({ record, file }) },
  ui: () => zh,
  log: () => {},
}
const tool = createSendImageTool(deps)
const ui = zh

// ── 1. unbound session ─────────────────────────────────────────────────────
{
  const r = await tool.execute({ path: '/ws/x.png' }, { agent: { sessionId: 'session-other' } })
  if (r.ok !== false || r.message !== ui.sendImageUnbound) throw new Error('unbound: ' + JSON.stringify(r))
}
// ── 2. missing path / outside workspace ────────────────────────────────────
{
  const r = await tool.execute({ path: '' }, { agent: { sessionId: 'session-bound' } })
  if (r.ok !== false || r.message !== ui.sendImageNoPath) throw new Error('no path')
  const r2 = await tool.execute({ path: '../escape.png' }, { agent: { sessionId: 'session-bound' } })
  if (r2.ok !== false || r2.message !== ui.sendImageOutsideWorkspace) throw new Error('traversal accepted: ' + JSON.stringify(r2))
  const r3 = await tool.execute({ path: 'C:/Windows/evil.png' }, { agent: { sessionId: 'session-bound' } })
  if (r3.ok !== false || r3.message !== ui.sendImageOutsideWorkspace) throw new Error('absolute outside accepted')
}
// ── 3. invalid type / missing file ─────────────────────────────────────────
{
  const r = await tool.execute({ path: '/ws/note.txt' }, { agent: { sessionId: 'session-bound' } })
  if (r.ok !== false || r.message !== ui.sendImageInvalidType) throw new Error('txt accepted')
  const r2 = await tool.execute({ path: '/ws/missing.png' }, { agent: { sessionId: 'session-bound' } })
  if (r2.ok !== false || r2.message !== ui.sendImageNotFound) throw new Error('missing file accepted')
}
// ── 4. happy path: relative path inside workspace → Buffer send + caption ──
{
  const dir = fileURLToPath(new URL('../.tmp-send-image', import.meta.url))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'chart.png')
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  cwdOverride = dir
  const r = await tool.execute({ path: 'chart.png', caption: ' 月度趋势  ' }, { agent: { sessionId: 'session-bound' } })
  if (r.ok !== true || r.message !== ui.sendImageSent) throw new Error('send failed: ' + JSON.stringify(r))
  if (sent.length !== 2) throw new Error('expected image + caption sends, got ' + sent.length)
  const imageSend = sent[0]
  if (imageSend.chatId !== 'oc_chat') throw new Error('wrong chat')
  if (!Buffer.isBuffer(imageSend.input.image.source)) throw new Error('source must be Buffer')
  if (imageSend.input.image.source.byteLength !== 7) throw new Error('wrong bytes')
  if (imageSend.opts.replyTo !== 'msg-9') throw new Error('replyTo missing')
  if (sent[1].input.text !== '月度趋势') throw new Error('caption not trimmed: ' + sent[1].input.text)
  if (indexed.length !== 1) throw new Error('not indexed')
  if (indexed[0].file.name !== 'chart.png') throw new Error('indexed name wrong')
  rmSync(dir, { recursive: true, force: true })
}
// ── 5. channel disconnected ────────────────────────────────────────────────
{
  cwdOverride = '/ws'
  larkChannel = undefined
  const r = await tool.execute({ path: '/ws/x.png' }, { agent: { sessionId: 'session-bound' } })
  if (r.ok !== false || r.message !== ui.botNotConnected) throw new Error('channel guard: ' + JSON.stringify(r))
  larkChannel = null
}
// ── 6. the schemas must be shapes dsh-tools accepts ───────────────────────
// Registration is validated at BOOT: an unsupported schema does not degrade
// the tool, it aborts the whole plugin tree ("dsh: plugin tree failed to
// load"). Every behaviour test above passed with a schema that did exactly
// that, so behaviour coverage is not enough — the shape needs its own check.
//
// The rule that bit us: `required` belongs on the object as an array of
// property names. A per-property `required: true` is draft-03 syntax and
// dsh-tools rejects it outright.
{
  /** @param {unknown} schema @param {string} path */
  const assertSupported = (schema, path) => {
    if (schema === null || typeof schema !== 'object') return
    if (Array.isArray(schema)) {
      schema.forEach((item, index) => assertSupported(item, `${path}[${index}]`))
      return
    }
    const node = /** @type {Record<string, unknown>} */ (schema)
    if ('required' in node && !Array.isArray(node.required)) {
      throw new Error(`${path}.required must be an array of property names, got ${JSON.stringify(node.required)} — dsh-tools rejects this at boot`)
    }
    if (node.properties !== null && typeof node.properties === 'object') {
      for (const [key, child] of Object.entries(node.properties)) {
        assertSupported(child, `${path}.properties.${key}`)
      }
    }
    for (const key of ['items', 'additionalProperties']) {
      if (node[key] !== null && typeof node[key] === 'object') assertSupported(node[key], `${path}.${key}`)
    }
  }

  assertSupported(tool.parameters, 'parameters')
  assertSupported(tool.output?.schema, 'output.schema')

  // Requiredness must still be declared — an empty schema would pass the rule
  // above while telling the agent nothing.
  if (!Array.isArray(tool.parameters?.required) || !tool.parameters.required.includes('path')) {
    throw new Error('parameters must require `path`')
  }
  const outputRequired = tool.output?.schema?.required
  if (!Array.isArray(outputRequired) || !outputRequired.includes('ok') || !outputRequired.includes('message')) {
    throw new Error('output schema must require ok and message')
  }
}

console.log('SEND-IMAGE SMOKE OK')
