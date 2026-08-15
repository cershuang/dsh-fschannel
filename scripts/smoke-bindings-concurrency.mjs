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
import { BindingStore } from '../lib/bindings.js'

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

// ── a missing file is first boot, not corruption ──────────────────────────
{
  logs.length = 0
  const store = new BindingStore(join(dir, 'absent.json'), record)
  if (logs.some((line) => line.includes('MALFORMED'))) throw new Error('ENOENT must not be reported as malformed')
  if (!logs.some((line) => line.includes('first boot'))) throw new Error('first boot not reported: ' + logs.join(' | '))
  if (store.status().bindings.length !== 0) throw new Error('fresh store must be empty')
}

console.log('BINDINGS CONCURRENCY SMOKE OK (6 scenarios)')
