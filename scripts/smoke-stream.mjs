// Smoke test: StreamHandle placeholder, set/append order, messageId capture, fallback.
import { StreamHandle } from '../lib/stream.js'

// Fake transport.
const calls = []
const port = {
  stream: async (chatId, input, opts) => {
    const controller = {
      append: async (t) => { calls.push(['append', t]) },
      setContent: async (t) => { calls.push(['set', t]) },
    }
    await input.markdown(controller)
    return { messageId: 'om_card1' }
  },
  send: async () => { calls.push(['fallback-send']) },
}

const handle = new StreamHandle(port, 'oc_chat', undefined, () => {}, '正在处理…')
handle.append('hello')
handle.append(' world')
handle.set('最终结果')
await handle.finish()
const kinds = calls.map((c) => c[0]).join(',')
console.log('ops:', kinds)
if (kinds !== 'set,append,append,set') throw new Error('unexpected op order: ' + kinds)
if (calls[0][1] !== '正在处理…') throw new Error('placeholder missing')
if (calls[calls.length - 1][1] !== '最终结果') throw new Error('final content missing')
if (handle.messageId !== 'om_card1') throw new Error('messageId not captured')
if (handle.full !== '最终结果') throw new Error('full should exclude placeholder: ' + handle.full)

// Fallback path: stream rejects -> accumulated text sent as plain message.
const failCalls = []
const failPort = {
  stream: async () => { throw new Error('no card permission') },
  send: async (chatId, input) => { failCalls.push(input.markdown) },
}
const h2 = new StreamHandle(failPort, 'oc_chat', undefined, () => {})
h2.append('fallback text')
await h2.finish()
if (failCalls.length !== 1 || failCalls[0] !== 'fallback text') throw new Error('fallback send missing')
if (h2.messageId !== undefined) throw new Error('failed stream must have no messageId')
console.log('STREAM SMOKE OK')
