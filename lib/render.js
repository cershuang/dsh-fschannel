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

/** Fence markers for code blocks (built without backtick literals). */
const BACKTICK = String.fromCharCode(96)
const FENCE_OPEN = BACKTICK.repeat(3)

/** Max chars per markdown element (Feishu rejects oversized elements). */
const MARKDOWN_MAX_CHARS = 30000
/** Max tables per card (platform limit: 5). */
const TABLE_MAX = 5
/** Max table columns (platform limit: 50). */
const TABLE_MAX_COLUMNS = 20
/** Table rows per page (platform max: 10). */
const TABLE_PAGE_SIZE = 10

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
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // Fenced code block (``` or ~~~).
    if (line.startsWith(FENCE_OPEN) || line.startsWith('~~~')) {
      const marker = line.startsWith(FENCE_OPEN) ? FENCE_OPEN : '~~~'
      const close = new RegExp('^\\s*' + marker + '\\s*$')
      const block = [line]
      i += 1
      while (i < lines.length && !close.test(lines[i])) {
        block.push(lines[i])
        i += 1
      }
      if (i < lines.length) { block.push(lines[i]); i += 1 }
      flushProse()
      segments.push({ kind: 'code', text: block.join('\n') })
      continue
    }
    // GFM table: a header row followed by a separator row.
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
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
    if (cells.length === 0) continue
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
      if (table !== undefined && table.rows.length > 0) {
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
      elements: [{ tag: 'markdown', content: (text ?? '').slice(0, MARKDOWN_MAX_CHARS * 2) }],
    },
  }
}
