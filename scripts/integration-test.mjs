// Integration test: apply() the real host plugin against a mock cordis ctx.
//
// This is the ONLY check that the Feishu transport actually connects with real
// credentials — everything in `npm test` is offline by design. It is excluded
// from the runner and run by hand.
//
// It used to claim that and not do it. The mock ctx had no `credentials`
// service, which `inject` declares as required, so every credential lookup
// threw a TypeError into a catch, resolution fell through to a .env that no
// longer carries credentials, the transport logged "disabled", and the script
// slept fifteen seconds waiting for a connection it had never attempted —
// then printed DONE. A test that cannot fail is worse than no test, so it now
// asserts what it claims and exits non-zero when the claim does not hold.
//
// Usage: credentials come from the DSH credential store by default. Override
// with FEISHU_APP_ID / FEISHU_APP_SECRET in the environment for a one-off run.
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const pluginUrl = new URL('../lib/index.js', import.meta.url)
const mod = await import(pluginUrl.href)
console.log('exports:', Object.keys(mod).join(','), '| name:', mod.name, '| inject:', JSON.stringify(mod.inject))

// ── credentials ───────────────────────────────────────────────────────────
// The plugin asks its credential service; supply one backed by the real DSH
// credential store, or by the environment for a one-off run.
const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')

/** @returns {Record<string, string>} whatever the credential store holds. */
const readStore = () => {
  const path = join(dshHome, '.credentials.yaml')
  /** @type {Record<string, string>} */
  const out = {}
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line.trim())
      if (match !== null) out[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
    }
  } catch {
    // No store: the environment may still supply them.
  }
  return out
}

const store = readStore()
const credentialFor = (name) => process.env[name] ?? store[name]

const credentials = {
  resolve: async (name) => {
    const value = credentialFor(name)
    return value === undefined ? undefined : { value, source: 'integration-test' }
  },
  describe: async (name) => ({ configured: credentialFor(name) !== undefined, writable: false, source: 'integration-test' }),
  set: async () => { throw new Error('integration-test does not write credentials') },
}

if (credentialFor('FEISHU_APP_ID') === undefined || credentialFor('FEISHU_APP_SECRET') === undefined) {
  console.error('integration-test: no FEISHU_APP_ID / FEISHU_APP_SECRET in the environment or ' + join(dshHome, '.credentials.yaml'))
  console.error('integration-test: this test exists to validate a REAL connection; refusing to pass without credentials.')
  process.exit(1)
}

// ── mocked apiProxy ───────────────────────────────────────────────────────
const directoryValue = {
  current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' },
  routable: true,
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-v4-flash',
          name: 'DeepSeek-V4-Flash',
          reasoning: { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' },
        },
      ],
    },
  ],
  failures: [],
}

const modelCalls = []
const apiProxy = {
  sessions: {
    models: async (req) => {
      modelCalls.push(['models', req])
      return { rpcId: req.rpcId, result: { ok: true, value: directoryValue } }
    },
    selectModel: async (req) => {
      modelCalls.push(['selectModel', req])
      const selected = {
        provider: req.payload.provider,
        model: req.payload.model,
        reasoningEffort: req.payload.reasoningEffort,
      }
      return { rpcId: req.rpcId, result: { ok: true, value: { selected } } }
    },
  },
}

// ── mock ctx ──────────────────────────────────────────────────────────────
const registrations = { events: [], routes: [], effects: 0 }
/** @type {Array<() => void>} */
const disposers = []
const logLines = []
const fakeAgent = {
  id: 'sess-x',
  status: 'idle',
  inbox: { nextTurn: [], nextStep: [] },
  followup: (msg) => { console.log('followup:', msg.content[0].text) },
  cancel: (cause) => { console.log('cancel:', cause) },
}
const ctx = {
  logger: {
    info: (...a) => { logLines.push(a.map(String).join(' ')) },
    warn: (...a) => { const line = a.map(String).join(' '); logLines.push(line); console.log('LOG warn:', line) },
    error: (...a) => { const line = a.map(String).join(' '); logLines.push(line); console.log('LOG error:', line) },
  },
  // Collect the disposer. Dropping it made the teardown effect — which
  // disconnects the channel and drains the live maps — unreachable here, so
  // this harness could not exercise the very thing it exists to prove.
  effect(fn) { registrations.effects++; const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  on(event, listener) { registrations.events.push([event, listener]); return () => {} },
  get: (name) => (name === 'apiProxy' ? apiProxy : undefined),
  credentials,
  agents: {
    // Only the one session this harness knows about. Returning a truthy agent
    // for every id made the boot repair pass skip every session silently.
    get: (id) => (id === fakeAgent.id ? fakeAgent : undefined),
    resume: async () => ({ agent: fakeAgent }),
  },
  webServer: { register: (route) => { registrations.routes.push(route); return () => {} } },
}

const envFile = fileURLToPath(new URL('../.env', import.meta.url))
mod.apply(ctx, { envFile, output: 'stream', queueAck: true })

console.log('events registered:', registrations.events.map(([e]) => e).join(','))
console.log('routes registered:', registrations.routes.map((r) => r.kind + ' ' + r.path).join(','))

// Wait for the transport to connect (or fail).
await new Promise((resolve) => setTimeout(resolve, 15000))

// ── assertions ────────────────────────────────────────────────────────────
const fail = (message) => { console.error('integration-test: FAIL - ' + message); process.exit(1) }

if (registrations.routes.length === 0) fail('no HTTP route registered')
if (registrations.effects === 0) fail('no effects registered')
if (disposers.length === 0) fail('no disposer collected — the teardown effect did not register')

// The point of this test: the transport must actually be up.
if (logLines.some((line) => line.includes('bot transport disabled'))) {
  fail('transport disabled — credentials did not resolve, which is exactly what this test exists to catch')
}
if (!logLines.some((line) => line.includes('bot connected'))) {
  fail('no "bot connected" in the log after 15s; the connection did not succeed')
}
console.log('transport: connected')

console.log('modelCalls so far:', modelCalls.length, '(expected 0 - no bound session in this test)')

// Teardown must close the channel, or this process hangs on its WebSocket.
for (const dispose of disposers) {
  try { dispose() } catch (error) { console.log('dispose failed:', String(error)) }
}
console.log('teardown: ran', disposers.length, 'disposers')

console.log('DONE')
// The channel's socket and the SDK's reconnect timers keep the loop alive
// even after disconnect(); exiting explicitly is the contract, not luck.
process.exit(0)
