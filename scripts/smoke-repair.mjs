// Smoke test for the session-log repair module: marks historical feishu/image
// events as ignorable (so the harness accepts the log again) and round-trips
// through zstd frames.
import { zstdCompressSync, constants } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { markForeignEventsIgnorable, decodeFrames } from '../lib/repair.js'

const opts = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const lines = [
  JSON.stringify({ type: 'user/message', seq: 1, data: { text: 'hi' } }),
  JSON.stringify({ type: 'feishu/image', seq: 2, data: { name: 'feishu-abc.png' } }),
  JSON.stringify({ type: 'assistant/message', seq: 3, data: { text: 'ok' } }),
]
const text = lines.join('\n') + '\n'
const result = markForeignEventsIgnorable(text)
if (result.patched !== 1) throw new Error('expected 1 patched event, got ' + result.patched)
const patched = result.text
if (!patched.includes('"ignorable":true')) throw new Error('ignorable marker missing')
// Already-marked events are left alone.
const again = markForeignEventsIgnorable(patched)
if (again.patched !== 0) throw new Error('second pass must patch nothing')
const reDecoded = decodeFrames(zstdCompressSync(patched, opts))
if (!reDecoded.includes('feishu/image')) throw new Error('roundtrip lost event')
const count = (patched.match(/feishu\/image/g) || []).length
if (count !== 1) throw new Error('unexpected feishu/image mentions: ' + count)
console.log('REPAIR SMOKE OK')
