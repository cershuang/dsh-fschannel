// @ts-check
/**
 * Final-result card renderer: turns the settled assistant markdown text into a
 * structured static card (channel.updateCard) with clean typography -
 * prose in markdown elements, GFM tables as card v2 table elements, code
 * blocks kept as markdown fences (the platform renders them natively). The
 * caller falls back to a plain markdown card when the platform rejects the
 * structured card.
 * @module dsh-fschannel/render
 */

/** Fence marker for code blocks (built without a backtick literal). */
const BACKTICK = String.fromCharCode(96)

/** Max chars per markdown element (Feishu rejects oversized elements). */
const MARKDOWN_MAX_CHARS = 30000
/** Max tables per card (platform limit: 5). */
const TABLE_MAX = 5
/** Max table columns (platform limit: 50). */
const TABLE_MAX_COLUMNS = 20
/** Table rows per page (platform max: 10). */
const TABLE_PAGE_SIZE = 10
/**
 * Beyond this a table is rendered as markdown instead of a card table.
 *
 * TABLE_PAGE_SIZE only PAGINATES — a 5000-row table still shipped all 5000
 * rows, producing a single ~138 KB card element that Feishu then rejects, so
 * the whole answer fell back to renderPlainCard. Degrading just the oversized
 * table keeps every row (as markdown pipes) and keeps the rest of the card.
 * 200 rows is 20 pages at the platform page size — far past what anyone pages
 * through in a chat — and the byte cap catches wide tables that stay under it.
 */
const TABLE_MAX_ROWS = 200
const TABLE_MAX_BYTES = 60000

/**
 * The fence a line opens, when it opens one.
 * @param {string} line
 * @returns {{ marker: string, length: number } | undefined}
 */
function fenceRun(line) {
  const trimmed = line.trimStart()
  for (const marker of [BACKTICK, '~']) {
    let length = 0
    while (trimmed[length] === marker) length += 1
    if (length >= 3) return { marker, length }
  }
  return undefined
}

/**
 * Whether a line closes an open fence: same character, at least as long, and
 * no info string (CommonMark forbids one on a closing fence — which is what
 * keeps a ```js line INSIDE a ```md block from closing it).
 * @param {string} line
 * @param {{ marker: string, length: number }} open
 * @returns {boolean}
 */
function closesFence(line, open) {
  const run = fenceRun(line)
  if (run === undefined || run.marker !== open.marker || run.length < open.length) return false
  return line.trim() === open.marker.repeat(run.length)
}

/**
 * Split text into top-level segments, preserving order:
 * fenced code blocks, GFM tables, and plain prose runs.
 * @param {string} text - the settled markdown.
 * @returns {Array<{ kind: 'code' | 'table' | 'prose', text: string }>}
 */
export function splitSegments(text) {
  const segments = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let prose = []
  const flushProse = () => {
    const joined = prose.join('\n').trim()
    prose = []
    if (joined !== '') segments.push({ kind: 'prose', text: joined })
  }
  // Indented code regions — a fence inside a list item, or a 4-space indented
  // block — are deliberately NOT emitted as segments: Feishu renders them
  // correctly inside the surrounding prose, and splitting them out would tear a
  // list into several card elements. They only need to suppress table
  // detection, because parseTable trims before testing and would otherwise
  // promote a table written INSIDE a code block into a live card table,
  // shattering the block and leaving its fence markers bare on screen.
  /** @type {string | undefined} the marker that opened an indented fence. */
  let indentedFence
  const indentedCodeAt = (index) => {
    const raw = lines[index]
    if (!raw.startsWith('    ')) return false
    // A 4-space indent only opens a code block after a blank line; inside a
    // paragraph it is a continuation, and inside a list it is nesting.
    for (let back = index - 1; back >= 0; back -= 1) {
      const previous = lines[back]
      if (previous.trim() === '') return true
      if (!previous.startsWith('    ')) return false
    }
    return true
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = fenceRun(line)
    // Fenced code block (``` or ~~~) at the start of the line.
    if (fence !== undefined && indentedFence === undefined && !line.startsWith(' ')) {
      const block = [line]
      i += 1
      // CommonMark: the closer must be the same character and AT LEAST as long
      // as the opener, and may not carry an info string. Hard-coding length 3
      // broke both directions — a ```` block was cut short by an inner ```,
      // and a ``` block was never closed by a ```` and swallowed the rest.
      while (i < lines.length && !closesFence(lines[i], fence)) {
        block.push(lines[i])
        i += 1
      }
      if (i < lines.length) { block.push(lines[i]); i += 1 }
      flushProse()
      segments.push({ kind: 'code', text: block.join('\n') })
      continue
    }
    // An indented fence opens or closes a suppression region without becoming
    // a segment of its own.
    if (fence !== undefined && line.startsWith(' ')) {
      if (indentedFence === undefined) indentedFence = fence.marker.repeat(fence.length)
      else if (closesFence(line, fence)) indentedFence = undefined
      prose.push(line)
      i += 1
      continue
    }
    // GFM table: a header row followed by a separator row.
    if (indentedFence === undefined && !indentedCodeAt(i)
      && line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const block = [line, lines[i + 1]]
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        block.push(lines[i])
        i += 1
      }
      flushProse()
      segments.push({ kind: 'table', text: block.join('\n') })
      continue
    }
    prose.push(line)
    i += 1
  }
  flushProse()
  return segments
}

/**
 * Split a GFM table line into cells, honoring escaped pipes.
 * @param {string} line
 * @returns {string[]}
 */
function splitCells(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let current = ''
  let escaped = false
  for (const ch of trimmed) {
    if (ch === '\\' && !escaped) { escaped = true; continue }
    if (escaped) {
      // Consume the escape: \| and \\ are literal, anything else keeps the backslash.
      current += (ch === '|' || ch === '\\') ? ch : '\\' + ch
      escaped = false
      continue
    }
    if (ch === '|') { cells.push(current.trim()); current = ''; continue }
    current += ch
  }
  if (escaped) current += '\\'
  cells.push(current.trim())
  return cells
}

/**
 * Parse a GFM table block into columns/rows for the card v2 table element.
 * @param {string} block - the table lines.
 * @returns {{ columns: object[], rows: object[] } | undefined}
 */
export function parseTable(block) {
  const lines = block.split('\n').filter((l) => l.trim() !== '')
  if (lines.length < 2) return undefined
  const headers = splitCells(lines[0])
  if (headers.length === 0) return undefined
  const dataLines = lines.slice(2)
  const columns = headers.slice(0, TABLE_MAX_COLUMNS).map((header, index) => ({
    name: 'c' + index,
    display_name: header.replace(/[*_`~]/g, '').trim(),
    width: 'auto',
    data_type: 'lark_md',
    horizontal_align: 'left',
  }))
  const rows = []
  for (const line of dataLines) {
    const cells = splitCells(line)
    const row = {}
    for (let index = 0; index < columns.length; index += 1) {
      row[columns[index].name] = (cells[index] ?? '').trim()
    }
    rows.push(row)
  }
  return { columns, rows }
}

/**
 * Build a structured final card from the settled text.
 * @param {string} text - the final assistant markdown.
 * @returns {object | undefined} the card JSON, or undefined for empty text.
 */
export function renderFinalCard(text) {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return undefined
  const elements = []
  let tables = 0
  for (const segment of splitSegments(trimmed)) {
    if (segment.kind === 'table' && tables < TABLE_MAX) {
      const table = parseTable(segment.text)
      // An oversized table degrades to markdown rather than being truncated:
      // no row is lost, it just stops being interactive.
      const oversized = table !== undefined
        && (table.rows.length > TABLE_MAX_ROWS || JSON.stringify(table.rows).length > TABLE_MAX_BYTES)
      if (table !== undefined && table.rows.length > 0 && !oversized) {
        elements.push({
          tag: 'table',
          element_id: 't' + tables,
          page_size: TABLE_PAGE_SIZE,
          row_height: 'low',
          columns: table.columns,
          rows: table.rows,
        })
        tables += 1
        continue
      }
    }
    // Prose, code fences, or tables beyond the cap: keep as markdown.
    for (let offset = 0; offset < segment.text.length; offset += MARKDOWN_MAX_CHARS) {
      elements.push({
        tag: 'markdown',
        content: segment.text.slice(offset, offset + MARKDOWN_MAX_CHARS),
      })
    }
  }
  if (elements.length === 0) return undefined
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  }
}

/**
 * Minimal fallback card: the raw text in one markdown element.
 * @param {string} text
 * @returns {object}
 */
export function renderPlainCard(text) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      // The limit this module declares, not double it. This is the last resort
      // after a structured card was already rejected — the one path that can
      // least afford to be oversized.
      elements: [{ tag: 'markdown', content: (text ?? '').slice(0, MARKDOWN_MAX_CHARS) }],
    },
  }
}
