// Smoke test: load lib/client.js as the browser would and drive apply().
import { copyFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const copyPath = fileURLToPath(new URL('../lib/client.smoke.cjs', import.meta.url))
copyFileSync(bundlePath, copyPath)
// Clean up however this script ends. The old trailing rmSync only ran on the
// success path, so any failure left an untracked CJS copy of the bundle in
// lib/ — which `files: ["lib"]` would happily publish.
process.on('exit', () => { rmSync(copyPath, { force: true }) })

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(handoff) { captured = handoff },
  },
}

const fakeReact = {
  createElement: () => ({}),
  Fragment: Symbol('fragment'),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

require.cache = require.cache || {}
// Loaded for its side effect: the bundle calls window.__ModuleLoader__.load().
require(copyPath)
if (captured === null) throw new Error('load() was not called')
if (captured.id !== 'dsh-fschannel') throw new Error('wrong id: ' + captured.id)

const exportsObj = captured.factory((spec) => {
  if (spec === 'react') return fakeReact
  throw new Error('unexpected require: ' + spec)
})
console.log('exports keys:', Object.keys(exportsObj).join(','), '| inject:', JSON.stringify(exportsObj.inject))
if (typeof exportsObj.apply !== 'function') throw new Error('apply missing')
if (!exportsObj.inject.includes('workspaces')) throw new Error('workspaces not injected')

const registered = []
// Record timers instead of arming them. createConnectedSession sets a 60s
// disarm timeout (src/client/index.jsx), and a real one kept this process
// alive for a full minute after the assertions had already passed — the suite
// silently cost 60s on every run. Recording also makes the disarm assertable.
/** @type {Array<{ ms: number, fn: Function, cleared: boolean }>} */
const timeouts = []
globalThis.setTimeout = (fn, ms) => { timeouts.push({ fn, ms, cleared: false }); return timeouts.length - 1 }
globalThis.clearTimeout = (id) => { if (timeouts[id] !== undefined) timeouts[id].cleared = true }

let startSessionCalls = 0
const ctx = {
  effect(fn, label) { fn(); return () => {} },
  on() { return () => {} },
  off() {},
  locale: { register(ns, dict) { console.log('locale registered:', ns, Object.keys(dict.zh).length, 'zh keys') }, bind: () => () => 'Feishu Bot' },
  sessions: {
    list: {
      getSnapshot: () => ({ byId: {} }),
      subscribe: () => () => {},
    },
  },
  workspaces: {
    startSession: async () => { startSessionCalls++ },
  },
  slots: {
    inject(name, cb) { const opts = cb(); registered.push(opts) },
    register: (opts) => { registered.push(opts); return () => {} },
  },
  get(name) {
    if (name === 'conversationEvents') {
      return { register: (def) => { registered.push({ name: 'conversationEvents.register', kind: def.kind }) } }
    }
    return undefined
  },
}
exportsObj.apply(ctx)
const names = registered.map((o) => o.name).join(',')
console.log('registered slots:', names)
if (!names.includes('conversation.session.header.actions') || !names.includes('settings.section')) {
  throw new Error('slot registration missing')
}
const nodeOpts = registered.find((o) => o.name === 'conversation.chat.node')
if (nodeOpts === undefined || nodeOpts.key !== 'feishu-image') throw new Error('image node slot missing')
const defReg = registered.find((o) => o.name === 'conversationEvents.register')
if (defReg === undefined || defReg.kind !== 'feishu-image') throw new Error('image node definition missing')
const settingsOpts = registered.find((o) => o.name === 'settings.section')
if (typeof settingsOpts.label !== 'function') throw new Error('section label missing')
const injected = settingsOpts.inject()
if (typeof injected.createSession !== 'function') throw new Error('createSession prop missing')
await injected.createSession()
if (startSessionCalls !== 1) throw new Error('startSession not called')

// The staged auto-bind window: createConnectedSession arms a 60s disarm so a
// session created later by other means is never surprise-bound.
const disarm = timeouts.find((timer) => timer.ms === 60000)
if (disarm === undefined) {
  throw new Error('auto-bind disarm timer not armed: ' + JSON.stringify(timeouts.map((t) => t.ms)))
}
if (typeof disarm.fn !== 'function') throw new Error('disarm timer has no callback')

console.log('CLIENT SMOKE OK')
