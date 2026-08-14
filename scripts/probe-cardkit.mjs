// Probe: does the app now hold cardkit:card:write? (correct payload shape)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from '../lib/env.js'

const map = parseEnv(readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8'))
const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ app_id: map.feishu_app_id, app_secret: map.feishu_app_secret }),
}).then((r) => r.json())
if (tokenRes.code !== 0) { console.log('token failed:', tokenRes); process.exit(1) }
const headers = { authorization: 'Bearer ' + tokenRes.tenant_access_token, 'content-type': 'application/json' }

const spec = {
  schema: '2.0',
  config: { streaming_mode: true, summary: { content: '[Generating...]' }, streaming_config: { print_strategy: 'fast' } },
  body: { elements: [{ tag: 'markdown', element_id: 'stream_md', content: 'probe' }] },
}
console.log('=== cardkit.v1.card.create (card_json) probe ===')
const cardRes = await fetch('https://open.feishu.cn/open-apis/cardkit/v1/cards', {
  method: 'POST',
  headers,
  body: JSON.stringify({ type: 'card_json', data: JSON.stringify(spec) }),
}).then((r) => r.json())
console.log('create:', JSON.stringify({ code: cardRes.code, msg: cardRes.msg, hasCardId: Boolean(cardRes.data?.card_id) }))
if (cardRes.code !== 0) { console.log('cardkit NOT available'); process.exit(0) }
const cardId = cardRes.data.card_id
console.log('card_id:', cardId)
const del = await fetch('https://open.feishu.cn/open-apis/cardkit/v1/cards/' + cardId, { method: 'DELETE', headers }).then((r) => r.json())
console.log('delete probe card:', del.code === 0 ? 'ok' : JSON.stringify(del))
console.log('cardkit GRANTED and WORKING')
