// End-to-end lifecycle for a staged image: index -> TTL expiry -> prune ->
// de-index.
//
// This exists because the de-index was shipped broken and every gate passed.
// The index key is the STAGED basename (`feishu-<uuid>.png`), but the caller
// passed `pruned.name`, which is the SENDER's original file name — a field
// Feishu usually omits entirely. So removeImage() could never match, the bytes
// were deleted, and the index row survived forever: the gallery listed an
// entry whose image 404s, permanently.
//
// The suite that existed asserted only prune()'s RETURN SHAPE. Shape is not
// behaviour. This one asserts the row is actually gone, which is the only
// assertion that would have failed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { BindingStore } from '../lib/bindings.js'
import { HeldImageBuffer } from '../lib/images.js'

const dir = mkdtempSync(join(tmpdir(), 'fschannel-life-'))
process.on('exit', () => { rmSync(dir, { recursive: true, force: true }) })

const file = join(dir, 'feishu-bindings.json')
const store = new BindingStore(file, () => {})
const held = new HeldImageBuffer()

const CHAT = 'oc_lifecycle'
const SESSION = 'session-lifecycle'
store.bind(SESSION, CHAT)

// Stage an image the way ingestImages does: a server-generated staged name on
// disk, and the sender's own file name kept only as display metadata.
const stagedPath = join(dir, 'feishu-11111111-2222-3333-4444-555555555555.png')
writeFileSync(stagedPath, 'not really a png')
const stagedFile = {
  path: stagedPath,
  name: undefined,          // Feishu omits fileName for ordinary image messages
  bytes: 16,
  mediaType: 'image/png',
}
held.add(CHAT, stagedFile)
store.setImage(SESSION, basename(stagedFile.path), stagedFile.path, {
  mediaType: stagedFile.mediaType,
  bytes: stagedFile.bytes,
  fileName: stagedFile.name ?? '',
})

if (store.imagesList(SESSION).length !== 1) throw new Error('image was not indexed')
if (store.imagePath(SESSION, basename(stagedPath)) !== stagedPath) throw new Error('index points at the wrong path')

// Age the holding past the TTL, then prune the way ingestImages does.
const entry = held.entries.get(CHAT)
entry.receivedAt = Date.now() - 10_000
const pruned = held.prune(1000)
if (pruned.length !== 1) throw new Error('expected one pruned file, got ' + pruned.length)

// The de-index, exactly as lib/index.js performs it.
for (const item of pruned) {
  rmSync(item.path, { force: true })
  const owner = store.getByChat(item.chatId)
  if (owner !== undefined) store.removeImage(owner.sessionId, basename(item.path))
}

// THE assertion. Deleting the bytes while leaving the row is the whole bug.
const remaining = store.imagesList(SESSION)
if (remaining.length !== 0) {
  throw new Error('index row survived the prune — the gallery would list a permanently 404ing image: ' + JSON.stringify(remaining))
}
if (store.imagePath(SESSION, basename(stagedPath)) !== undefined) throw new Error('imagePath still resolves a deleted file')

// And it must survive a reload, i.e. the removal was actually persisted.
const reloaded = new BindingStore(file, () => {})
if (reloaded.imagesList(SESSION).length !== 0) throw new Error('index row came back after reload — removeImage did not persist')

// A sender-supplied file name must not change any of this: it is display
// metadata, never a key.
{
  const p2 = join(dir, 'feishu-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png')
  writeFileSync(p2, 'x')
  const withName = { path: p2, name: 'holiday photo.png', bytes: 1, mediaType: 'image/png' }
  held.add(CHAT, withName)
  store.setImage(SESSION, basename(p2), p2, { mediaType: 'image/png', bytes: 1, fileName: withName.name })
  held.entries.get(CHAT).receivedAt = Date.now() - 10_000
  for (const item of held.prune(1000)) {
    rmSync(item.path, { force: true })
    const owner = store.getByChat(item.chatId)
    if (owner !== undefined) store.removeImage(owner.sessionId, basename(item.path))
  }
  if (store.imagesList(SESSION).length !== 0) throw new Error('de-index failed when the sender supplied a file name')
}

console.log('IMAGE LIFECYCLE SMOKE OK (index -> expire -> prune -> de-index, persisted)')
