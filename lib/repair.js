// @ts-check
/**
 * Session-log repair for the harness's JSONL persistence backend.
 *
 * Older dsh-fschannel builds appended `feishu/image` events into bound DSH
 * session logs. Those events are unknown to the harness's event vocabulary,
 * and the persistence read path refuses to interpret a log containing an
 * unknown, non-`ignorable` event type (the whole session then fails to load).
 * The harness DOES accept the same event when its envelope carries the
 * `ignorable: true` marker — the event is kept in the log (so clients that
 * render it keep working) but the type check is waived.
 *
 * This module rewrites such logs in place: it decompresses the complete
 * Zstandard frames, marks every `feishu/image` event envelope as ignorable,
 * and atomically publishes the result (temp file + rename, matching the
 * backend's own write discipline). Safety contract for callers: only repair
 * sessions whose agent is NOT live — the backend appends batches through an
 * `open(path, "a")` handle only while a session is live, so a non-live log is
 * byte-stable and a rename cannot race a writer.
 * @module dsh-fschannel/repair
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Zstandard frame magic (LE bytes `28 B5 2F FD`). */
const ZSTD_MAGIC = 4247762216

/** Compression options matching the harness JSONL backend (`checksumFlag: 1`). */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** The event type this repair marks ignorable. */
export const FOREIGN_EVENT_TYPE = 'feishu/image'

/** A stable snapshot of one file's write identity (mtime + size). */
const fileFingerprint = (path) => {
  const stat = statSync(path)
  return `${stat.mtimeMs}:${stat.size}`
}

/**
 * Locate the ranges of complete Zstandard frames in a buffer. The final frame
 * may be torn (a crash tail); complete frames only are returned, mirroring
 * the harness backend's committed-prefix semantics.
 * @param {Buffer} buffer - the complete artifact bytes.
 * @returns {{ frames: Array<{ start: number, end: number }>, torn: boolean }}
 *   complete frame ranges plus whether a torn final frame was detected.
 */
export function scanFrames(buffer) {
  const frames = []
  let offset = 0
  let torn = false
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) { torn = true; break }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) { torn = true; break }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) { torn = true; break }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) { torn = true; break }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) { torn = true; break }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (torn) break
    if (checksum) {
      if (buffer.length - offset < 4) { torn = true; break }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, torn }
}

/**
 * Decode the complete frames of one artifact into its JSONL text. A torn
 * final frame is dropped (its partial records are not durable commits).
 * @param {Buffer} buffer - the artifact bytes.
 * @returns {string} the concatenated plaintext of the complete frames.
 */
export function decodeFrames(buffer) {
  const { frames, torn } = scanFrames(buffer)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  const parts = []
  for (const frame of frames) {
    parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
  }
  const text = Buffer.concat(parts).toString('utf8')
  if (!torn) return text
  // The harness keeps only the committed prefix too; a trailing newline torn
  // mid-record is simply absent, which the reader also tolerates.
  return text
}

/**
 * Rewrite one line of the JSONL text when it is a `feishu/image` event
 * envelope missing the `ignorable` marker. Other lines pass through
 * byte-for-byte (packed chunk rows, header, key order preserved).
 * @param {string} text - the JSONL artifact text.
 * @returns {{ text: string, patched: number }} the rewritten text and the
 *   number of envelopes patched (0 when nothing changed).
 */
export function markForeignEventsIgnorable(text) {
  const lines = text.split('\n')
  let patched = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue // non-JSON or partial line: leave untouched
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) continue
    if (event.type !== FOREIGN_EVENT_TYPE || event.ignorable === true) continue
    lines[index] = JSON.stringify({ ...event, ignorable: true })
    patched += 1
  }
  return { text: lines.join('\n'), patched }
}

/**
 * Encode repaired JSONL text back into the backend's frame layout: the first
 * frame holds EXACTLY the header line (the backend's `readZstdPrefix` requires
 * the first frame to be one header line), the second frame the event lines.
 * @param {string} text - the repaired JSONL text (header line first).
 * @returns {Buffer} the complete artifact bytes.
 */
export function encodeRepaired(text) {
  const nl = text.indexOf('\n')
  const header = nl === -1 ? text : text.slice(0, nl + 1)
  const rest = nl === -1 ? '' : text.slice(nl + 1)
  const frames = [zstdCompressSync(Buffer.from(header, 'utf8'), CHECKSUM_OPTIONS)]
  if (rest !== '') frames.push(zstdCompressSync(Buffer.from(rest, 'utf8'), CHECKSUM_OPTIONS))
  return Buffer.concat(frames)
}

/**
 * Repair one session log file in place. The caller guarantees the session is
 * not live (no backend writer); this function additionally requires the file
 * to be byte-stable across read and write (three fingerprints compared) and
 * publishes through a temp file + rename. A log already carrying the marker
 * on every foreign event is left untouched.
 * @param {string} path - the `session.jsonl.zstd` artifact path.
 * @returns {{ patched: number } | { skipped: string }} outcome; `skipped` is
 *   a human-readable reason when the file was not rewritten.
 */
export function repairLogFile(path) {
  const beforeRead = fileFingerprint(path)
  const buffer = readFileSync(path)
  const afterRead = fileFingerprint(path)
  if (beforeRead !== afterRead) return { skipped: 'file changed while reading' }

  const text = decodeFrames(buffer)
  const { text: repaired, patched } = markForeignEventsIgnorable(text)
  if (patched === 0) return { patched: 0 }

  const beforeWrite = fileFingerprint(path)
  if (beforeWrite !== afterRead) return { skipped: 'file changed before write' }

  const encoded = encodeRepaired(repaired)
  const tmp = `${path}.${process.pid}.repair.tmp`
  writeFileSync(tmp, encoded)
  renameSync(tmp, path)
  return { patched }
}

/**
 * Find the artifact path for a session id across every project directory
 * under the harness sessions root.
 * @param {string} sessionsRoot - `$DSH_HOME/sessions`.
 * @param {string} sessionId - the session to locate.
 * @returns {string | undefined} the artifact path, when present.
 */
export function findLogFile(sessionsRoot, sessionId) {
  let projects
  try {
    projects = readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const path = join(sessionsRoot, project.name, sessionId, 'session.jsonl.zstd')
    try {
      if (statSync(path).isFile()) return path
    } catch {
      // not this project's session
    }
  }
  return undefined
}

/**
 * Repair every foreign event in one session's log. Non-live guarantee is the
 * caller's contract; a missing artifact or a repair that cannot run safely is
 * reported, never thrown.
 * @param {string} sessionsRoot - `$DSH_HOME/sessions`.
 * @param {string} sessionId - the session to repair.
 * @returns {{ ok: boolean, detail: string }} result summary.
 */
export function repairSessionLog(sessionsRoot, sessionId) {
  const path = findLogFile(sessionsRoot, sessionId)
  if (path === undefined) return { ok: true, detail: 'no log artifact' }
  try {
    const outcome = repairLogFile(path)
    if ('skipped' in outcome) return { ok: false, detail: outcome.skipped }
    return { ok: true, detail: `patched ${outcome.patched} event(s)` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Collect every `feishu/image` event of one session plus its header `cwd`,
 * so the plugin can re-index the staged image files (the events reference
 * files that the bindings store may have evicted from its index).
 * @param {string} sessionsRoot - `$DSH_HOME/sessions`.
 * @param {string} sessionId - the session to read.
 * @returns {{ cwd: string | undefined, events: Array<{ name: string, mediaType?: string, bytes?: number, fileName?: string }> }}
 *   the header cwd (when the log has one) and the foreign image events.
 */
export function collectForeignEvents(sessionsRoot, sessionId) {
  const path = findLogFile(sessionsRoot, sessionId)
  if (path === undefined) return { cwd: undefined, events: [] }
  let text
  try {
    text = decodeFrames(readFileSync(path))
  } catch {
    return { cwd: undefined, events: [] }
  }
  /** @type {string | undefined} */
  let cwd
  /** @type {Array<{ name: string, mediaType?: string, bytes?: number, fileName?: string }>} */
  const events = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    if (record.type === 'session' && typeof record.cwd === 'string') {
      cwd = record.cwd
      continue
    }
    if (record.type !== FOREIGN_EVENT_TYPE) continue
    const data = record.data
    if (data === null || typeof data !== 'object' || typeof data.name !== 'string' || data.name === '') continue
    events.push({
      name: data.name,
      ...(typeof data.mediaType === 'string' && data.mediaType !== '' ? { mediaType: data.mediaType } : {}),
      ...(typeof data.bytes === 'number' && Number.isFinite(data.bytes) && data.bytes > 0 ? { bytes: data.bytes } : {}),
      ...(typeof data.fileName === 'string' && data.fileName !== '' ? { fileName: data.fileName } : {}),
    })
  }
  return { cwd, events }
}
