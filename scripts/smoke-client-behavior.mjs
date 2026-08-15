// Behaviour smoke for the client half: the paths the render-level suite cannot
// reach because its mocks are deliberately inert.
//
// Covers the locale-reporting effect (which was silently dead in the other two
// suites — neither stubs ctx.locale.getLocale, so the call threw straight into
// a catch and the POST never fired), api()'s two failure branches, the
// serverError code mapping, the shared refresh bus, the pending-phase poll, and
// the client's own zh/en dictionaries.
//
// Timers are recorded rather than armed: a real setInterval keeps the process
// alive and the runner would kill the suite on its timeout.
import { copyFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
// A third distinct name, so this suite can run beside the other two.
const copyPath = fileURLToPath(new URL('../lib/client.behavior-smoke.cjs', import.meta.url))
copyFileSync(bundlePath, copyPath)
process.on('exit', () => { rmSync(copyPath, { force: true }) })

// ── timer capture ─────────────────────────────────────────────────────────
/** @type {Array<{ ms: number, fn: Function, cleared: boolean, kind: string }>} */
const timers = []
globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms, cleared: false, kind: 'interval' }); return timers.length - 1 }
globalThis.clearInterval = (id) => { if (timers[id] !== undefined) timers[id].cleared = true }
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms, cleared: false, kind: 'timeout' }); return timers.length - 1 }
globalThis.clearTimeout = (id) => { if (timers[id] !== undefined) timers[id].cleared = true }

// ── React mock that keeps state AND cleanup functions ─────────────────────
let stateSlots = []
let renderPass = 0
/** @type {Function[]} */
let cleanups = []
const useState = (init) => {
  if (renderPass >= stateSlots.length) stateSlots.push({ value: init })
  const slot = stateSlots[renderPass]
  renderPass += 1
  return [slot.value, (v) => { slot.value = v }]
}
/** Slot-based useMemo: recompute only when a dependency changed. */
const useMemo = (factory, deps) => {
  if (renderPass >= stateSlots.length) stateSlots.push({ value: undefined, deps: undefined })
  const slot = stateSlots[renderPass]
  renderPass += 1
  const stale = slot.deps === undefined || deps === undefined
    || deps.length !== slot.deps.length || deps.some((d, i) => d !== slot.deps[i])
  if (stale) { slot.value = factory(); slot.deps = deps }
  return slot.value
}
/**
 * Start a fresh component instance. Cleanups are RUN, not dropped: discarding
 * them left every scenario's bus listener registered, each closing over state
 * slots that had already been orphaned. Harmless only while nothing broadcast —
 * the moment a test asserts on a broadcast, the stale listeners make the counts
 * meaningless.
 */
const resetState = () => { unmount(); stateSlots = []; renderPass = 0 }
/**
 * Mount/re-render a NAMED component instance. The mock keeps one slot array, so
 * without this two different components rendered in sequence read each other's
 * hook slots — which makes any multi-surface assertion meaningless.
 */
const instances = new Map()
const useInstance = (name) => {
  if (!instances.has(name)) instances.set(name, [])
  stateSlots = instances.get(name)
  renderPass = 0
}
/**
 * Unmount everything before starting a fresh set of instances. Cleanups must be
 * RUN, not dropped: a discarded cleanup leaves its bus listener registered, and
 * those accumulate across scenarios until any broadcast assertion is nonsense.
 */
const resetInstances = () => { unmount(); instances.clear() }
const reRender = () => { renderPass = 0 }
const unmount = () => { while (cleanups.length > 0) { const fn = cleanups.pop(); if (typeof fn === 'function') fn() } }

/**
 * Slot-based useEffect that honours the dependency array.
 *
 * The previous mock ran every effect on every render and never invoked a
 * cleanup between renders. That made the poll assertion prove nothing — it
 * passed identically with deps of [], [phase], [refresh] or none at all — and
 * rendering twice armed two intervals and added two bus listeners, so a
 * regression that duplicated either would go unnoticed.
 */
const useEffect = (cb, deps) => {
  if (renderPass >= stateSlots.length) stateSlots.push({ deps: undefined, cleanup: undefined })
  const slot = stateSlots[renderPass]
  renderPass += 1
  const stale = slot.deps === undefined || deps === undefined
    || deps.length !== slot.deps.length || deps.some((d, i) => d !== slot.deps[i])
  if (!stale) return
  if (typeof slot.cleanup === 'function') {
    const index = cleanups.indexOf(slot.cleanup)
    if (index !== -1) cleanups.splice(index, 1)
    slot.cleanup()
  }
  slot.deps = deps
  const cleanup = cb()
  slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
  if (slot.cleanup !== undefined) cleanups.push(slot.cleanup)
}

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('fragment'),
  useState,
  useEffect,
  // useCallback must memoize, or every render hands out a new function
  // identity and every dependent effect re-runs — which is how a "one refresh
  // per mutation" assertion silently became three.
  useCallback: (fn, deps) => useMemo(() => fn, deps),
  useMemo,
}

// ── fetch recorder ────────────────────────────────────────────────────────
let fetchCalls = []
let statusPayload = { ok: true, connected: true, configured: true, bindings: [], pending: [] }
let configPayload = { ok: true, autoBindNewSession: false, holdTtlSeconds: 0, maxHeldImages: 10, maxHeldImageBytes: 10, locale: 'zh', credentials: {} }
let postReply = { ok: true }
let fetchMode = 'normal' // normal | reject | badjson
const installFetch = () => {
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), method: options?.method ?? 'GET', body: options?.body })
    if (fetchMode === 'reject') throw new Error('network down')
    if (fetchMode === 'badjson') return { json: async () => { throw new Error('not json') } }
    if (options?.method === 'POST') return { json: async () => postReply }
    return { json: async () => (String(url).includes('/status') ? statusPayload : configPayload) }
  }
}
installFetch()

const settle = () => new Promise((resolve) => { process.nextTick(() => process.nextTick(resolve)) })

// ── load the bundle ───────────────────────────────────────────────────────
let captured = null
globalThis.window = { __ModuleLoader__: { load(handoff) { captured = handoff } }, confirm: () => true, open: () => {} }
require(copyPath)
if (captured === null) throw new Error('load() was not called')
const exportsObj = captured.factory((spec) => {
  if (spec === 'react') return fakeReact
  throw new Error('unexpected require: ' + spec)
})

// ── ctx with a real locale service ────────────────────────────────────────
let activeLocale = 'en'
/** @type {Array<[string, Function]>} */
const subscriptions = []
let offCalls = 0
let registeredDicts = null
const registered = []
const makeCtx = ({ withGetLocale = true } = {}) => ({
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose); return () => {} },
  on(event, fn) { subscriptions.push([event, fn]); return () => { offCalls += 1 } },
  off() {},
  locale: {
    register(ns, dicts) { registeredDicts = dicts; return () => {} },
    bind: () => (key) => key,
    ...(withGetLocale ? { getLocale: () => ({ active: activeLocale }) } : {}),
  },
  sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
  workspaces: { startSession: async () => {} },
  slots: {
    inject(name, cb) { const opts = cb(); registered.push(opts) },
    register: (opts, view) => { registered.push({ ...opts, view }); return () => {} },
  },
  get(name) { return name === 'conversationEvents' ? { register: () => {} } : undefined },
})

// ── 1. locale reporting ───────────────────────────────────────────────────
resetState()
fetchCalls = []
exportsObj.apply(makeCtx())
await settle()

const localePosts = fetchCalls.filter((call) => call.method === 'POST' && call.url.includes('/config'))
if (localePosts.length !== 1) throw new Error('expected one locale POST, got ' + localePosts.length)
if (JSON.parse(localePosts[0].body).locale !== 'en') throw new Error('wrong locale reported: ' + localePosts[0].body)

const localeSub = subscriptions.find(([event]) => event === 'locale/change')
if (localeSub === undefined) throw new Error("did not subscribe to 'locale/change'")

// A host language switch must re-report.
activeLocale = 'zh'
fetchCalls = []
localeSub[1]()
await settle()
const reposts = fetchCalls.filter((call) => call.method === 'POST' && call.url.includes('/config'))
if (reposts.length !== 1 || JSON.parse(reposts[0].body).locale !== 'zh') {
  throw new Error('locale change not re-reported: ' + JSON.stringify(reposts))
}

// Unmounting must drop the locale subscription, or a reloaded plugin reports
// twice for every host language switch.
unmount()
if (offCalls === 0) throw new Error('locale/change subscription not disposed on unmount')

// The catch around getLocale is a real fallback, not a way to hide a broken
// call: a host without the locale service must still mount every surface.
resetState()
subscriptions.length = 0
registered.length = 0
fetchCalls = []
exportsObj.apply(makeCtx({ withGetLocale: false }))
await settle()
if (!registered.some((opts) => opts && opts.id === 'feishu')) throw new Error('settings section missing without getLocale')
if (fetchCalls.some((call) => call.method === 'POST')) throw new Error('must not POST a locale it could not read')

// ── 2. client dictionary parity ───────────────────────────────────────────
if (registeredDicts === null) throw new Error('ctx.locale.register was never called')
const { zh, en } = registeredDicts
const zhKeys = Object.keys(zh).sort()
const missingInEn = zhKeys.filter((key) => !(key in en))
if (missingInEn.length > 0) throw new Error('client en missing keys: ' + missingInEn.join(', '))
const extraInEn = Object.keys(en).filter((key) => !(key in zh))
if (extraInEn.length > 0) throw new Error('client en has unknown keys: ' + extraInEn.join(', '))
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
for (const key of zhKeys) {
  if (placeholders(zh[key]) !== placeholders(en[key])) {
    throw new Error(`client placeholder mismatch in "${key}": zh(${placeholders(zh[key])}) vs en(${placeholders(en[key])})`)
  }
  if (typeof zh[key] !== 'string' || zh[key] === '') throw new Error(`client zh["${key}"] is empty`)
  if (typeof en[key] !== 'string' || en[key] === '') throw new Error(`client en["${key}"] is empty`)
}

// ── 3. the settings section: api() failures and serverError mapping ───────
const section = registered.find((opts) => opts && opts.id === 'feishu')
if (section === undefined || typeof section.view !== 'function') throw new Error('settings section view missing')
const FeishuSection = section.view

// A dictionary that actually carries placeholders: with t = (key) => key the
// substitutions are no-ops and every error code renders identically, so the
// assertions below would pass against any mapping at all.
const dict = {
  credResultFail: 'FAIL[{error}]',
  errAppIdSaveFailed: 'appId!{detail}',
  errInvalidHoldTtl: 'ttl-invalid',
  errNetwork: 'net-down',
  errUnknown: 'unknown',
}
const t = (key) => dict[key] ?? key

const walk = (node, acc = []) => {
  if (node === null || node === undefined) return acc
  if (typeof node === 'string' || typeof node === 'number') { acc.push(node); return acc }
  acc.push(node)
  if (Array.isArray(node)) { for (const n of node) walk(n, acc); return acc }
  const kids = node.children
  if (kids !== undefined) for (const c of (Array.isArray(kids) ? kids : [kids])) walk(c, acc)
  return acc
}
const renderSection = async () => {
  FeishuSection({ t, createSession: async () => {} })
  await settle()
  reRender()
  return walk(FeishuSection({ t, createSession: async () => {} }))
}

// A rejected fetch must not become an unhandled rejection, and must leave the
// section renderable rather than blank.
resetState()
fetchMode = 'reject'
const rejectedNodes = await renderSection()
if (rejectedNodes.length === 0) throw new Error('section rendered nothing after a failed fetch')
fetchMode = 'normal'

// A body that is not JSON is the other api() failure branch.
resetState()
fetchMode = 'badjson'
const badJsonNodes = await renderSection()
if (badJsonNodes.length === 0) throw new Error('section rendered nothing after a bad JSON body')
fetchMode = 'normal'

// ── 4. the pending-phase poll ─────────────────────────────────────────────
const seat = registered.find((opts) => opts && opts.id === 'feishu-bind')
if (seat === undefined || typeof seat.view !== 'function') throw new Error('seat view missing')
const FeishuSeat = seat.view

// Bound: no poll.
resetState()
timers.length = 0
statusPayload = { ok: true, connected: true, configured: true, bindings: [{ sessionId: 'sess-1', chatId: 'oc_1' }], pending: [] }
FeishuSeat({ sessionId: 'sess-1', t })
await settle()
reRender()
FeishuSeat({ sessionId: 'sess-1', t })
if (timers.some((timer) => timer.kind === 'interval')) throw new Error('bound phase must not poll')

// Pending: a 5s poll that refreshes and is cleared on unmount.
resetState()
timers.length = 0
statusPayload = { ok: true, connected: true, configured: true, bindings: [], pending: [{ sessionId: 'sess-1', at: 0 }] }
FeishuSeat({ sessionId: 'sess-1', t })
await settle()
reRender()
FeishuSeat({ sessionId: 'sess-1', t })
const poll = timers.find((timer) => timer.kind === 'interval')
if (poll === undefined) throw new Error('pending phase did not arm a poll')
if (poll.ms !== 5000) throw new Error('poll interval should be 5000ms, got ' + poll.ms)

fetchCalls = []
poll.fn()
await settle()
if (!fetchCalls.some((call) => call.url.includes('/status'))) throw new Error('poll tick did not re-read status')

// Re-rendering the same instance must NOT arm a second interval. With a mock
// that ignored dependency arrays this was invisible: two renders armed two
// timers, timers.find() inspected only the first, and unmount() ran both
// cleanups — so the assertion below passed no matter what.
reRender()
FeishuSeat({ sessionId: 'sess-1', t })
const intervals = timers.filter((timer) => timer.kind === 'interval')
if (intervals.length !== 1) throw new Error('re-render armed ' + intervals.length + ' intervals; expected 1')

unmount()
if (!poll.cleared) throw new Error('poll timer not cleared on unmount')

// ── a superseded session's response must not write state ──────────────────
// refresh() has no cancellation. A response for session A that lands after the
// user switched to B used to write A's phase into B's state — and the 5s poll
// plus the bus broadcast multiply how many are in flight at once.
{
  resetState()
  timers.length = 0

  // Hold the first /status response open so it can land late.
  let releaseFirst
  const firstPending = new Promise((resolve) => { releaseFirst = resolve })
  let call = 0
  globalThis.fetch = async (url) => {
    call += 1
    if (call === 1) {
      await firstPending
      // Session A is bound — if this lands, the chip goes to 'bound'.
      return { json: async () => ({ ok: true, connected: true, configured: true, bindings: [{ sessionId: 'sess-A', chatId: 'oc_a' }], pending: [] }) }
    }
    // Session B is unbound.
    return { json: async () => ({ ok: true, connected: true, configured: true, bindings: [], pending: [] }) }
  }

  const seatOpts = registered.find((opts) => opts && opts.id === 'feishu-bind')
  const Seat = seatOpts.view
  Seat({ sessionId: 'sess-A', t: (k) => k })   // starts the held request
  await settle()

  // The user switches session: same slot, new sessionId, new gate.
  reRender()
  Seat({ sessionId: 'sess-B', t: (k) => k })
  await settle()

  // Now A's response finally arrives.
  releaseFirst()
  await settle()
  await settle()

  reRender()
  const view = Seat({ sessionId: 'sess-B', t: (k) => k })
  const labels = walk(view).filter((n) => typeof n === 'string')
  if (labels.includes('seatBound')) {
    throw new Error("session A's late response wrote 'bound' into session B's chip")
  }
  installFetch()
}

// ── a mutation refreshes the OTHER surface, not itself twice ──────────────
// act()/saveConfig()/detach() already await their own refresh(); broadcasting
// to themselves as well fired a second one concurrently, with no ordering
// between the two responses.
{
  resetInstances()
  statusPayload = { ok: true, connected: true, configured: true, bindings: [], pending: [] }
  installFetch()

  const Seat = registered.find((opts) => opts && opts.id === 'feishu-bind').view
  const Section = registered.find((opts) => opts && opts.id === 'feishu').view

  useInstance('seat')
  Seat({ sessionId: 'sess-1', t: (k) => k })
  await settle()
  useInstance('section')
  Section({ t: (k) => k, createSession: async () => {} })
  await settle()

  fetchCalls = []
  useInstance('seat')
  const view = Seat({ sessionId: 'sess-1', t: (k) => k })
  const chip = walk(view).find((n) => typeof n === 'object' && n.props && typeof n.props.onClick === 'function')
  if (chip === undefined) throw new Error('seat chip has no onClick')
  chip.props.onClick()
  await settle()
  await settle()

  // One read for the seat's own refresh, one for the section answering the
  // broadcast. Three means the seat also answered its own.
  const statusReads = fetchCalls.filter((c) => c.method === 'GET' && c.url.includes('/status')).length
  if (statusReads > 2) {
    throw new Error('a mutation caused ' + statusReads + ' status reads; the caller answered its own broadcast')
  }
  if (statusReads < 2) throw new Error('the other surface did not refresh: ' + statusReads + ' status reads')
}

console.log('CLIENT BEHAVIOR SMOKE OK (locale reporting, dictionary parity, api failures, pending poll)')
