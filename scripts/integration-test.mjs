// Integration test: apply() the real host plugin against a mock cordis ctx.
// The Feishu transport connects for REAL (validates credentials + long connection);
// the apiProxy is mocked and records model calls.
import { fileURLToPath } from 'node:url'

const pluginUrl = new URL('../lib/index.js', import.meta.url)
const mod = await import(pluginUrl.href)
console.log('exports:', Object.keys(mod).join(','), '| name:', mod.name, '| inject:', JSON.stringify(mod.inject))

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

const registrations = { events: [], routes: [], effects: 0 }
const fakeAgent = {
  id: 'sess-x',
  status: 'idle',
  inbox: { nextTurn: [], nextStep: [] },
  followup: (msg) => { console.log('followup:', msg.content[0].text) },
  cancel: (cause) => { console.log('cancel:', cause) },
}
const ctx = {
  logger: {
    info: () => {},
    warn: (...a) => console.log('LOG warn:', a.map(String).join(' ')),
    error: (...a) => console.log('LOG error:', a.map(String).join(' ')),
  },
  effect(fn) { registrations.effects++; fn() },
  on(event, listener) { registrations.events.push([event, listener]); return () => {} },
  get: (name) => (name === 'apiProxy' ? apiProxy : undefined),
  agents: {
    get: () => fakeAgent,
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
console.log('modelCalls so far:', modelCalls.length, '(expected 0 - no bound session in this test)')
console.log('DONE')
