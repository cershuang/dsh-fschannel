// Quick smoke test for env parser + binding store (pending entries carry timestamps).
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv, resolveCredentials } from '../lib/env.js'
import { BindingStore } from '../lib/bindings.js'

const envPath = fileURLToPath(new URL('../.env', import.meta.url))
const text = readFileSync(envPath, 'utf8')
const map = parseEnv(text)
console.log('keys:', Object.keys(map).join(','))
if (!/^cli_[A-Za-z0-9]{8,40}$/.test(map.feishu_app_id)) throw new Error('standard key missing or wrong format')

const creds = resolveCredentials(envPath, {})
console.log('appId:', creds.appId, '| secret len:', creds.appSecret.length)
if (creds.appId !== map.feishu_app_id || creds.appSecret.length < 20) throw new Error('credential resolution failed')

// Legacy format compatibility.
const legacy = resolveCredentials(undefined, { appId: 'cli_x', appSecret: 'legacy-secret' })
if (legacy.appId !== 'cli_x') throw new Error('direct config failed')

const file = process.env.TEMP + '/feishu-bindings-test.json'
// Legacy pending shape (plain strings) must migrate.
writeFileSync(file, JSON.stringify({ bindings: [], pending: ['old-pending-session'], settings: { autoBindNewSession: false } }))
const store = new BindingStore(file, (l) => console.log('log:', l))
const migrated = store.status().pending
if (migrated.length !== 1 || migrated[0].sessionId !== 'old-pending-session') throw new Error('legacy pending migration failed')
store.addPending('sess-1')
store.bind('sess-1', 'oc_chatA', 'Team Room', 'msg-1')
store.setModelRoute('sess-1', { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
store.addPending('sess-2')
store.addPending('sess-3')
store.addPending('sess-3')
console.log('status:', JSON.stringify(store.status()))
const pendings = store.status().pending
if (pendings.length !== 3) throw new Error('pending count: ' + pendings.length)
if (pendings.every((p) => typeof p.at !== 'number')) throw new Error('pending timestamps missing')
const shifted = store.shiftPending()
if (shifted !== 'old-pending-session') throw new Error('FIFO shift wrong: ' + shifted)
if (!store.removePending('sess-2')) throw new Error('removePending failed')
store.unbind('sess-1')
console.log('after ops:', JSON.stringify(store.status()))
store.setAutoBindNewSession(true)

const store2 = new BindingStore(file, () => {})
console.log('reloaded:', JSON.stringify(store2.status()))
if (!store2.settings.autoBindNewSession) throw new Error('settings persistence failed')
if (store2.status().pending.some((p) => p.sessionId === 'sess-2')) throw new Error('removed pending resurrected')
rmSync(file, { force: true })
console.log('ALL OK')
