// Concurrency smoke for BindingStore: two stores over one file.
//
// The document is written whole, so before syncBeforeMutation() a second
// process holding a stale snapshot erased everything the first created since
// boot. Merging the two states is not expressible — bind() deliberately
// deletes the records it displaces, shiftPending() consumes, settings carry no
// per-key provenance on disk, and evicted image entries have had their files
// deleted — so the store re-reads instead, dropping last-writer-wins from
// whole-document to per-operation granularity.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BindingStore, fileToken } from '../lib/bindings.js'

// A unique directory per run: a fixed temp filename means two concurrent runs
// of the suite fight over the same document.
const dir = mkdtempSync(join(tmpdir(), 'fschannel-conc-'))
const file = join(dir, 'feishu-bindings.json')
process.on('exit', () => { rmSync(dir, { recursive: true, force: true }) })

const quiet = () => {}
const logs = []
const record = (line) => { logs.push(line) }

// ── two processes bind different sessions ─────────────────────────────────
{
  const a = new BindingStore(file, quiet)
  const b = new BindingStore(file, quiet)
  a.bind('sess-a', 'oc_a')
  b.bind('sess-b', 'oc_b')       // b's snapshot predates a's write

  const reloaded = new BindingStore(file, quiet)
  if (reloaded.getBySession('sess-a') === undefined) throw new Error('sess-a lost — b clobbered a')
  if (reloaded.getBySession('sess-b') === undefined) throw new Error('sess-b missing')
  if (reloaded.getByChat('oc_a')?.sessionId !== 'sess-a') throw new Error('chat index for oc_a wrong')
  if (reloaded.getByChat('oc_b')?.sessionId !== 'sess-b') throw new Error('chat index for oc_b wrong')
}

// ── settings from two processes both survive ──────────────────────────────
{
  const a = new BindingStore(file, quiet)
  const b = new BindingStore(file, quiet)
  a.setSettings({ locale: 'en' })
  b.setSettings({ output: 'plain' })

  const reloaded = new BindingStore(file, quiet)
  if (reloaded.settings.locale !== 'en') throw new Error('locale lost: ' + reloaded.settings.locale)
  if (reloaded.settings.output !== 'plain') throw new Error('output lost: ' + reloaded.settings.output)
}

// ── a deletion must NOT be resurrected by the other process's snapshot ────
{
  const a = new BindingStore(file, quiet)
  const b = new BindingStore(file, quiet)   // snapshot still holds sess-a
  a.unbind('sess-a')
  b.setSettings({ showImages: false })      // b re-reads, so it must not restore sess-a

  const reloaded = new BindingStore(file, quiet)
  if (reloaded.getBySession('sess-a') !== undefined) throw new Error('sess-a resurrected by a stale snapshot')
  if (reloaded.getBySession('sess-b') === undefined) throw new Error('sess-b lost')
  if (reloaded.settings.showImages !== false) throw new Error('showImages lost')
}

// ── pending is consumed once, not twice ───────────────────────────────────
{
  const a = new BindingStore(file, quiet)
  a.addPending('sess-p')
  const b = new BindingStore(file, quiet)
  const first = a.shiftPending()
  const second = b.shiftPending()
  if (first !== 'sess-p') throw new Error('first shift wrong: ' + JSON.stringify(first))
  if (second !== undefined) throw new Error('pending consumed twice: ' + JSON.stringify(second))
}

// ── load() is idempotent ──────────────────────────────────────────────────
{
  const store = new BindingStore(file, quiet)
  const before = store.status().bindings.length
  store.load()
  store.load()
  const after = store.status().bindings.length
  if (before !== after) throw new Error(`load() not idempotent: ${before} -> ${after}`)
}

// ── a malformed document is quarantined ───────────────────────────────────
{
  const badFile = join(dir, 'malformed.json')
  writeFileSync(badFile, '{ this is not json')
  logs.length = 0
  const store = new BindingStore(badFile, record)
  if (!logs.some((line) => line.includes('MALFORMED'))) throw new Error('malformed document not reported: ' + logs.join(' | '))
  if (store.status().bindings.length !== 0) throw new Error('malformed document must start empty')
  store.bind('sess-x', 'oc_x')
  if (JSON.parse(readFileSync(badFile, 'utf8')).bindings.length !== 1) throw new Error('store unusable after quarantine')
}

// ── the change token must depend on CONTENT, not on size or mtime ─────────
// It used to be `mtimeMs:size`. touchInbound swaps one fixed-length Feishu
// message id for another, so the document size never moves, and mtime is
// coarse — a stat sweep of this machine's node_modules found 75% of files
// sharing an mtimeMs with at least one other, up to 15 on one value.
//
// Asserting the property directly is the only honest way to pin this. Racing
// two writes and hoping they collide is not a regression test (it passes
// whenever the timing happens not to collide, which is most of the time), and
// forcing the mtime with utimesSync does not work either: it truncates to
// milliseconds while mtimeMs carries a sub-millisecond fraction, so the two
// stamps end up unequal anyway.
{
  const one = join(dir, 'token-a.json')
  const two = join(dir, 'token-b.json')
  const a = '{"lastInboundMessageId":"om_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1"}'
  const b = '{"lastInboundMessageId":"om_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2"}'
  if (a.length !== b.length) throw new Error('test setup: payloads must be the same size')
  writeFileSync(one, a)
  writeFileSync(two, b)

  if (fileToken(one) === fileToken(two)) {
    throw new Error('same-size, different-content documents produced the same token')
  }
  if (fileToken(one) !== fileToken(one)) throw new Error('token is not stable for unchanged content')
  if (fileToken(join(dir, 'no-such-file.json')) !== undefined) throw new Error('missing file must have no token')

  // The discriminating assertion: identical CONTENT written to two paths at
  // two different moments must produce the SAME token. A timestamp-derived
  // token cannot satisfy this, which is what makes it a real regression test —
  // the two assertions above pass under `mtimeMs:size` too, because separate
  // writes naturally land on different mtimes.
  const copyA = join(dir, 'same-a.json')
  const copyB = join(dir, 'same-b.json')
  writeFileSync(copyA, a)
  writeFileSync(copyB, a)
  if (fileToken(copyA) !== fileToken(copyB)) {
    throw new Error('token depends on something other than content — identical documents produced different tokens')
  }

  // And the store must act on it: rewrite the file behind its back, same size.
  const drift = join(dir, 'drift.json')
  const store = new BindingStore(drift, quiet)
  store.bind('sess-d', 'oc_d', undefined, 'om_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1')
  const mine = readFileSync(drift, 'utf8')
  const foreign = mine.replace('om_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'om_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2')
  if (foreign.length !== mine.length) throw new Error('test setup: documents must be the same size')
  writeFileSync(drift, foreign, 'utf8')

  if (!store.fileChangedSinceSync()) throw new Error('a same-size foreign write went undetected')
  store.setSettings({ showImages: false })
  const seen = store.getBySession('sess-d')?.lastInboundMessageId
  if (seen !== 'om_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2') {
    throw new Error('foreign same-size write was not adopted: ' + seen)
  }
}

// ── a store whose file vanished must not resurrect it ─────────────────────
{
  const vanishing = join(dir, 'vanishing.json')
  const store = new BindingStore(vanishing, quiet)
  store.bind('sess-v', 'oc_v')
  if (store.getBySession('sess-v') === undefined) throw new Error('setup failed')
  rmSync(vanishing, { force: true })
  // Any mutation re-reads first, finds nothing, and must adopt "empty" rather
  // than republish what it still holds.
  store.setSettings({ showImages: false })
  if (store.getBySession('sess-v') !== undefined) throw new Error('deleted store was resurrected in memory')
  const after = JSON.parse(readFileSync(vanishing, 'utf8'))
  if (after.bindings.length !== 0) throw new Error('deleted store was republished to disk: ' + JSON.stringify(after.bindings))
}

// ── an unreadable document must abort the mutation, not overwrite it ──────
{
  const guarded = join(dir, 'guarded.json')
  const store = new BindingStore(guarded, quiet)
  store.bind('sess-g', 'oc_g')

  // A transient read failure is what another process's temp+rename produces on
  // Windows (EBUSY/EPERM). Patching fs across ESM module records is not
  // portable, so drive the contract directly: when the re-read fails, every
  // mutator must return its abort value and write nothing.
  const before = JSON.parse(readFileSync(guarded, 'utf8'))
  store.syncBeforeMutation = () => false
  if (store.unbind('sess-g') !== false) throw new Error('unbind must abort when the re-read fails')
  if (store.addPending('sess-x') !== false) throw new Error('addPending must abort when the re-read fails')
  if (store.shiftPending() !== undefined) throw new Error('shiftPending must abort when the re-read fails')
  if (store.setImage('sess-g', 'a.png', '/tmp/a.png').length !== 0) throw new Error('setImage must abort when the re-read fails')
  if (store.removeImage('sess-g', 'a.png') !== false) throw new Error('removeImage must abort when the re-read fails')
  const after = JSON.parse(readFileSync(guarded, 'utf8'))
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('an aborted mutation still wrote to disk')
}

// ── a missing file is first boot, not corruption ──────────────────────────
{
  logs.length = 0
  const store = new BindingStore(join(dir, 'absent.json'), record)
  if (logs.some((line) => line.includes('MALFORMED'))) throw new Error('ENOENT must not be reported as malformed')
  if (!logs.some((line) => line.includes('first boot'))) throw new Error('first boot not reported: ' + logs.join(' | '))
  if (store.status().bindings.length !== 0) throw new Error('fresh store must be empty')
}

console.log('BINDINGS CONCURRENCY SMOKE OK (9 scenarios)')
