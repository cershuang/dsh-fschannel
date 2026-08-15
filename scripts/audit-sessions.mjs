// Audit every session log under $DSH_HOME/sessions for seq conflicts the
// harness would reject (non-contiguous event seqs). Prints a report; exits
// non-zero when any session is broken.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decodeFrames } from '../lib/repair.js'
import { readFileSync } from 'node:fs'

// Honour DSH_HOME like the plugin does (lib/index.js), instead of assuming
// the default location — otherwise this audits the wrong tree entirely.
const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')
const sessionsRoot = join(dshHome, 'sessions')
const broken = []
let scanned = 0
for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  const projectDir = join(sessionsRoot, project.name)
  let sessions
  try { sessions = readdirSync(projectDir, { withFileTypes: true }) } catch { continue }
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const logPath = join(projectDir, session.name, 'session.jsonl.zstd')
    try { if (!statSync(logPath).isFile()) continue } catch { continue }
    scanned += 1
    let text
    try { text = decodeFrames(readFileSync(logPath)) } catch (error) {
      broken.push({ sessionId: session.name, issue: 'decode: ' + (error instanceof Error ? error.message : String(error)) })
      continue
    }
    let seq = 0
    let bad = 0
    let firstBad = ''
    for (const line of text.split('\n')) {
      if (line === '') continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      if (record === null || typeof record !== 'object' || record.type === 'session') continue
      const members = []
      if (['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(record.type)) {
        const arr = record.type === 'tool-call-chunks' ? record.data?.args : record.data?.texts
        if (Array.isArray(arr) && typeof record.seq0 === 'number') {
          for (let k = 0; k < arr.length; k++) members.push(record.seq0 + k)
        }
      } else if (typeof record.seq === 'number') members.push(record.seq)
      for (const s of members) {
        if (s !== seq) {
          bad++
          if (firstBad === '') firstBad = `seq=${s} expected=${seq}`
        }
        seq++
      }
    }
    if (bad > 0) broken.push({ sessionId: session.name, issue: `seq conflict: ${bad} violation(s), first: ${firstBad}` })
  }
}
console.log(`scanned ${scanned} session logs`)
if (broken.length === 0) {
  console.log('AUDIT OK — no broken sessions')
} else {
  console.log(`BROKEN: ${broken.length}`)
  for (const b of broken) console.log(`  ${b.sessionId}: ${b.issue}`)
  process.exitCode = 1
}
