// Quick smoke test for env parser + binding store (pending entries carry timestamps).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { maskSecret, parseEnv, resolveCredentials } from '../lib/env.js'
import { BindingStore } from '../lib/bindings.js'

// Prefer the developer's real .env, but fall back to example.env so a fresh
// clone (and CI) can run this without one. Every assertion below holds for
// both: neither file may carry credentials, and both set the path keys.
const realEnv = fileURLToPath(new URL('../.env', import.meta.url))
const envPath = existsSync(realEnv) ? realEnv : fileURLToPath(new URL('../example.env', import.meta.url))
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

// A unique directory per run: a fixed temp filename makes two concurrent runs
// of this suite fight over the same document.
const workDir = mkdtempSync(join(tmpdir(), 'fschannel-smoke-'))
process.on('exit', () => { rmSync(workDir, { recursive: true, force: true }) })
const file = join(workDir, 'feishu-bindings-test.json')
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
// A session's model route must survive a re-bind. It is chosen per session
// (/model use), not per chat, and dropping it here made replayModelRoute a
// guaranteed no-op on every bind path — the user's model choice silently
// reverted to the default the next time the session reconnected.
{
  const routeFile = join(workDir, 'model-route.json')
  const store = new BindingStore(routeFile, () => {})
  store.bind('sess-r', 'oc_first')
  store.setModelRoute('sess-r', { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' })

  // Same session, new chat: the route rides along.
  store.bind('sess-r', 'oc_second')
  const kept = store.getBySession('sess-r')?.modelRoute
  if (kept === undefined) throw new Error('model route lost on re-bind')
  if (kept.model !== 'deepseek-v4-flash' || kept.reasoningEffort !== 'max') {
    throw new Error('model route mangled on re-bind: ' + JSON.stringify(kept))
  }
  // And it survives a reload, i.e. the carried route was actually persisted.
  if (new BindingStore(routeFile, () => {}).getBySession('sess-r')?.modelRoute?.model !== 'deepseek-v4-flash') {
    throw new Error('carried model route was not persisted')
  }

  // A DIFFERENT session taking over that chat displaces the old record whole,
  // so its route goes with it rather than leaking onto the newcomer.
  store.bind('sess-other', 'oc_second')
  if (store.getBySession('sess-r') !== undefined) throw new Error('displaced session survived')
  if (store.getBySession('sess-other')?.modelRoute !== undefined) {
    throw new Error('displaced session leaked its model route to the newcomer')
  }
}

// Credential precedence is per VALUE, not per tier. It used to be tier-atomic,
// so the arrangement cordis.patch.yml itself suggests — appId in the entry
// config, secret in the credential store — matched no tier and the store's
// secret was silently discarded, disabling the transport.
{
  const storeOnly = async (name) => (name === 'FEISHU_APP_ID' ? 'cli_store' : name === 'FEISHU_APP_SECRET' ? 'store-secret' : undefined)
  const secretOnly = async (name) => (name === 'FEISHU_APP_SECRET' ? 'store-secret' : undefined)
  const none = async () => undefined

  const bothEntry = await resolveCredentials(undefined, { appId: 'cli_entry', appSecret: 'entry-secret' }, none)
  if (bothEntry.appId !== 'cli_entry' || bothEntry.appSecret !== 'entry-secret') throw new Error('entry tier broken')
  if (bothEntry.source !== 'entry') throw new Error('entry source wrong: ' + bothEntry.source)

  const bothStore = await resolveCredentials(undefined, {}, storeOnly)
  if (bothStore.appId !== 'cli_store' || bothStore.appSecret !== 'store-secret') throw new Error('store tier broken')
  if (bothStore.source !== 'credentials') throw new Error('store source wrong: ' + bothStore.source)

  // The mixed case: the whole point of this fix.
  const mixed = await resolveCredentials(undefined, { appId: 'cli_entry' }, secretOnly)
  if (mixed.appId !== 'cli_entry') throw new Error('mixed: entry appId lost')
  if (mixed.appSecret !== 'store-secret') throw new Error('mixed: store secret was discarded — the transport would be disabled')
  if (mixed.source !== 'mixed') throw new Error('mixed: source should say so, got ' + mixed.source)

  // Entry still outranks the store per value.
  const override = await resolveCredentials(undefined, { appId: 'cli_entry' }, storeOnly)
  if (override.appId !== 'cli_entry') throw new Error('entry must outrank the store for appId')
  if (override.appSecret !== 'store-secret') throw new Error('store must supply the secret entry did not')
}

// maskSecret must never return the value it was asked to mask. The head and
// tail windows are 6 and 4 characters, so anything up to length 10 overlapped
// and came back whole — and this result goes to a log file.
// Checking `masked.includes(value)` is NOT enough: at length 10 the old code
// produced 'abcdef…ghij', which contains every character of the input with an
// ellipsis wedged in the middle. The property that matters is that some
// characters are actually withheld.
for (const value of ['abcdefgh', 'abcdefghi', 'abcdefghij', 'abcdefghijk', 'cli_a1b2c3d4e5f6g7h8i9j0']) {
  const masked = maskSecret(value)
  const revealed = masked.split('…').join('')
  if (revealed.length >= value.length && revealed !== '••••••') {
    throw new Error(`maskSecret revealed all ${value.length} chars: ${masked}`)
  }
}

rmSync(file, { force: true })
console.log('ALL OK')
