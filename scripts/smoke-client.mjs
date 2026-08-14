// Smoke test: load lib/client.js as the browser would and drive apply().
import { copyFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const copyPath = fileURLToPath(new URL('../lib/client.smoke.cjs', import.meta.url))
copyFileSync(bundlePath, copyPath)

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
const plugin = require(copyPath)
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
}
exportsObj.apply(ctx)
const names = registered.map((o) => o.name).join(',')
console.log('registered slots:', names)
if (!names.includes('conversation.session.header.actions') || !names.includes('settings.section')) {
  throw new Error('slot registration missing')
}
const settingsOpts = registered.find((o) => o.name === 'settings.section')
if (typeof settingsOpts.label !== 'function') throw new Error('section label missing')
const injected = settingsOpts.inject()
if (typeof injected.createSession !== 'function') throw new Error('createSession prop missing')
await injected.createSession()
if (startSessionCalls !== 1) throw new Error('startSession not called')
rmSync(copyPath, { force: true })
console.log('CLIENT SMOKE OK')
