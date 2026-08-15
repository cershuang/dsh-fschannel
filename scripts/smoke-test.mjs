// Quick smoke test for env parser + binding store (pending entries carry timestamps).
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv, resolveCredentials } from '../lib/env.js'
import { BindingStore } from '../lib/bindings.js'

const envPath = fileURLToPath(new URL('../.env', import.meta.url))
const text = readFileSync(envPath, 'utf8')
const map = parseEnv(text)
console.log('keys:', Object.keys(map).join(','))
if (typeof map.fschannel_repo !== 'string' || map.fschannel_repo === '') throw new Error('path config missing')
if (map.feishu_app_id !== undefined) throw new Error('.env must not carry credentials')

const creds = await resolveCredentials(envPath, {}, async () => undefined)
console.log('appId:', JSON.stringify(creds.appId), '| secret:', JSON.stringify(creds.appSecret), '| source:', creds.source)
if (creds.appId !== '' || creds.appSecret !== '') throw new Error('.env must not resolve credentials')

// The credential service (store) outranks the env file.
const fromStore = await resolveCredentials(undefined, {}, async (name) => name === 'FEISHU_APP_ID' ? 'cli_store_app' : 'store-secret-value')
if (fromStore.appId !== 'cli_store_app' || fromStore.source !== 'credentials') throw new Error('store layering failed')

// Legacy format compatibility.
const legacy = await resolveCredentials(undefined, { appId: 'cli_x', appSecret: 'legacy-secret' }, async () => undefined)
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
store.setImage('sess-1', 'feishu-abc.png', 'C:/sessions/sess-1/.dsh-fschannel-images/feishu-abc.png')
if (store.imagePath('sess-1', 'feishu-abc.png') !== 'C:/sessions/sess-1/.dsh-fschannel-images/feishu-abc.png') {
  throw new Error('image index set/get failed')
}
if (store.imagePath('sess-1', 'feishu-other.png') !== undefined) throw new Error('image index miss must be undefined')
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
store.setSettings({ autoBindNewSession: true })

const store2 = new BindingStore(file, () => {})
console.log('reloaded:', JSON.stringify(store2.status()))
if (!store2.settings.autoBindNewSession) throw new Error('settings persistence failed')
if (store2.status().pending.some((p) => p.sessionId === 'sess-2')) throw new Error('removed pending resurrected')
if (store2.imagePath('sess-1', 'feishu-abc.png') !== 'C:/sessions/sess-1/.dsh-fschannel-images/feishu-abc.png') {
  throw new Error('image index persistence failed')
}
// The per-session cap keeps the index bounded and reports evictions.
let evictedAny = false
for (let i = 0; i < 60; i++) {
  const evicted = store2.setImage('sess-9', `feishu-${i}.png`, `C:/x/${i}.png`)
  if (evicted.length > 0) evictedAny = true
}
if (store2.imagePath('sess-9', 'feishu-0.png') !== undefined) throw new Error('image index cap not enforced')
if (store2.imagePath('sess-9', 'feishu-59.png') === undefined) throw new Error('image index cap dropped newest')
if (!evictedAny) throw new Error('image index eviction report missing')
const evicted = store2.setImage('sess-9', 'feishu-60.png', 'C:/x/60.png')
if (evicted.length !== 1 || evicted[0] !== 'C:/x/10.png') throw new Error('eviction order wrong: ' + JSON.stringify(evicted))
rmSync(file, { force: true })
console.log('ALL OK')
