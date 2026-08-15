// Render-level smoke for the settings section: executes the built client
// bundle with a mock h(), a stateful useState mock, and a fetch mock serving
// /feishu/status + /feishu/config. Renders twice (initial + after the refresh
// effect settles) and asserts the table layout: ocID/session short cells with
// full-id tooltips, full chatName, chatName-less fallback cell, pending badge,
// table header, and the empty state.
import { copyFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const copyPath = fileURLToPath(new URL('../lib/client.settings-smoke.cjs', import.meta.url))
copyFileSync(bundlePath, copyPath)

let captured = null
globalThis.window = { __ModuleLoader__: { load(handoff) { captured = handoff } } }

// ── stateful mock state (per render pass) ────────────────────────────────
let stateSlots = []
let renderPass = 0
const useState = (init) => {
  if (renderPass >= stateSlots.length) stateSlots.push({ value: init })
  const slot = stateSlots[renderPass]
  renderPass += 1
  return [slot.value, (v) => { slot.value = v }]
}
// Start a fresh component instance (clear state); each re-render of the same
// instance reuses the slots by resetting only the pass counter.
const resetState = () => { stateSlots = []; renderPass = 0 }
const reRender = () => { renderPass = 0 }

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('fragment'),
  useState,
  useEffect: (cb) => { void cb() },
  useCallback: (fn) => fn,
}

const plugin = require(copyPath)
if (captured === null) throw new Error('load() was not called')
const exportsObj = captured.factory((spec) => {
  if (spec === 'react') return fakeReact
  throw new Error('unexpected require: ' + spec)
})
console.log('exports inject:', exportsObj.inject.join(','))

const registered = []
const ctx = {
  effect(fn) { fn(); return () => {} },
  on() { return () => {} },
  off() {},
  locale: { register() {}, bind: (ns) => (key) => key },
  sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
  workspaces: { startSession: async () => {} },
  slots: {
    inject(name, cb) { const opts = cb(); registered.push(opts) },
    register: (opts, view) => { registered.push({ ...opts, view }); return () => {} },
  },
  get(name) {
    if (name === 'conversationEvents') return { register: () => {} }
    return undefined
  },
}
exportsObj.apply(ctx)
const settingsOpts = registered.find((o) => o && typeof o === 'object' && o.name === 'settings.section')
if (settingsOpts === undefined) throw new Error('settings.section missing')
const FeishuSection = settingsOpts.view
if (typeof FeishuSection !== 'function') throw new Error('settings view missing')

const t = (key) => key
const createSession = async () => {}

const walk = (node, acc = []) => {
  if (node === null || node === undefined) return acc
  if (typeof node === 'string' || typeof node === 'number') { acc.push(node); return acc }
  acc.push(node)
  if (Array.isArray(node)) { for (const n of node) walk(n, acc); return acc }
  // The mock createElement returns { type, props, children } — children live
  // on the node itself, not under props.
  const kids = node.children
  if (kids !== undefined) {
    const children = Array.isArray(kids) ? kids : [kids]
    for (const c of children) walk(c, acc)
  }
  return acc
}

const statusPayload = {
  ok: true,
  connected: true,
  credentialSource: 'credentials',
  bindings: [
    { sessionId: 'session-c69cde16-b1cb-43d5-87a5-9b9e081e3893', chatId: 'oc_085dfb622268c6990832bff9ed374005', chatName: 'Team Room' },
    { sessionId: 'session-b2134b16-9043-4053-a2e9-8c38e12b7846', chatId: 'oc_d0a1f2e1318d7fafd83227b5be39235e' },
  ],
  pending: [{ sessionId: 'session-abc12345-0000-0000-0000-000000000000', at: Date.now() - 5 * 60000 }],
}
const configPayload = {
  ok: true,
  autoBindNewSession: true,
  output: 'stream',
  showImages: true,
  holdTtlSeconds: 3600,
  maxHeldImages: 10,
  maxHeldImageBytes: 10,
  credentials: {
    appId: { configured: true, source: 'file', writable: true, masked: 'cli_aa…5bc3' },
    appSecret: { configured: true, source: 'file', writable: true },
  },
}
globalThis.fetch = async (url) => ({
  json: async () => (String(url).includes('/status') ? statusPayload : configPayload),
})

// Case 1: bound rows (with/without chatName) + pending row, with DSH session
// titles injected. session-c69cde16… has a DSH title (must win over the
// Feishu chatName); session-b2134b16… has none (falls back to chatName, then
// short chatId). Render initial pass (status=null), let the refresh effect
// settle, re-render with state.
resetState()
const sessionTitles = () => ({
  'session-c69cde16-b1cb-43d5-87a5-9b9e081e3893': '继续开发插件',
})
FeishuSection({ t, createSession, sessionTitles })
await new Promise((resolve) => setTimeout(resolve, 30))
reRender()
const v1 = FeishuSection({ t, createSession, sessionTitles })
const nodes1 = walk(v1)
const byText = (text) => nodes1.some((n) => n === text)
if (!byText('oc_085…4005')) throw new Error('ocID short cell missing')
if (!byText('session-c6…3893')) throw new Error('session short cell missing')
if (!byText('继续开发插件')) throw new Error('DSH session title cell missing')
if (!byText('pendingBadge')) throw new Error('pending badge missing')
if (!byText('thChatId') || !byText('thSession') || !byText('thName') || !byText('thAction')) {
  throw new Error('table header missing')
}
if (!nodes1.some((n) => typeof n === 'object' && n.props && n.props.title === 'oc_085dfb622268c6990832bff9ed374005')) {
  throw new Error('ocID title tooltip missing')
}
if (!nodes1.some((n) => typeof n === 'object' && n.props && n.props.title === 'session-c69cde16-b1cb-43d5-87a5-9b9e081e3893')) {
  throw new Error('session title tooltip missing')
}
if (!nodes1.some((n) => typeof n === 'object' && n.props && n.props.title === '继续开发插件')) {
  throw new Error('DSH title tooltip missing')
}
const spans = nodes1.filter((n) => typeof n === 'object' && n.type === 'span')
const fallback = spans.find((n) => n.props && n.props.style && n.props.style.fontStyle === 'italic')
if (!fallback || !byText('oc_d0a1f2e1318…39235e')) {
  throw new Error('chatName fallback cell wrong: ' + JSON.stringify(fallback?.props?.children))
}

// Case 1b: no DSH titles — the Feishu chatName becomes the name-cell content.
resetState()
FeishuSection({ t, createSession, sessionTitles: () => ({}) })
await new Promise((resolve) => setTimeout(resolve, 30))
reRender()
const v1b = FeishuSection({ t, createSession, sessionTitles: () => ({}) })
const nodes1b = walk(v1b)
if (!nodes1b.some((n) => n === 'Team Room')) throw new Error('chatName shown when no DSH title')

// Case 2: empty state.
resetState()
const emptyStatus = { ok: true, connected: false, reason: 'credentials missing', bindings: [], pending: [] }
globalThis.fetch = async (url) => ({
  json: async () => (String(url).includes('/status') ? emptyStatus : configPayload),
})
FeishuSection({ t, createSession })
await new Promise((resolve) => setTimeout(resolve, 30))
reRender()
const v2 = FeishuSection({ t, createSession })
const nodes2 = walk(v2)
if (!nodes2.some((n) => n === 'rowNoBindings')) throw new Error('empty state missing')

// Case 3: pending only — header still renders.
resetState()
const pendingOnly = { ok: true, connected: true, credentialSource: 'file', bindings: [], pending: [{ sessionId: 'session-9', at: 0 }] }
globalThis.fetch = async (url) => ({
  json: async () => (String(url).includes('/status') ? pendingOnly : configPayload),
})
FeishuSection({ t, createSession })
await new Promise((resolve) => setTimeout(resolve, 30))
reRender()
const v3 = FeishuSection({ t, createSession })
const nodes3 = walk(v3)
if (!nodes3.some((n) => n === 'thChatId')) throw new Error('table header missing with pending only')
if (!nodes3.some((n) => n === 'session-9')) throw new Error('pending session cell missing')

rmSync(copyPath, { force: true })
console.log('SETTINGS RENDER SMOKE OK')
