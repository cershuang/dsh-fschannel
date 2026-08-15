// Smoke test for the session-log repair module:
// 1. marks historical feishu/image events as ignorable (harness accepts them)
// 2. drops harness-synthesized interrupted closer blocks that conflict with
//    real continuation events (duplicate-seq logs the harness refuses)
// Both round-trip through zstd frames.
import { zstdCompressSync, constants } from 'node:zlib'
import { markForeignEventsIgnorable, repairSeqConflicts, decodeFrames } from '../lib/repair.js'

const opts = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

// ── 1. ignorable marker ────────────────────────────────────────────────────
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
const again = markForeignEventsIgnorable(patched)
if (again.patched !== 0) throw new Error('second pass must patch nothing')
const reDecoded = decodeFrames(zstdCompressSync(patched, opts))
if (!reDecoded.includes('feishu/image')) throw new Error('roundtrip lost event')
const count = (patched.match(/feishu\/image/g) || []).length
if (count !== 1) throw new Error('unexpected feishu/image mentions: ' + count)

// ── 2. seq-conflict closer removal ─────────────────────────────────────────
// A log where a tool call was interrupted (synthetic closers at seq 3-5) but
// the turn actually continued (real events reuse seq 3+).
const synthId = 'interrupted-tool-result-call_00_abc-3'
const conflictText = [
  JSON.stringify({ type: 'session', version: 0, id: 'session-x', createdAt: 1, cwd: 'C:/x' }),
  JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
  JSON.stringify({ type: 'user/message', seq: 1, time: 1, data: { text: 'go' } }),
  JSON.stringify({ type: 'tool/call', seq: 2, time: 1, data: { turn: 1, step: 1, callId: 'call_00_abc', name: 'pwsh' } }),
  // synthetic interrupted closers (seq 3-5)
  JSON.stringify({ type: 'tool/result', seq: 3, time: 1, data: { turn: 1, step: 1, message: { id: synthId, role: 'user', source: { kind: 'tool', callId: 'call_00_abc' }, content: [] } } }),
  JSON.stringify({ type: 'step/end', seq: 4, time: 1, data: { turn: 1, step: 1 } }),
  JSON.stringify({ type: 'turn/end', seq: 5, time: 1, data: { turn: 1, reason: { kind: 'interrupted' } } }),
  // real continuation reusing seq 3-5 (the tool actually finished)
  JSON.stringify({ type: 'tool/result', seq: 3, time: 2, data: { turn: 1, step: 1, message: { id: 'real-result', role: 'user', source: { kind: 'tool', callId: 'call_00_abc' }, content: [] } } }),
  JSON.stringify({ type: 'step/end', seq: 4, time: 2, data: { turn: 1, step: 1 } }),
  JSON.stringify({ type: 'step/start', seq: 5, time: 2, data: { turn: 1, step: 2 } }),
  JSON.stringify({ type: 'assistant/message', seq: 6, time: 2, data: { turn: 1, step: 2, message: { id: 'm', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [] } } }),
  JSON.stringify({ type: 'turn/end', seq: 7, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
].join('\n') + '\n'

const fixed = repairSeqConflicts(conflictText)
if (fixed.removed !== 1) throw new Error('expected 1 closer block removed, got ' + fixed.removed)
if (fixed.text.includes(synthId)) throw new Error('synthetic closer block still present')
// The real continuation must survive.
if (!fixed.text.includes('real-result')) throw new Error('real continuation lost')
// The header must be intact.
if (!fixed.text.startsWith('{"type":"session"')) throw new Error('header lost')

// A clean log must be untouched.
const clean = repairSeqConflicts(text)
if (clean.removed !== 0 || clean.text !== text) throw new Error('clean log must pass through unchanged')

// Round-trip the repaired text through zstd.
const reFixed = decodeFrames(zstdCompressSync(fixed.text, opts))
if (!reFixed.includes('real-result') || reFixed.includes(synthId)) throw new Error('repaired roundtrip mismatch')

console.log('REPAIR SMOKE OK')
