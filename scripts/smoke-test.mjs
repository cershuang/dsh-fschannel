// Quick smoke test for env parser + binding store.
import { readFileSync, rmSync } from 'node:fs'
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
const store = new BindingStore(file, (l) => console.log('log:', l))
store.addPending('sess-1')
store.bind('sess-1', 'oc_chatA', 'Team Room', 'msg-1')
store.setModelRoute('sess-1', { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
store.addPending('sess-2')
store.bind('sess-3', 'oc_chatB')
console.log('status:', JSON.stringify(store.status()))
const rec = store.getByChat('oc_chatA')
if (rec.sessionId !== 'sess-1' || rec.modelRoute.model !== 'deepseek-v4-pro') throw new Error('modelRoute failed')
store.unbind('sess-1')
store.setAutoBindNewSession(true)

const store2 = new BindingStore(file, () => {})
console.log('reloaded:', JSON.stringify(store2.status()))
if (!store2.settings.autoBindNewSession) throw new Error('settings persistence failed')
rmSync(file, { force: true })
console.log('ALL OK')
